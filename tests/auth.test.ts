import { afterEach, describe, expect, it } from "vitest";
import { resolveAuth } from "../src/auth.js";
import { normalize } from "../src/config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveAuth (PAT path)", () => {
  it("reads the token from the configured env var", async () => {
    process.env.SHIPREPORT_TEST_TOKEN = "ghp_abcdef";
    const cfg = normalize({
      github: { tokenEnv: "SHIPREPORT_TEST_TOKEN" },
      org: "acme",
      teams: [{ name: "a", manager: "m", members: ["x"], repos: ["acme/x"] }],
      defaults: { quarter: "2026Q1" },
    });
    const a = await resolveAuth(cfg);
    expect(a.kind).toBe("pat");
    expect(a.token).toBe("ghp_abcdef");
    // Identity never contains the secret.
    expect(a.identity).not.toContain("ghp_");
    expect(a.identity).toBe("pat:env:SHIPREPORT_TEST_TOKEN");
  });

  it("throws with a helpful error when env var is unset", async () => {
    delete process.env.SHIPREPORT_MISSING;
    const cfg = normalize({
      github: { tokenEnv: "SHIPREPORT_MISSING" },
      org: "acme",
      teams: [{ name: "a", manager: "m", members: ["x"], repos: ["acme/x"] }],
      defaults: { quarter: "2026Q1" },
    });
    await expect(resolveAuth(cfg)).rejects.toThrow(/SHIPREPORT_MISSING/);
  });
});

describe("resolveAuth (App path, bad key)", () => {
  it("errors cleanly if privateKeyEnv is unset", async () => {
    delete process.env.SHIPREPORT_TEST_APP_KEY;
    const cfg = normalize({
      github: {
        app: {
          appId: 12345,
          privateKeyEnv: "SHIPREPORT_TEST_APP_KEY",
          installationId: 99,
        },
      },
      org: "acme",
      teams: [{ name: "a", manager: "m", members: ["x"], repos: ["acme/x"] }],
      defaults: { quarter: "2026Q1" },
    });
    await expect(resolveAuth(cfg)).rejects.toThrow(/private key/i);
  });
});
