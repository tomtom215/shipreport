import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { graphql } from "@octokit/graphql";
import type { Cache } from "./cache.js";
import type { RunCounters } from "./counters.js";

const ShipOctokit = Octokit.plugin(retry, throttling);

export interface GithubClient {
  rest: Octokit;
  /** Counted GraphQL; increments counters.apiCalls on every call. */
  graphql: typeof graphql;
  baseUrl: string;
  /**
   * Fire a small GraphQL query to capture rateLimit.remaining. Cheap and
   * opt-in: called once at end-of-run so the audit payload has an exact
   * post-run quota reading.
   */
  probeRemaining: () => Promise<number | null>;
}

export interface GithubOptions {
  token: string;
  baseUrl: string;
  graphqlUrl: string;
  userAgent?: string;
  log?: (msg: string) => void;
  cache?: Cache;
  counters?: RunCounters;
}

export function makeClient(opts: GithubOptions): GithubClient {
  const log = opts.log ?? (() => {});
  const counters = opts.counters;
  const rest = new ShipOctokit({
    auth: opts.token,
    baseUrl: opts.baseUrl,
    userAgent: opts.userAgent ?? "shipreport/0.2",
    throttle: {
      onRateLimit: (retryAfter: number, info, _oct, retryCount: number) => {
        log(`rate limit hit on ${info.method} ${info.url}; sleeping ${retryAfter}s`);
        if (counters) counters.rateLimitSleepsMs += retryAfter * 1000;
        return retryCount < 3;
      },
      onSecondaryRateLimit: (retryAfter: number, info, _oct, retryCount: number) => {
        log(`secondary rate limit on ${info.method} ${info.url}; sleeping ${retryAfter}s`);
        if (counters) counters.rateLimitSleepsMs += retryAfter * 1000;
        return retryCount < 3;
      },
    },
    retry: { doNotRetry: ["400", "401", "403", "404", "422"] },
  });

  const rawGql = graphql.defaults({
    baseUrl: opts.graphqlUrl.replace(/\/graphql$/, ""),
    headers: {
      authorization: `token ${opts.token}`,
      "user-agent": opts.userAgent ?? "shipreport/0.2",
    },
  });

  // Lightweight wrapper so we can audit call count without dragging counters
  // into every callsite. Signature preserved so existing callers compile.
  const gql = ((query: string, vars?: Record<string, unknown>) => {
    if (counters) counters.apiCalls += 1;
    return rawGql(query, vars);
  }) as unknown as typeof graphql;

  return {
    rest,
    graphql: gql,
    baseUrl: opts.baseUrl,
    async probeRemaining(): Promise<number | null> {
      try {
        const data = (await rawGql(
          /* GraphQL */ `
            query {
              rateLimit {
                remaining
              }
            }
          `,
        )) as { rateLimit?: { remaining?: number } | null };
        if (counters) counters.apiCalls += 1;
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
