/**
 * Nock-driven tests for src/github.ts — the previously-uncovered Octokit
 * transport layer. We exercise:
 *
 *   1. probeToken happy path (REST /user with scopes + GHES version header).
 *   2. makeClient.graphql happy path: token resolution, counters tick,
 *      rateLimit.remaining observation, RateLimitGuard.observe wiring.
 *   3. Rate-limit-degrade trigger: a low rateLimit.remaining flips the
 *      guard via observe, and onDegrade fires exactly once.
 *   4. probeRemaining swallows network errors and returns null (defensive
 *      behavior shipreport relies on for `audit.run_completed` payloads).
 *
 * No real network. nock intercepts Octokit + graphql at the http layer;
 * tokens are produced by an in-memory TokenSource that records calls.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { makeClient, probeToken } from "../src/github.js";
import { createCounters } from "../src/counters.js";
import { RateLimitGuard } from "../src/rate-limit.js";
import type { TokenSource } from "../src/token-source.js";

const API = "https://api.github.com";
const GHES_API = "https://ghe.example.com/api/v3";
const GRAPHQL = "https://api.github.com";

beforeEach(() => {
  nock.disableNetConnect();
});
afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

function patSource(envName: string, token: string): TokenSource & { calls: number } {
  let calls = 0;
  const src = {
    kind: "pat" as const,
    identity: `pat:env:${envName}`,
    async getToken(): Promise<string> {
      calls += 1;
      return token;
    },
    renewalCount: () => 0,
    get calls(): number {
      return calls;
    },
  };
  return src as unknown as TokenSource & { calls: number };
}

describe("probeToken", () => {
  it("returns login + parsed scopes + GHES version header", async () => {
    nock(API)
      .get("/user")
      .reply(
        200,
        { login: "alice" },
        {
          "x-oauth-scopes": "repo, read:org, public_repo",
          "x-github-enterprise-version": "3.13.0",
        },
      );

    const client = makeClient({
      tokenSource: patSource("SHIPREPORT_GITHUB_TOKEN", "ghp_test"),
      baseUrl: API,
      graphqlUrl: `${API}/graphql`,
    });
    const info = await probeToken(client);
    expect(info.login).toBe("alice");
    expect(info.scopes).toEqual(["repo", "read:org", "public_repo"]);
    expect(info.ghesVersion).toBe("3.13.0");
  });

  it("returns null for ghesVersion when the header is absent (github.com)", async () => {
    nock(API).get("/user").reply(200, { login: "bob" }, { "x-oauth-scopes": "" });
    const client = makeClient({
      tokenSource: patSource("X", "tok"),
      baseUrl: API,
      graphqlUrl: `${API}/graphql`,
    });
    const info = await probeToken(client);
    expect(info.login).toBe("bob");
    expect(info.scopes).toEqual([]);
    expect(info.ghesVersion).toBeNull();
  });

  it("works against GHES (custom baseUrl)", async () => {
    nock(GHES_API)
      .get("/user")
      .reply(200, { login: "carol" }, {
        "x-github-enterprise-version": "3.10.5",
      });
    const client = makeClient({
      tokenSource: patSource("X", "tok"),
      baseUrl: GHES_API,
      graphqlUrl: "https://ghe.example.com/api/graphql",
    });
    const info = await probeToken(client);
    expect(info.ghesVersion).toBe("3.10.5");
  });
});

describe("makeClient.graphql", () => {
  it("calls the token source on every request and increments counters.apiCalls", async () => {
    const tok = patSource("X", "ghp_a");
    nock(GRAPHQL)
      .post("/graphql")
      .twice()
      .reply(200, { data: { rateLimit: { remaining: 4999 }, viewer: { login: "x" } } });

    const counters = createCounters();
    const client = makeClient({
      tokenSource: tok,
      baseUrl: API,
      graphqlUrl: `${API}/graphql`,
      counters,
    });
    await client.graphql(`query { viewer { login } }`);
    await client.graphql(`query { viewer { login } }`);
    expect(counters.apiCalls).toBe(2);
    // Token resolved per request — confirms the long-running App-renewal
    // contract holds at the client level.
    expect((tok as unknown as { calls: number }).calls).toBeGreaterThanOrEqual(2);
  });

  it("threads rateLimit.remaining into counters and the RateLimitGuard", async () => {
    nock(GRAPHQL)
      .post("/graphql")
      .reply(200, { data: { rateLimit: { remaining: 4500 } } });

    const counters = createCounters();
    let observed: number | null = null;
    const guard = new RateLimitGuard({
      threshold: 100,
      onDegrade: (r) => {
        observed = r;
      },
    });
    const client = makeClient({
      tokenSource: patSource("X", "tok"),
      baseUrl: API,
      graphqlUrl: `${API}/graphql`,
      counters,
      rateLimitGuard: guard,
    });
    await client.graphql(`query { rateLimit { remaining } }`);

    expect(counters.remainingRateLimit).toBe(4500);
    // 4500 > threshold(100) → not degraded yet, observe was a no-op for
    // the onDegrade callback.
    expect(observed).toBeNull();
    expect(guard.isDegraded).toBe(false);
  });

  it("triggers onDegrade exactly once when remaining drops below threshold", async () => {
    nock(GRAPHQL)
      .post("/graphql")
      .reply(200, { data: { rateLimit: { remaining: 50 } } });
    nock(GRAPHQL)
      .post("/graphql")
      .reply(200, { data: { rateLimit: { remaining: 25 } } });

    let degradeCount = 0;
    const guard = new RateLimitGuard({
      threshold: 100,
      onDegrade: () => {
        degradeCount += 1;
      },
    });
    const client = makeClient({
      tokenSource: patSource("X", "tok"),
      baseUrl: API,
      graphqlUrl: `${API}/graphql`,
      rateLimitGuard: guard,
    });

    await client.graphql(`query { rateLimit { remaining } }`);
    await client.graphql(`query { rateLimit { remaining } }`);
    expect(degradeCount).toBe(1);
    expect(guard.isDegraded).toBe(true);
  });

  it("probeRemaining returns the remaining count from a rateLimit query", async () => {
    nock(GRAPHQL)
      .post("/graphql")
      .reply(200, { data: { rateLimit: { remaining: 4321 } } });
    const client = makeClient({
      tokenSource: patSource("X", "tok"),
      baseUrl: API,
      graphqlUrl: `${API}/graphql`,
    });
    expect(await client.probeRemaining()).toBe(4321);
  });

  it("probeRemaining swallows graphql errors and returns null (used in counters at end-of-run)", async () => {
    nock(GRAPHQL).post("/graphql").reply(500, { message: "oops" });
    const client = makeClient({
      tokenSource: patSource("X", "tok"),
      baseUrl: API,
      graphqlUrl: `${API}/graphql`,
    });
    expect(await client.probeRemaining()).toBeNull();
  });

  it("probeRemaining returns null when the response has no rateLimit", async () => {
    nock(GRAPHQL).post("/graphql").reply(200, { data: { rateLimit: null } });
    const client = makeClient({
      tokenSource: patSource("X", "tok"),
      baseUrl: API,
      graphqlUrl: `${API}/graphql`,
    });
    expect(await client.probeRemaining()).toBeNull();
  });
});

describe("makeClient REST authStrategy hook", () => {
  it("attaches the token from the token source on every REST call", async () => {
    // Capture headers via the synthetic-request body callback. nock's
    // `function(this)` exposes `this.req.headers` (lowercase keys) which
    // is the only place the resolved auth header lives at the wire level.
    const seen: { auth?: string } = {};
    nock(API)
      .get("/user")
      .reply(function () {
        // The auth strategy puts the token under `authorization`. Octokit
        // may also re-cast it; we accept either casing for robustness.
        const h = this.req.headers as Record<string, string | string[]>;
        const v = h["authorization"] ?? h["Authorization"];
        seen.auth = Array.isArray(v) ? v[0] : v;
        return [200, { login: "alice" }, { "x-oauth-scopes": "" }];
      });

    const client = makeClient({
      tokenSource: patSource("SHIPREPORT_GITHUB_TOKEN", "ghp_secret_value"),
      baseUrl: API,
      graphqlUrl: `${API}/graphql`,
    });
    const info = await probeToken(client);
    expect(info.login).toBe("alice");
    // The shipreport hook adds `Authorization: token <bearer>`. Some
    // Octokit versions normalize to `Bearer`; allow both forms — what
    // matters is that the secret value reached the wire.
    expect(seen.auth ?? "").toMatch(/ghp_secret_value/);
  });
});
