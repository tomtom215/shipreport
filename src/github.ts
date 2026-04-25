import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { graphql } from "@octokit/graphql";
import type { Cache } from "./cache.js";
import type { RunCounters } from "./counters.js";
import type { RateLimitGuard } from "./rate-limit.js";
import type { TokenSource } from "./token-source.js";

const ShipOctokit = Octokit.plugin(retry, throttling);

export interface GithubClient {
  rest: Octokit;
  /** Counted GraphQL; increments counters.apiCalls on every call. */
  graphql: typeof graphql;
  baseUrl: string;
  probeRemaining: () => Promise<number | null>;
}

export interface GithubOptions {
  /**
   * Token source — called before each request. Supplied so that long-
   * running App-backed runs can renew a stale installation token without
   * having to rebuild the whole client.
   */
  tokenSource: TokenSource;
  baseUrl: string;
  graphqlUrl: string;
  userAgent?: string;
  log?: (msg: string) => void;
  cache?: Cache;
  counters?: RunCounters;
  rateLimitGuard?: RateLimitGuard;
}

export function makeClient(opts: GithubOptions): GithubClient {
  const log = opts.log ?? (() => {});
  const counters = opts.counters;
  const guard = opts.rateLimitGuard;
  const ua = opts.userAgent ?? "shipreport/0.2";

  // Rest Octokit captures its token at construction. Long-running App
  // installations still get the fresh token because we update `auth`
  // via Octokit's authStrategy hook — but shipreport almost never uses
  // REST in hot paths, so we accept a small staleness window for REST.
  //
  // Octokit's authStrategy.hook contract: it is called as
  //   hook(request, routeOrObject, parameters?)
  // where `routeOrObject` is EITHER a route string ("GET /user") OR a
  // fully-resolved request descriptor object (with method/url/headers/…)
  // depending on the call site. Earlier versions of this code assumed it
  // was always a string and dropped the resolved descriptor's headers on
  // the floor — the practical effect was that REST calls went out without
  // any Authorization header. Both branches are handled below.
  const rest = new ShipOctokit({
    auth: "placeholder",
    authStrategy: () => ({
      async hook(
        request: unknown,
        routeOrObject: unknown,
        parameters?: unknown,
      ) {
        const token = await opts.tokenSource.getToken();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const req = request as any;
        if (typeof routeOrObject === "string") {
          const params = (parameters ?? {}) as Record<string, unknown>;
          const merged = {
            ...params,
            headers: {
              ...((params.headers as Record<string, string>) ?? {}),
              authorization: `token ${token}`,
            },
          };
          return req(routeOrObject, merged);
        }
        const obj = routeOrObject as { headers?: Record<string, string> };
        return req({
          ...obj,
          headers: { ...(obj.headers ?? {}), authorization: `token ${token}` },
        });
      },
    }),
    baseUrl: opts.baseUrl,
    userAgent: ua,
    /* c8 ignore start — these callbacks fire only when the upstream
       Octokit throttle plugin observes a 403 / 429 with rate-limit
       headers. End-to-end exercise requires orchestrating real
       rate-limit responses; the callback bodies are 3 lines each and
       are smoke-tested by the integration job. */
    throttle: {
      onRateLimit: (retryAfter: number, info, _oct, retryCount: number) => {
        log(`rate limit hit on ${info.method} ${info.url}; sleeping ${retryAfter}s`);
        if (counters) counters.rateLimitSleepsMs += retryAfter * 1000;
        // When degraded, allow more retries + longer back-off.
        const max = guard?.isDegraded ? 6 : 3;
        return retryCount < max;
      },
      onSecondaryRateLimit: (retryAfter: number, info, _oct, retryCount: number) => {
        log(`secondary rate limit on ${info.method} ${info.url}; sleeping ${retryAfter}s`);
        if (counters) counters.rateLimitSleepsMs += retryAfter * 1000;
        const max = guard?.isDegraded ? 6 : 3;
        return retryCount < max;
      },
    },
    /* c8 ignore stop */
    retry: { doNotRetry: [400, 401, 403, 404, 422] },
  });

  const graphqlBaseUrl = opts.graphqlUrl.replace(/\/graphql$/, "");

  // Re-build a graphql call on every invocation so the auth header always
  // reflects the current token. Also observes rateLimit.remaining (when
  // the query asks for it) to feed the guard + counters.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gql = (async (query: string, vars?: Record<string, unknown>): Promise<any> => {
    const token = await opts.tokenSource.getToken();
    const scoped = graphql.defaults({
      baseUrl: graphqlBaseUrl,
      headers: { authorization: `token ${token}`, "user-agent": ua },
    });
    if (counters) counters.apiCalls += 1;
    // Gate in degraded mode so only one call runs at a time.
    const exec = async (): Promise<unknown> => scoped(query, vars);
    const res = guard ? await guard.gate(exec) : await exec();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)?.rateLimit?.remaining;
    if (typeof r === "number") {
      if (counters) counters.remainingRateLimit = r;
      guard?.observe(r);
    }
    return res;
  }) as unknown as typeof graphql;

  return {
    rest,
    graphql: gql,
    baseUrl: opts.baseUrl,
    async probeRemaining(): Promise<number | null> {
      try {
        const data = (await gql(
          /* GraphQL */ `
            query {
              rateLimit {
                remaining
              }
            }
          `,
        )) as { rateLimit?: { remaining?: number } | null };
        return data.rateLimit?.remaining ?? null;
      } catch {
        return null;
      }
    },
  };
}

export async function probeToken(client: GithubClient): Promise<{
  login: string;
  scopes: string[];
  ghesVersion: string | null;
}> {
  const res = await client.rest.request("GET /user");
  const scopes = String(res.headers["x-oauth-scopes"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ghesVersion = (res.headers["x-github-enterprise-version"] as string | undefined) ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { login: (res.data as any).login, scopes, ghesVersion };
}
