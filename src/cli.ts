import { defineCommand, runMain } from "citty";
import { loadConfig, resolveHome, selectTeams } from "./config.js";
import { Cache } from "./cache.js";
import { exportJsonl } from "./audit-export.js";
import { makeClient, probeToken } from "./github.js";
import { resolveAuth } from "./auth.js";
import { auditLogFor, openState, runTeam, scheduleStoreFor } from "./run.js";
import { isDueSince, parseCron } from "./schedule.js";
import { buildManifest, loadOrGenerateKey, signManifest } from "./sign.js";

function logger(verbose: boolean) {
  return (msg: string): void => {
    if (verbose) console.error(`[shipreport] ${msg}`);
  };
}

const run = defineCommand({
  meta: { name: "run", description: "Generate success stories for one team or all teams." },
  args: {
    config: { type: "string", description: "Path to shipreport.yaml", required: true },
    team: { type: "string", description: "Team name (omit with --all to run every team)" },
    all: { type: "boolean", description: "Run every team in the config", default: false },
    quarter: { type: "string", description: "Override quarter, e.g. 2026Q1" },
    pdf: { type: "boolean", description: "Also emit PDF (requires puppeteer)", default: false },
    png: { type: "boolean", description: "Also emit PNG (requires puppeteer)", default: false },
    concurrency: {
      type: "string",
      description: "Max concurrent per-repo fetches (overrides extract.concurrency)",
    },
    dryRun: {
      type: "boolean",
      description: "Don't hit the network; fail if cache is cold",
      default: false,
    },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const log = logger(args.verbose);
    if (!args.team && !args.all) {
      throw new Error("Pass --team <name> or --all.");
    }

    const state = await openState(cfg);
    const audit = state ? auditLogFor(state) : undefined;
    audit?.append({
      actor: "cli:run",
      event: "config_loaded",
      target: args.config,
      payload: { teams: cfg.teams.map((t) => t.name), org: cfg.org },
    });

    const teams = selectTeams(cfg, args.all ? undefined : args.team);
    const extra: Array<"md" | "html" | "pdf" | "png"> = [];
    if (args.pdf) extra.push("pdf");
    if (args.png) extra.push("png");
    const results: Array<{ team: string; ok: boolean; err?: string }> = [];

    const concurrencyOverride = args.concurrency
      ? (() => {
          const n = Number(args.concurrency);
          if (!Number.isFinite(n) || n < 1) {
            throw new Error(`--concurrency must be a positive integer (got ${args.concurrency})`);
          }
          return Math.floor(n);
        })()
      : undefined;

    for (const t of teams) {
      try {
        const r = await runTeam({
          cfg,
          team: t,
          overrideQuarter: args.quarter,
          extraFormats: extra,
          log,
          audit,
          triggeredBy: "manual",
          concurrency: concurrencyOverride,
          dryRun: args.dryRun,
        });
        if (state) scheduleStoreFor(state).record(t.name, "ok", r.quarter);
        console.log(`[${t.name}] wrote ${r.written.length} file(s):`);
        for (const p of r.written) console.log(`  ${p}`);
        if (r.gaps.length > 0) {
          console.log(`  data gaps: ${r.gaps.map((g) => g.repo).join(", ")}`);
        }
        results.push({ team: t.name, ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit?.append({
          actor: "cli:run",
          event: "run_failed",
          target: t.name,
          payload: { error: msg },
        });
        if (state) scheduleStoreFor(state).record(t.name, "failed", null);
        console.error(`[${t.name}] FAILED: ${msg}`);
        results.push({ team: t.name, ok: false, err: msg });
      }
    }

    state?.close();
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) process.exit(1);
  },
});

const preview = defineCommand({
  meta: { name: "preview", description: "Preview a single dev's story to stdout." },
  args: {
    config: { type: "string", required: true },
    team: { type: "string", required: true, description: "Team name" },
    member: { type: "string", required: true },
    quarter: { type: "string" },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const log = logger(args.verbose);
    const teams = selectTeams(cfg, args.team);
    const t = teams[0]!;
    if (t.members && !t.members.includes(args.member)) {
      console.error(
        `Warning: ${args.member} is not in team "${args.team}". Proceeding anyway.`,
      );
    }
    const scoped = { ...t, members: [args.member] };
    const r = await runTeam({
      cfg,
      team: scoped,
      overrideQuarter: args.quarter,
      log,
      triggeredBy: "manual",
    });
    for (const p of r.written) {
      if (p.endsWith(".md") && p.includes(`${args.member}-`)) {
        const { readFile } = await import("node:fs/promises");
        process.stdout.write(await readFile(p, "utf8"));
        return;
      }
    }
  },
});

const scheduleTick = defineCommand({
  meta: {
    name: "tick",
    description: "Run every team whose schedule is overdue since its last run.",
  },
  args: {
    config: { type: "string", required: true },
    force: {
      type: "boolean",
      description: "Run every scheduled team regardless of last-run state",
      default: false,
    },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const log = logger(args.verbose);
    const state = await openState(cfg);
    if (!state) {
      console.error("audit.enabled: false — scheduler requires state DB to be available.");
      process.exit(2);
    }
    const audit = auditLogFor(state);
    const store = scheduleStoreFor(state);
    const now = new Date();
    const ran: string[] = [];
    const skipped: string[] = [];

    for (const t of cfg.teams) {
      if (!t.schedule) {
        skipped.push(`${t.name} (no schedule)`);
        continue;
      }
      const spec = parseCron(t.schedule);
      const rec = store.get(t.name);
      const due = args.force || isDueSince(spec, rec.lastRunAt, now);
      if (!due) {
        skipped.push(`${t.name} (not due; last run ${rec.lastRunAt ?? "never"})`);
        continue;
      }
      audit.append({
        actor: "cli:schedule",
        event: "schedule_triggered",
        target: t.name,
        payload: { cron: t.schedule, lastRunAt: rec.lastRunAt },
      });
      try {
        const r = await runTeam({ cfg, team: t, log, audit, triggeredBy: "schedule" });
        store.record(t.name, "ok", r.quarter);
        ran.push(`${t.name} → ${r.written.length} file(s)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        store.record(t.name, "failed", null);
        audit.append({
          actor: "cli:schedule",
          event: "run_failed",
          target: t.name,
          payload: { error: msg },
        });
        ran.push(`${t.name} → FAILED: ${msg}`);
      }
    }

    state.close();
    console.log(`Ran ${ran.length} team(s):`);
    for (const r of ran) console.log(`  ${r}`);
    if (skipped.length > 0) {
      console.log(`Skipped:`);
      for (const s of skipped) console.log(`  ${s}`);
    }
  },
});

const scheduleCmd = defineCommand({
  meta: { name: "schedule", description: "Scheduler operations." },
  subCommands: { tick: scheduleTick },
});

const auditTail = defineCommand({
  meta: { name: "tail", description: "Show the most recent audit events." },
  args: {
    config: { type: "string", required: true },
    limit: { type: "string", default: "50" },
    since: { type: "string", description: "ISO date/time lower bound" },
    json: { type: "boolean", default: false },
  },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const state = await openState(cfg);
    if (!state) {
      console.error("audit.enabled: false");
      process.exit(2);
    }
    const audit = auditLogFor(state);
    const rows = audit.tail(Number(args.limit), args.since);
    if (args.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else {
      for (const r of rows.reverse()) {
        console.log(
          `${r.seq.toString().padStart(6)} ${r.at}  ${r.event.padEnd(20)} ${r.actor.padEnd(40)} ${r.target ?? ""}`,
        );
      }
    }
    state.close();
  },
});

const auditVerify = defineCommand({
  meta: {
    name: "verify",
    description: "Walk the audit log and verify every row hash + prev_hash link.",
  },
  args: { config: { type: "string", required: true } },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const state = await openState(cfg);
    if (!state) {
      console.error("audit.enabled: false");
      process.exit(2);
    }
    const audit = auditLogFor(state);
    const res = audit.verify();
    state.close();
    if (res.ok) {
      console.log(`OK — ${res.rows} row(s) verified.`);
    } else {
      console.error(`BROKEN at seq ${res.brokeAtSeq}: ${res.reason}`);
      process.exit(1);
    }
  },
});

const auditExport = defineCommand({
  meta: {
    name: "export",
    description:
      "Emit audit rows as JSONL (one row per line) for shipment to a WORM store.",
  },
  args: {
    config: { type: "string", required: true },
    since: { type: "string", description: "ISO date/time lower bound (inclusive)" },
    format: { type: "string", default: "jsonl", description: "Output format (jsonl)" },
  },
  async run({ args }) {
    if (args.format !== "jsonl") {
      console.error(`Unsupported format '${args.format}'. Only 'jsonl' is supported.`);
      process.exit(2);
    }
    const cfg = await loadConfig(args.config);
    const state = await openState(cfg);
    if (!state) {
      console.error("audit.enabled: false");
      process.exit(2);
    }
    const audit = auditLogFor(state);
    const rows = audit.readForward(args.since);
    process.stdout.write(exportJsonl(rows));
    state.close();
  },
});

const auditSnapshot = defineCommand({
  meta: {
    name: "snapshot",
    description:
      "Produce a signed (ed25519) manifest of the current audit chain head for external anchoring.",
  },
  args: {
    config: { type: "string", required: true },
    signKey: {
      type: "string",
      description:
        "Path to an ed25519 private key (PEM). Generated on first run if missing.",
    },
    signer: { type: "string", description: "Override config.audit.signer" },
  },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const state = await openState(cfg);
    if (!state) {
      console.error("audit.enabled: false");
      process.exit(2);
    }
    const audit = auditLogFor(state);
    const head = audit.head();
    const keyPath = resolveHome(args.signKey ?? cfg.audit.signingKeyPath);
    const { privateKey, generated } = await loadOrGenerateKey(keyPath);
    if (generated) {
      console.error(`Generated new signing key at ${keyPath} (mode 0600).`);
    }
    const manifest = buildManifest({
      chainHead: head,
      generatedAt: new Date().toISOString(),
      signer: args.signer ?? cfg.audit.signer,
    });
    const signed = signManifest(manifest, privateKey);
    state.close();
    process.stdout.write(JSON.stringify(signed, null, 2) + "\n");
  },
});

const auditCmd = defineCommand({
  meta: { name: "audit", description: "Audit log operations." },
  subCommands: {
    tail: auditTail,
    verify: auditVerify,
    export: auditExport,
    snapshot: auditSnapshot,
  },
});

const cachePrune = defineCommand({
  meta: { name: "prune", description: "Delete cache entries older than ttlDays." },
  args: { config: { type: "string", required: true } },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const cache = await Cache.open(resolveHome(cfg.cache.path), cfg.cache.ttlDays);
    const n = cache.prune();
    cache.close();
    const state = await openState(cfg);
    if (state) {
      auditLogFor(state).append({
        actor: "cli:cache",
        event: "cache_pruned",
        target: cfg.cache.path,
        payload: { deleted: n },
      });
      state.close();
    }
    console.log(`Pruned ${n} stale cache entries.`);
  },
});

const cacheCmd = defineCommand({
  meta: { name: "cache", description: "Cache operations." },
  subCommands: { prune: cachePrune },
});

const doctor = defineCommand({
  meta: {
    name: "doctor",
    description: "Probe auth, reachability, optional puppeteer, state DB.",
  },
  args: { config: { type: "string", required: true } },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const auth = await resolveAuth(cfg);
    const client = makeClient({
      token: auth.token,
      baseUrl: cfg.github.baseUrl,
      graphqlUrl: cfg.github.graphqlUrl,
    });
    const info = await probeToken(client);

    console.log(`Auth kind:        ${auth.kind}`);
    console.log(`Identity:         ${auth.identity}`);
    console.log(`Authenticated as: ${info.login}`);
    console.log(
      `Token scopes:     ${info.scopes.join(", ") || "(fine-grained PAT or App installation)"}`,
    );
    console.log(`GHES version:     ${info.ghesVersion ?? "github.com"}`);
    console.log(`Base URL:         ${cfg.github.baseUrl}`);
    console.log(`Cache path:       ${resolveHome(cfg.cache.path)}`);
    console.log(`Audit enabled:    ${cfg.audit.enabled}`);
    if (cfg.audit.enabled) console.log(`State path:       ${resolveHome(cfg.audit.path)}`);
    console.log(`Teams:            ${cfg.teams.map((t) => t.name).join(", ")}`);
    const scheduled = cfg.teams.filter((t) => t.schedule);
    if (scheduled.length > 0) {
      console.log(`Scheduled teams:`);
      for (const t of scheduled) {
        try {
          parseCron(t.schedule!);
          console.log(`  ${t.name}: ${t.schedule}`);
        } catch (err) {
          console.log(`  ${t.name}: ${t.schedule}  — INVALID: ${(err as Error).message}`);
        }
      }
    }

    const pdfRequested = cfg.teams.some((t) =>
      (t.output?.formats ?? cfg.defaults.output.formats).includes("pdf"),
    );
    if (pdfRequested) {
      try {
        await import("puppeteer");
        console.log(`Puppeteer:        available`);
      } catch {
        console.log(`Puppeteer:        MISSING — install with \`pnpm add puppeteer\``);
      }
    }
  },
});

const main = defineCommand({
  meta: {
    name: "shipreport",
    version: "0.2.0",
    description: "Quarterly engineering success story generator.",
  },
  subCommands: {
    run,
    preview,
    schedule: scheduleCmd,
    audit: auditCmd,
    cache: cacheCmd,
    doctor,
  },
});

runMain(main);
