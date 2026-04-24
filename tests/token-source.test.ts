import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize } from "../src/config.js";
import {
  createAppTokenSource,
  createPatTokenSource,
  DEFAULT_RENEW_AFTER_MS,
  tokenSourceFromConfig,
} from "../src/token-source.js";

const ORIGINAL_ENV = { ...process.env };

function rsaKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

// Intercept @octokit/auth-app's network call so we don't actually mint a
// real token. The real factory is { appId, privateKey } → fn({type}) returning
// {token}. We swap the module's factory via vi.mock.
vi.mock("@octokit/auth-app", () => ({
  createAppAuth: ({ appId }: { appId: number }) => {
    let counter = 0;
    return async ({ type, installationId }: { type: string; installationId?: number }) => {
      counter += 1;
      return {
        token: `fake-${type}-${appId}-${installationId ?? "none"}-${counter}`,
      };
    };
  },
}));

describe("PAT token source", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("reads the token from the env var; identity is the env-var name, never the secret", async () => {
    process.env.SHIPREPORT_TEST_PAT = "ghp_abc";
    const src = createPatTokenSource("SHIPREPORT_TEST_PAT");
    expect(src.kind).toBe("pat");
    expect(src.identity).toBe("pat:env:SHIPREPORT_TEST_PAT");
    expect(await src.getToken()).toBe("ghp_abc");
    // Repeated calls return the same token; no renewal.
    expect(await src.getToken()).toBe("ghp_abc");
    expect(src.renewalCount()).toBe(0);
  });

  it("throws with a helpful error when env var is unset", () => {
    delete process.env.SHIPREPORT_TEST_MISSING;
    expect(() => createPatTokenSource("SHIPREPORT_TEST_MISSING")).toThrow(
      /SHIPREPORT_TEST_MISSING/,
    );
  });
});

describe("App token source — clock-mocked renewal", () => {
  let now = 0;
  const nowMs = (): number => now;
  const privateKeyPem = rsaKeyPem();

  beforeEach(() => {
    now = 1_700_000_000_000;
  });

  it("mints on first call, reuses within window, renews past threshold", async () => {
    const src = createAppTokenSource({
      appId: 42,
      privateKeyPem,
      installationId: 7,
      nowMs,
      renewAfterMs: DEFAULT_RENEW_AFTER_MS,
    });
    const t0 = await src.getToken();
    expect(t0).toMatch(/^fake-installation-42-7-/);
    expect(src.renewalCount()).toBe(0);

    // 30 min later: same token, still within the 50-min window.
    now += 30 * 60 * 1000;
    expect(await src.getToken()).toBe(t0);
    expect(src.renewalCount()).toBe(0);

    // 51 min later: renewal triggers; new token surfaces.
    now += 21 * 60 * 1000;
    const t1 = await src.getToken();
    expect(t1).not.toBe(t0);
    expect(src.renewalCount()).toBe(1);
  });

  it("renewal happens exactly at the configured threshold, not before", async () => {
    const src = createAppTokenSource({
      appId: 1,
      privateKeyPem,
      installationId: 2,
      nowMs,
      renewAfterMs: 1000, // 1 s
    });
    const t0 = await src.getToken();
    now += 999;
    expect(await src.getToken()).toBe(t0); // just under → no renewal
    now += 1; // exactly 1 000 ms after mint → renew
    const t1 = await src.getToken();
    expect(t1).not.toBe(t0);
    expect(src.renewalCount()).toBe(1);
  });

  it("identity does not include any token material", async () => {
    const src = createAppTokenSource({
      appId: 9,
      privateKeyPem,
      installationId: 99,
      nowMs,
    });
    expect(src.identity).toBe("app:9:install:99");
    const token = await src.getToken();
    expect(src.identity).not.toContain(token);
  });
});

