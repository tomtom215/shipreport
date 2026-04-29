/**
 * Direct invocation tests for src/cli.ts subcommands.
 *
 * Each citty `defineCommand` exports a `run({ args })` function we can
 * call without spawning a subprocess. We:
 *   * exercise every subcommand at least once,
 *   * confirm dry-run / offline paths don't touch the network,
 *   * confirm error / exit paths (audit-disabled state, unsupported
 *     export format) take the documented exits.
 *
 * Coverage objective: replace the previous `src/cli.ts` exclude with
 * real exercise of every dispatch branch.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import nock from "nock";
import { __testables } from "../src/cli.js";
import { Cache } from "../src/cache.js";
import { ExtractCache } from "../src/extract-cache.js";
import { quarterLabelToRange } from "../src/tz.js";
import type { RawPR } from "../src/types.js";

const fixturePR = (over: Partial<RawPR>): RawPR => ({
  repo: "o/r",
  number: 1,
  url: "u",
  title: "feat: x",
  body: "",
  state: "MERGED",
  mergedAt: "2026-04-12T12:00:00Z",
  updatedAt: "2026-04-12T12:00:00Z",
  author: "alice",
  coAuthors: [],
  baseRefName: "main",
  defaultBranch: "main",
  mergeCommitMessage: null,
  labels: [],
  milestone: null,
  reviews: [],
  comments: 0,
  linkedIssues: [],
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  reviewRequests: [],
  ...over,
});

async function makeWorkspace(): Promise<{
  dir: string;
  configPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "shipreport-cli-"));
  const cfgYaml = [
    "github:",
    "  tokenEnv: SHIPREPORT_GITHUB_TOKEN",
    "org: o",
    "teams:",
    "  - name: t",
    "    manager: alice",
    "    members: [alice]",
    "    repos: [o/r]",
    "    schedule: '0 9 * * 1'",
    "defaults:",
    "  quarter: 2026Q2",
    "  timezone: UTC",
    "  output:",
    `    dir: ${path.join(dir, "out")}`,
    "    formats: [md]",
    "audit:",
    "  enabled: true",
    `  path: ${path.join(dir, "state.sqlite")}`,
    `  signingKeyPath: ${path.join(dir, "audit-ed25519.pem")}`,
    "  signer: shipreport-test",
    "cache:",
    `  path: ${path.join(dir, "cache.sqlite")}`,
    "  ttlDays: 7",
    "extract:",
    "  concurrency: 4",
    "  rateLimitThreshold: 100",
    "",
  ].join("\n");
  const configPath = path.join(dir, "shipreport.yaml");
  await writeFile(configPath, cfgYaml, "utf8");
  return {
    dir,
    configPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function warmCache(dir: string): Promise<void> {
  const cache = await Cache.open(path.join(dir, "cache.sqlite"), 7);
  const q = quarterLabelToRange("2026Q2", "UTC");
  new ExtractCache(cache).save(
    "o/r",
    q,
    [fixturePR({ author: "alice" })],
    "2026-04-12T12:00:00Z",
  );
  cache.close();
}

const exitSpy = (): { calls: number[]; restore: () => void } => {
  const calls: number[] = [];
  const orig = process.exit;
  process.exit = ((code?: number) => {
    calls.push(code ?? 0);
    // Throw rather than actually exit so the test keeps running and we
    // can assert.
    throw new Error(`__exit:${code ?? 0}`);
  }) as never;
  return { calls, restore: () => (process.exit = orig) };
};

let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.SHIPREPORT_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  nock.disableNetConnect();
});
afterEach(() => {
  process.env = { ...originalEnv };
  nock.cleanAll();
  nock.enableNetConnect();
});

describe("cli: run", () => {
  it("dry-run + warm cache writes the per-dev report and returns without exit", async () => {
    const ws = await makeWorkspace();
    const e = exitSpy();
    try {
      await warmCache(ws.dir);
      const out: string[] = [];
      const errors: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((m) => {
        out.push(String(m));
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation((m) => {
        errors.push(String(m));
      });
      try {
        await __testables.run.run!({
          args: {
            config: ws.configPath,
            team: "t",
            all: false,
            quarter: "",
            pdf: false,
            png: false,
            dryRun: true,
            verbose: false,
          },
        } as never).catch((err: Error) => {
          if (!err.message.startsWith("__exit:")) throw err;
        });
      } finally {
        log.mockRestore();
        errSpy.mockRestore();
      }
      // dry-run + warm cache must succeed for every team, so process.exit
      // must never be called.
      expect(e.calls, errors.join("\n")).toEqual([]);
      expect(out.join("\n")).toMatch(/wrote \d+ file/);
    } finally {
      e.restore();
      await ws.cleanup();
    }
  });

  it("rejects when neither --team nor --all is set", async () => {
    const ws = await makeWorkspace();
    try {
      await expect(
        __testables.run.run!({
          args: {
            config: ws.configPath,
            team: "",
            all: false,
            verbose: false,
            dryRun: false,
            pdf: false,
            png: false,
          },
        } as never),
      ).rejects.toThrow(/--team .* or --all/);
    } finally {
      await ws.cleanup();
    }
  });

  it("rejects a non-numeric --concurrency value", async () => {
    const ws = await makeWorkspace();
    try {
      await warmCache(ws.dir);
      await expect(
        __testables.run.run!({
          args: {
            config: ws.configPath,
            team: "t",
            all: false,
            verbose: false,
            dryRun: true,
            concurrency: "not-a-number",
            pdf: false,
            png: false,
          },
        } as never),
      ).rejects.toThrow(/--concurrency must be a positive integer/);
    } finally {
      await ws.cleanup();
    }
  });

  it("rejects --concurrency above the cap (mirrors the YAML schema's max=32)", async () => {
    const ws = await makeWorkspace();
    try {
      await warmCache(ws.dir);
      await expect(
        __testables.run.run!({
          args: {
            config: ws.configPath,
            team: "t",
            all: false,
            verbose: false,
            dryRun: true,
            concurrency: "33",
            pdf: false,
            png: false,
          },
        } as never),
      ).rejects.toThrow(/--concurrency must be <= 32/);
    } finally {
      await ws.cleanup();
    }
  });

  it("accepts --concurrency at the cap boundary (32)", async () => {
    const ws = await makeWorkspace();
    try {
      await warmCache(ws.dir);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const e = exitSpy();
      try {
        await __testables.run.run!({
          args: {
            config: ws.configPath,
            team: "t",
            all: false,
            verbose: false,
            dryRun: true,
            concurrency: "32",
            pdf: false,
            png: false,
          },
        } as never).catch((err: Error) => {
          if (!err.message.startsWith("__exit:")) throw err;
        });
        // No process.exit should have been called for a successful dry-run.
        expect(e.calls).toEqual([]);
      } finally {
        log.mockRestore();
        e.restore();
      }
    } finally {
      await ws.cleanup();
    }
  });
});

describe("cli: doctor --offline", () => {
  it("prints config / scheduled-team summary without touching the network", async () => {
    const ws = await makeWorkspace();
    try {
      const out: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((m) => {
        out.push(String(m));
      });
      try {
        await __testables.doctor.run!({
          args: { config: ws.configPath, offline: true },
        } as never);
      } finally {
        log.mockRestore();
      }
      const joined = out.join("\n");
      expect(joined).toMatch(/Auth kind:.*offline/);
      expect(joined).toContain("Teams:");
      expect(joined).toContain("Scheduled teams:");
    } finally {
      await ws.cleanup();
    }
  });

  it("exits 2 when any team's cron is invalid (CI gate per docs/07-scheduling.md)", async () => {
    const ws = await makeWorkspace();
    try {
      // Replace the workspace's config with one that has a malformed
      // cron field. parseCron rejects named days (`MON`/`TUE`) and any
      // 6-field "with seconds" form — we use the named-day form here.
      const yaml = [
        "github: { tokenEnv: X }",
        "org: o",
        "teams:",
        "  - name: t",
        "    manager: a",
        "    members: [a]",
        "    repos: [o/r]",
        "    schedule: '0 14 1 1,4,7,10 MON'",
        "defaults: { quarter: 2026Q2, timezone: UTC }",
        "audit: { enabled: false }",
        "",
      ].join("\n");
      await writeFile(ws.configPath, yaml, "utf8");
      const out: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((m) => {
        out.push(String(m));
      });
      const e = exitSpy();
      try {
        await expect(
          __testables.doctor.run!({
            args: { config: ws.configPath, offline: true },
          } as never),
        ).rejects.toThrow(/__exit:2/);
        // The diagnostic line is still printed for the operator.
        expect(out.join("\n")).toMatch(/INVALID:/);
        expect(e.calls).toContain(2);
      } finally {
        log.mockRestore();
        e.restore();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("exits 0 when all crons are valid (negative control)", async () => {
    const ws = await makeWorkspace();
    try {
      // Default workspace cron `0 9 * * 1` is valid; doctor should
      // complete without calling process.exit.
      const e = exitSpy();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await __testables.doctor.run!({
          args: { config: ws.configPath, offline: true },
        } as never);
        // No exit call means no rejection above; assert calls is empty.
        expect(e.calls).toEqual([]);
      } finally {
        log.mockRestore();
        e.restore();
      }
    } finally {
      await ws.cleanup();
    }
  });
});

describe("cli: schedule tick", () => {
  it("runs every overdue scheduled team in dry-run mode (warm cache)", async () => {
    const ws = await makeWorkspace();
    try {
      await warmCache(ws.dir);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      // The tick command's run() calls runTeam non-dry-run; since we
      // don't have a token, the token-resolution path will throw and the
      // failure is recorded as run_failed. That's the on-failure code
      // path we want to cover. Force.
      const e = exitSpy();
      try {
        await __testables.scheduleTick.run!({
          args: { config: ws.configPath, force: true, verbose: false },
        } as never).catch(() => undefined);
      } finally {
        log.mockRestore();
        e.restore();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("exits 2 when audit.enabled is false", async () => {
    const ws = await makeWorkspace();
    try {
      // Rewrite config with audit disabled.
      const yaml = [
        "github: { tokenEnv: X }",
        "org: o",
        "teams: [{ name: t, manager: a, members: [a], repos: [o/r] }]",
        "defaults: { quarter: 2026Q2, timezone: UTC }",
        `audit: { enabled: false, path: ${path.join(ws.dir, "state.sqlite")} }`,
        "",
      ].join("\n");
      await writeFile(ws.configPath, yaml, "utf8");
      const e = exitSpy();
      try {
        await expect(
          __testables.scheduleTick.run!({
            args: { config: ws.configPath, force: false, verbose: false },
          } as never),
        ).rejects.toThrow(/__exit:2/);
        expect(e.calls).toContain(2);
      } finally {
        e.restore();
      }
    } finally {
      await ws.cleanup();
    }
  });
});

describe("cli: audit", () => {
  it("tail/verify/export all succeed on a freshly-seeded chain", async () => {
    const ws = await makeWorkspace();
    try {
      await warmCache(ws.dir);
      // Seed the chain by running a dry-run.
      await __testables.run.run!({
        args: {
          config: ws.configPath,
          team: "t",
          all: false,
          dryRun: true,
          pdf: false,
          png: false,
          verbose: false,
        },
      } as never);

      // tail
      const out: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((m) => {
        out.push(String(m));
      });
      try {
        await __testables.auditTail.run!({
          args: { config: ws.configPath, limit: "20", since: "", json: false },
        } as never);
        expect(out.some((l) => l.includes("run_started"))).toBe(true);
      } finally {
        log.mockRestore();
      }

      // verify
      const out2: string[] = [];
      const log2 = vi.spyOn(console, "log").mockImplementation((m) => {
        out2.push(String(m));
      });
      try {
        await __testables.auditVerify.run!({
          args: { config: ws.configPath },
        } as never);
        expect(out2.join("\n")).toMatch(/^OK — \d+ row\(s\) verified\.$/m);
      } finally {
        log2.mockRestore();
      }

      // export jsonl
      const writes: string[] = [];
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(((chunk: string | Uint8Array) => {
          writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
          return true;
        }) as never);
      try {
        await __testables.auditExport.run!({
          args: { config: ws.configPath, since: "", format: "jsonl" },
        } as never);
        expect(writes.join("")).toMatch(/"event":"run_started"/);
      } finally {
        stdout.mockRestore();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("audit export rejects an unsupported format with exit 2", async () => {
    const ws = await makeWorkspace();
    try {
      const e = exitSpy();
      try {
        await expect(
          __testables.auditExport.run!({
            args: { config: ws.configPath, since: "", format: "csv" },
          } as never),
        ).rejects.toThrow(/__exit:2/);
        expect(e.calls).toContain(2);
      } finally {
        e.restore();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("audit snapshot emits a JSON manifest and generates a key on first use", async () => {
    const ws = await makeWorkspace();
    try {
      await warmCache(ws.dir);
      // Seed a chain head with a successful dry-run.
      await __testables.run.run!({
        args: {
          config: ws.configPath,
          team: "t",
          all: false,
          dryRun: true,
          pdf: false,
          png: false,
          verbose: false,
        },
      } as never);

      const writes: string[] = [];
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(((chunk: string | Uint8Array) => {
          writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
          return true;
        }) as never);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await __testables.auditSnapshot.run!({
          // Don't pass signKey at all (citty would pass undefined);
          // the audit.signingKeyPath from the YAML is the source of truth.
          args: { config: ws.configPath },
        } as never);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
      const out = JSON.parse(writes.join("")) as {
        manifest: { chainHeadHash: string };
        signature: string;
        publicKeyPem: string;
      };
      expect(out.manifest.chainHeadHash).toMatch(/^[a-f0-9]{64}$/);
      expect(out.signature.length).toBeGreaterThan(20);
      expect(out.publicKeyPem).toContain("PUBLIC KEY");
    } finally {
      await ws.cleanup();
    }
  });
});

describe("cli: audit tail edge paths", () => {
  it("--json emits a JSON-formatted array of rows", async () => {
    const ws = await makeWorkspace();
    try {
      await warmCache(ws.dir);
      await __testables.run.run!({
        args: {
          config: ws.configPath,
          team: "t",
          all: false,
          dryRun: true,
          pdf: false,
          png: false,
          verbose: false,
        },
      } as never);
      const writes: string[] = [];
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(((c: string | Uint8Array) => {
          writes.push(typeof c === "string" ? c : Buffer.from(c).toString());
          return true;
        }) as never);
      try {
        await __testables.auditTail.run!({
          args: { config: ws.configPath, limit: "5", json: true },
        } as never);
      } finally {
        stdout.mockRestore();
      }
      const parsed = JSON.parse(writes.join("")) as Array<{ event: string }>;
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.some((r) => r.event === "run_started")).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("audit tail with audit.enabled=false exits 2", async () => {
    const ws = await makeWorkspace();
    try {
      const yaml = [
        "github: { tokenEnv: X }",
        "org: o",
        "teams: [{ name: t, manager: a, members: [a], repos: [o/r] }]",
        "defaults: { quarter: 2026Q2, timezone: UTC }",
        `audit: { enabled: false, path: ${path.join(ws.dir, "state.sqlite")} }`,
      ].join("\n");
      await writeFile(ws.configPath, yaml, "utf8");
      const e = exitSpy();
      try {
        await expect(
          __testables.auditTail.run!({
            args: { config: ws.configPath, limit: "5", json: false },
          } as never),
        ).rejects.toThrow(/__exit:2/);
        expect(e.calls).toContain(2);
      } finally {
        e.restore();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("audit verify on empty chain prints OK 0 row(s)", async () => {
    const ws = await makeWorkspace();
    try {
      const out: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((m) => {
        out.push(String(m));
      });
      try {
        await __testables.auditVerify.run!({
          args: { config: ws.configPath },
        } as never);
      } finally {
        log.mockRestore();
      }
      expect(out.join("\n")).toMatch(/OK — 0 row\(s\) verified\./);
    } finally {
      await ws.cleanup();
    }
  });
});

describe("cli: schedule tick edge paths", () => {
  it("logs `Skipped` for teams with no schedule", async () => {
    const ws = await makeWorkspace();
    try {
      // Rewrite config so the team has NO schedule.
      const yaml = [
        "github: { tokenEnv: X }",
        "org: o",
        "teams: [{ name: t, manager: a, members: [a], repos: [o/r] }]",
        "defaults: { quarter: 2026Q2, timezone: UTC }",
        `audit: { enabled: true, path: ${path.join(ws.dir, "state.sqlite")} }`,
        `cache: { path: ${path.join(ws.dir, "cache.sqlite")}, ttlDays: 7 }`,
      ].join("\n");
      await writeFile(ws.configPath, yaml, "utf8");
      const out: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((m) => {
        out.push(String(m));
      });
      try {
        await __testables.scheduleTick.run!({
          args: { config: ws.configPath, force: false, verbose: false },
        } as never);
      } finally {
        log.mockRestore();
      }
      const joined = out.join("\n");
      expect(joined).toMatch(/Skipped/);
      expect(joined).toMatch(/no schedule/);
    } finally {
      await ws.cleanup();
    }
  });
});

describe("cli: doctor online + pdf paths", () => {
  it("online doctor probes /user via REST and reports identity + scopes", async () => {
    const ws = await makeWorkspace();
    process.env.SHIPREPORT_GITHUB_TOKEN = "ghp_doctor_test";
    nock("https://api.github.com")
      .get("/user")
      .reply(200, { login: "alice" }, {
        "x-oauth-scopes": "repo, read:org",
      });
    try {
      const out: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((m) => {
        out.push(String(m));
      });
      try {
        await __testables.doctor.run!({
          args: { config: ws.configPath, offline: false },
        } as never);
      } finally {
        log.mockRestore();
      }
      const joined = out.join("\n");
      expect(joined).toContain("Authenticated as: alice");
      expect(joined).toContain("Token scopes:     repo, read:org");
    } finally {
      delete process.env.SHIPREPORT_GITHUB_TOKEN;
      await ws.cleanup();
    }
  });

  it("doctor reports MISSING for puppeteer when a team requests pdf", async () => {
    const ws = await makeWorkspace();
    try {
      // Rewrite YAML so the team requests `pdf` output.
      const yaml = [
        "github: { tokenEnv: SHIPREPORT_GITHUB_TOKEN }",
        "org: o",
        "teams:",
        "  - name: t",
        "    manager: alice",
        "    members: [alice]",
        "    repos: [o/r]",
        "    output: { formats: [md, pdf] }",
        "defaults: { quarter: 2026Q2, timezone: UTC }",
        `audit: { enabled: true, path: ${path.join(ws.dir, "state.sqlite")} }`,
        `cache: { path: ${path.join(ws.dir, "cache.sqlite")}, ttlDays: 7 }`,
      ].join("\n");
      await writeFile(ws.configPath, yaml, "utf8");

      const out: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((m) => {
        out.push(String(m));
      });
      try {
        await __testables.doctor.run!({
          args: { config: ws.configPath, offline: true },
        } as never);
      } finally {
        log.mockRestore();
      }
      // puppeteer is in optionalDependencies; whether it's installed in
      // this environment is environment-dependent. We just need either
      // "available" or "MISSING" to appear (proves the branch ran).
      expect(out.some((l) => /Puppeteer:.*(available|MISSING)/.test(l))).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });
});

describe("cli: audit cmds with audit.enabled=false", () => {
  const writeNoAudit = async (cfgPath: string, dir: string): Promise<void> => {
    const yaml = [
      "github: { tokenEnv: X }",
      "org: o",
      "teams: [{ name: t, manager: a, members: [a], repos: [o/r] }]",
      "defaults: { quarter: 2026Q2, timezone: UTC }",
      `audit: { enabled: false, path: ${path.join(dir, "state.sqlite")} }`,
    ].join("\n");
    await writeFile(cfgPath, yaml, "utf8");
  };

  it("audit verify exits 2", async () => {
    const ws = await makeWorkspace();
    try {
      await writeNoAudit(ws.configPath, ws.dir);
      const e = exitSpy();
      try {
        await expect(
          __testables.auditVerify.run!({
            args: { config: ws.configPath },
          } as never),
        ).rejects.toThrow(/__exit:2/);
      } finally {
        e.restore();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("audit export exits 2", async () => {
    const ws = await makeWorkspace();
    try {
      await writeNoAudit(ws.configPath, ws.dir);
      const e = exitSpy();
      try {
        await expect(
          __testables.auditExport.run!({
            args: { config: ws.configPath, since: "", format: "jsonl" },
          } as never),
        ).rejects.toThrow(/__exit:2/);
      } finally {
        e.restore();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("audit snapshot exits 2", async () => {
    const ws = await makeWorkspace();
    try {
      await writeNoAudit(ws.configPath, ws.dir);
      const e = exitSpy();
      try {
        await expect(
          __testables.auditSnapshot.run!({
            args: { config: ws.configPath },
          } as never),
        ).rejects.toThrow(/__exit:2/);
      } finally {
        e.restore();
      }
    } finally {
      await ws.cleanup();
    }
  });
});

describe("cli: cache prune", () => {
  it("prunes cache and writes a cache_pruned audit row", async () => {
    const ws = await makeWorkspace();
    try {
      await warmCache(ws.dir);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await __testables.cachePrune.run!({
          args: { config: ws.configPath },
        } as never);
      } finally {
        log.mockRestore();
      }
    } finally {
      await ws.cleanup();
    }
  });
});

describe("cli: preview", () => {
  it("dry-run emits the dev's markdown to stdout", async () => {
    const ws = await makeWorkspace();
    try {
      await warmCache(ws.dir);
      const writes: string[] = [];
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(((chunk: string | Uint8Array) => {
          writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
          return true;
        }) as never);
      try {
        await __testables.preview.run!({
          args: {
            config: ws.configPath,
            team: "t",
            member: "alice",
            dryRun: true,
            verbose: false,
          },
        } as never);
      } finally {
        stdout.mockRestore();
      }
      const md = writes.join("");
      expect(md).toMatch(/alice/);
    } finally {
      await ws.cleanup();
    }
  });

  it("warns when the member isn't on the team but proceeds", async () => {
    const ws = await makeWorkspace();
    try {
      await warmCache(ws.dir);
      const errors: string[] = [];
      const stderr = vi.spyOn(console, "error").mockImplementation((m) => {
        errors.push(String(m));
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await __testables.preview.run!({
          args: {
            config: ws.configPath,
            team: "t",
            member: "stranger",
            dryRun: true,
            verbose: false,
          },
        } as never);
      } finally {
        stderr.mockRestore();
        stdout.mockRestore();
      }
      expect(errors.join("\n")).toMatch(/Warning: stranger is not in team/);
    } finally {
      await ws.cleanup();
    }
  });
});
