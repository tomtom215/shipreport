import { Cache } from "./cache.js";
import { resolveAuth } from "./auth.js";
import { AuditLog } from "./audit.js";
import type { Config, TeamConfig } from "./config.js";
import { resolveHome, resolveTeam } from "./config.js";
import { createCounters, type RunCounters } from "./counters.js";
import { discoverMembers } from "./discover.js";
import { ExtractCache, extractAll } from "./extract.js";
import { makeClient } from "./github.js";
import {
  readPackageVersion,
  renderDev,
  renderManagerRollup,
  renderTeamSummary,
  writeReport,
} from "./render.js";
import { ScheduleStore } from "./schedule.js";
import { StateDB } from "./state.js";
import { buildTeamQuarter } from "./transform.js";

export interface RunOptions {
  cfg: Config;
  team: TeamConfig;
  overrideQuarter?: string;
  extraFormats?: ReadonlyArray<"md" | "html" | "pdf" | "png">;
  log: (msg: string) => void;
  audit?: AuditLog;
  triggeredBy: "manual" | "schedule";
  /** Override config.extract.concurrency for this run. */
  concurrency?: number;
  /** Skip network, read only from cache. Cold cache → runTeam throws. */
  dryRun?: boolean;
}

export interface RunResult {
  team: string;
  quarter: string;
  written: string[];
  gaps: { repo: string; reason: string }[];
  counters: RunCounters;
}

export async function runTeam(opts: RunOptions): Promise<RunResult> {
  const { cfg, team, log } = opts;
  const counters = createCounters();
  const startedAt = Date.now();

  const auth = await resolveAuth(cfg);
  opts.audit?.append({
    actor: auth.identity,
    event: "token_resolved",
    target: cfg.org,
    payload: { kind: auth.kind },
  });

  const teamCfg =
    opts.overrideQuarter !== undefined
      ? { ...team, quarter: opts.overrideQuarter as TeamConfig["quarter"] }
      : team;
  const resolved = resolveTeam(cfg, teamCfg);
  const quarter = resolved.quarter;
  const concurrency = opts.concurrency ?? cfg.extract.concurrency;

  log(
    `team=${team.name} quarter=${quarter.label} (${quarter.from} → ${quarter.to}) concurrency=${concurrency}${opts.dryRun ? " dry-run" : ""}`,
  );
  opts.audit?.append({
    actor: auth.identity,
    event: "run_started",
    target: `${cfg.org}/${team.name}`,
    payload: {
      quarter: quarter.label,
      repos: team.repos,
      triggeredBy: opts.triggeredBy,
      concurrency,
      dryRun: opts.dryRun === true,
    },
  });

  const cacheHandle = await Cache.open(resolveHome(cfg.cache.path), cfg.cache.ttlDays);
  const extractCache = new ExtractCache(cacheHandle);
  const client = makeClient({
    token: auth.token,
    baseUrl: cfg.github.baseUrl,
    graphqlUrl: cfg.github.graphqlUrl,
    log,
    cache: cacheHandle,
    counters,
  });

  const { prsByRepo, gaps, droppedNonDefaultBranch } = await extractAll(
    client,
    { repos: resolved.repos },
    quarter,
    { concurrency, dryRun: opts.dryRun, counters, cache: extractCache, log },
  );
  if (droppedNonDefaultBranch > 0) {
    log(
      `dropped ${droppedNonDefaultBranch} merged PR(s) whose base was not the default branch`,
    );
  }

  let members: string[];
  if (resolved.members) {
    members = resolved.members;
  } else {
    const allPRs = [...prsByRepo.values()].flat();
    const discovery = discoverMembers(allPRs, resolved.autoMembers);
    members = discovery.members;
    log(
      `auto-discovered ${members.length} member(s) from ${discovery.considered} distinct author(s); skipped ${discovery.skippedBots.length} bot(s)`,
    );
    opts.audit?.append({
      actor: auth.identity,
      event: "members_discovered",
      target: `${cfg.org}/${team.name}`,
      payload: {
        quarter: quarter.label,
        members,
        considered: discovery.considered,
        skippedBots: discovery.skippedBots,
        limit: resolved.autoMembers.limit,
      },
    });
    if (members.length === 0) {
      log(`no members discovered — no PRs in window, or all authors were bots`);
    }
  }

  const teamQuarter = buildTeamQuarter(
    {
      manager: resolved.manager,
      members,
      repos: resolved.repos,
      classification: resolved.classification,
      coAuthorCredit: resolved.coAuthorCredit,
    },
    quarter,
    prsByRepo,
    gaps,
  );

  const version = await readPackageVersion();
  const generatedAt = new Date().toISOString();
  const formats: Array<"md" | "html" | "pdf" | "png"> = [...resolved.output.formats];
  for (const f of opts.extraFormats ?? []) if (!formats.includes(f)) formats.push(f);
  const outDir = resolved.output.dir;
  const written: string[] = [];

  if (resolved.output.perDev) {
    for (const dev of teamQuarter.members) {
      const md = await renderDev(dev, quarter, teamQuarter, { version, generatedAt });
      const paths = await writeReport(
        outDir,
        `${dev.login}-${quarter.label}`,
        md,
        formats,
        `${dev.displayName} — ${quarter.label}`,
      );
      written.push(...paths);
    }
  }
  if (resolved.output.teamSummary) {
    const md = await renderTeamSummary(teamQuarter, { version, generatedAt });
    const paths = await writeReport(
      outDir,
      `team-summary-${team.name}-${quarter.label}`,
      md,
      formats,
      `Team summary — ${team.name} — ${quarter.label}`,
    );
    written.push(...paths);
  }
  if (resolved.output.managerRollup) {
    const md = await renderManagerRollup(teamQuarter, { version, generatedAt });
    const paths = await writeReport(
      outDir,
      `manager-rollup-${team.name}-${quarter.label}`,
      md,
      formats,
      `Manager rollup — ${team.name} — ${quarter.label}`,
    );
    written.push(...paths);
  }

  // One cheap probe to capture remaining quota after the real work is done.
  if (!opts.dryRun) counters.remainingRateLimit = await client.probeRemaining();
  cacheHandle.close();

  for (const p of written) {
    opts.audit?.append({
      actor: auth.identity,
      event: "report_written",
      target: `${cfg.org}/${team.name}`,
      payload: { path: p },
    });
  }

  counters.wallMs = Date.now() - startedAt;
  opts.audit?.append({
    actor: auth.identity,
    event: "run_completed",
    target: `${cfg.org}/${team.name}`,
    payload: {
      quarter: quarter.label,
      filesWritten: written.length,
      dataGaps: gaps.length,
      droppedNonDefaultBranch,
      counters,
    },
  });

  return {
    team: team.name,
    quarter: quarter.label,
    written,
    gaps: gaps.map((g) => ({ repo: g.repo, reason: g.reason })),
    counters,
  };
}

export async function openState(cfg: Config): Promise<StateDB | null> {
  if (!cfg.audit.enabled) return null;
  return await StateDB.open(resolveHome(cfg.audit.path));
}

export function scheduleStoreFor(state: StateDB): ScheduleStore {
  return new ScheduleStore(state);
}

export function auditLogFor(state: StateDB): AuditLog {
  return new AuditLog(state);
}
