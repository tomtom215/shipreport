import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { graphql } from "@octokit/graphql";
import type { Cache } from "./cache.js";

const ShipOctokit = Octokit.plugin(retry, throttling);

export interface GithubClient {
  rest: Octokit;
  graphql: typeof graphql;
  baseUrl: string;
}

export interface GithubOptions {
  token: string;
  baseUrl: string;
  graphqlUrl: string;
  userAgent?: string;
  log?: (msg: string) => void;
  cache?: Cache;
}

export function makeClient(opts: GithubOptions): GithubClient {
  const log = opts.log ?? (() => {});
  const rest = new ShipOctokit({
    auth: opts.token,
    baseUrl: opts.baseUrl,
    userAgent: opts.userAgent ?? "shipreport/0.2",
    throttle: {
      onRateLimit: (retryAfter: number, info, _oct, retryCount: number) => {
        log(`rate limit hit on ${info.method} ${info.url}; sleeping ${retryAfter}s`);
        return retryCount < 3;
      },
      onSecondaryRateLimit: (retryAfter: number, info, _oct, retryCount: number) => {
        log(`secondary rate limit on ${info.method} ${info.url}; sleeping ${retryAfter}s`);
        return retryCount < 3;
      },
    },
    retry: { doNotRetry: ["400", "401", "403", "404", "422"] },
  });

  const gql = graphql.defaults({
    baseUrl: opts.graphqlUrl.replace(/\/graphql$/, ""),
    headers: {
      authorization: `token ${opts.token}`,
      "user-agent": opts.userAgent ?? "shipreport/0.2",
    },
  });

  return { rest, graphql: gql, baseUrl: opts.baseUrl };
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