describe("tokenSourceFromConfig", () => {
  const privateKeyPem = rsaKeyPem();

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("dispatches to PAT source when github.app is unset", async () => {
    process.env.SHIPREPORT_FROM_CFG = "ghp_xxx";
    const cfg = normalize({
      github: { tokenEnv: "SHIPREPORT_FROM_CFG" },
      org: "o",
      teams: [{ name: "t", manager: "a", members: ["a"], repos: ["o/r"] }],
      defaults: { quarter: "2026Q1" },
    });
    const src = await tokenSourceFromConfig(cfg);
    expect(src.kind).toBe("pat");
    expect(src.identity).toBe("pat:env:SHIPREPORT_FROM_CFG");
    expect(await src.getToken()).toBe("ghp_xxx");
  });

  it("builds an App token source when github.app + privateKeyEnv + installationId are set", async () => {
    process.env.SHIPREPORT_APP_PEM = privateKeyPem;
    const cfg = normalize({
      github: {
        app: { appId: 42, privateKeyEnv: "SHIPREPORT_APP_PEM", installationId: 7 },
      },
      org: "o",
      teams: [{ name: "t", manager: "a", members: ["a"], repos: ["o/r"] }],
      defaults: { quarter: "2026Q1" },
    });
    const src = await tokenSourceFromConfig(cfg);
    expect(src.kind).toBe("app");
    expect(src.identity).toBe("app:42:install:7");
    expect(await src.getToken()).toMatch(/^fake-installation-42-7-/);
  });

  it("accepts appId/installationId as strings and coerces to numbers", async () => {
    process.env.SHIPREPORT_APP_PEM = privateKeyPem;
    const cfg = normalize({
      github: {
        app: {
          appId: "99",
          privateKeyEnv: "SHIPREPORT_APP_PEM",
          installationId: "101",
        },
      },
      org: "o",
      teams: [{ name: "t", manager: "a", members: ["a"], repos: ["o/r"] }],
      defaults: { quarter: "2026Q1" },
    });
    const src = await tokenSourceFromConfig(cfg);
    expect(src.identity).toBe("app:99:install:101");
  });

  it("unescapes '\\n' sequences when the private-key env var is a single-line PEM", async () => {
    const singleLine = privateKeyPem.replace(/\n/g, "\\n");
    process.env.SHIPREPORT_APP_PEM = singleLine;
    const cfg = normalize({
      github: {
        app: { appId: 42, privateKeyEnv: "SHIPREPORT_APP_PEM", installationId: 7 },
      },
      org: "o",
      teams: [{ name: "t", manager: "a", members: ["a"], repos: ["o/r"] }],
      defaults: { quarter: "2026Q1" },
    });
    const src = await tokenSourceFromConfig(cfg);
    expect(await src.getToken()).toMatch(/^fake-installation-/);
  });

  it("loads the private key from disk when privateKeyPath is set instead of env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shipreport-tok-"));
    const path = join(dir, "app.pem");
    writeFileSync(path, privateKeyPem);
    const cfg = normalize({
      github: {
        app: { appId: 42, privateKeyPath: path, installationId: 7 },
      },
      org: "o",
      teams: [{ name: "t", manager: "a", members: ["a"], repos: ["o/r"] }],
      defaults: { quarter: "2026Q1" },
    });
    const src = await tokenSourceFromConfig(cfg);
    expect(await src.getToken()).toMatch(/^fake-installation-42-7-/);
  });

  it("throws a helpful error when the private-key env var is set but empty", async () => {
    process.env.SHIPREPORT_APP_PEM = "";
    const cfg = normalize({
      github: {
        app: { appId: 42, privateKeyEnv: "SHIPREPORT_APP_PEM", installationId: 7 },
      },
      org: "o",
      teams: [{ name: "t", manager: "a", members: ["a"], repos: ["o/r"] }],
      defaults: { quarter: "2026Q1" },
    });
    await expect(tokenSourceFromConfig(cfg)).rejects.toThrow(
      /SHIPREPORT_APP_PEM is empty/,
    );
  });

  it("throws when neither privateKeyEnv nor privateKeyPath is set", async () => {
    const cfg = normalize({
      github: {
        app: { appId: 42, installationId: 7 },
      },
      org: "o",
      teams: [{ name: "t", manager: "a", members: ["a"], repos: ["o/r"] }],
      defaults: { quarter: "2026Q1" },
    });
    await expect(tokenSourceFromConfig(cfg)).rejects.toThrow(
      /privateKeyEnv or privateKeyPath/,
    );
  });

  it("discovers installationId from GitHub when not configured, via /orgs/:org/installation", async () => {
    process.env.SHIPREPORT_APP_PEM = privateKeyPem;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 555 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const cfg = normalize({
      github: { app: { appId: 42, privateKeyEnv: "SHIPREPORT_APP_PEM" } },
      org: "example-org",
      teams: [{ name: "t", manager: "a", members: ["a"], repos: ["o/r"] }],
      defaults: { quarter: "2026Q1" },
    });
    const src = await tokenSourceFromConfig(cfg);
    expect(src.identity).toBe("app:42:install:555");
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toMatch(
      /https:\/\/api\.github\.com\/orgs\/example-org\/installation/,
    );
    expect((call[1] as { headers: Record<string, string> }).headers.authorization).toMatch(
      /^Bearer fake-app-42-none-/,
    );
  });

  it("surfaces a descriptive error if the installation-discovery fetch fails", async () => {
    process.env.SHIPREPORT_APP_PEM = privateKeyPem;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("", { status: 404, statusText: "Not Found" }),
      ),
    );
    const cfg = normalize({
      github: { app: { appId: 42, privateKeyEnv: "SHIPREPORT_APP_PEM" } },
      org: "missing-org",
      teams: [{ name: "t", manager: "a", members: ["a"], repos: ["o/r"] }],
      defaults: { quarter: "2026Q1" },
    });
    await expect(tokenSourceFromConfig(cfg)).rejects.toThrow(
      /installation for org missing-org: 404 Not Found/,
    );
  });
});
