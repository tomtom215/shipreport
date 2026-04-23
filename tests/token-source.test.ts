import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  createAppTokenSource,
  createPatTokenSource,
  DEFAULT_RENEW_AFTER_MS,
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
