import { defineCommand, runMain } from "citty";
import { loadConfig, requireToken, resolveCachePath, resolveQuarter } from "./config.js";
import { Cache } from "./cache.js";
import { makeClient, probeToken } from "./github.js";
import { extractAll } from "./extract.js";
import { buildTeamQuarter } from "./transform.js";
import {
  readPackageVersion,
  renderDev,
  renderManagerRollup,
  renderTeamSummary,
  writeReport,
} from "./render.js";

function logger(verbose: boolean) {
  return (msg: string): void => {
    if (verbose) console.error(`[shipreport] ${msg}`);
  };
}

const run = defineCommand({
  meta: { name: "run", description: "Generate success stories for the configured quarter." },
  args: {
    config: { type: "string", description: "Path to shipreport.yaml", required: true },
    pdf: { type: "boolean", description: "Also emit PDF (requires puppeteer)", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const token = requireToken(cfg);
    const log = logger(args.verbose);

    const quarter = resolveQuarter(cfg.quarter, cfg.timezone);
    log(`quarter ${quarter.label} (${quarter.from} → ${quarter.to})`);

    const cache = await Cache.open(resolveCachePath(cfg.cache.path), cfg.cache.ttlDays);
    const client = makeClient({
      token,
      baseUrl: cfg.github.baseUrl,
      graphqlUrl: cfg.github.graphqlUrl,
      log,
      cache,
    });

    const { prsByRepo, gaps } = await extractAll(client, cfg, quarter, log);
    const team = buildTeamQuarter(cfg, quarter, prsByRepo, gaps);

    const version = await readPackageVersion();
    const generatedAt = new Date().toISOString();
    const formats = [...cfg.output.formats];
    if (args.pdf && !formats.includes("pdf")) formats.push("pdf");
    const outDir = cfg.output.dir;

    const written: string[] = [];

    if (cfg.output.perDev) {
      for (const dev of team.members) {
        const md = await renderDev(dev, quarter, team, { version, generatedAt });
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
    if (cfg.output.teamSummary) {
      const md = await renderTeamSummary(team, { version, generatedAt });
      const paths = await writeReport(
        outDir,
        `team-summary-${quarter.label}`,
        md,
        formats,
        `Team summary — ${quarter.label}`,
      );
      written.push(...paths);
    }
    if (cfg.output.managerRollup) {
      const md = await renderManagerRollup(team, { version, generatedAt });
      const paths = await writeReport(
        outDir,
        `manager-rollup-${quarter.label}`,
        md,
        formats,
        `Manager rollup — ${quarter.label}`,
      );
      written.push(...paths);
    }

    cache.close();

    console.log(`Wrote ${written.length} file(s) to ${outDir}:`);
    for (const p of written) console.log(`  ${p}`);
    if (gaps.length > 0) {
      console.log(`\nData gaps (${gaps.length}):`);
      for (const g of gaps) console.log(`  ${g.repo}: ${g.reason}`);
    }
  },
});

const preview = defineCommand({
  meta: { name: "preview", description: "Preview a single dev's story to stdout." },
  args: {
    config: { type: "string", required: true },
    member: { type: "string", required: true },
    quarter: { type: "string", description: "Override quarter, e.g. 2026Q1" },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const token = requireToken(cfg);
    const log = logger(args.verbose);

    const overriddenCfg = args.quarter ? { ...cfg, quarter: args.quarter } : cfg;
    const quarter = resolveQuarter(overriddenCfg.quarter, cfg.timezone);

    if (!cfg.team.members.includes(args.member)) {
      console.error(
        `Warning: ${args.member} is not in team.members. Proceeding anyway; aggregation uses the scanned repos.`,
      );
    }

    const cache = await Cache.open(resolveCachePath(cfg.cache.path), cfg.cache.ttlDays);
    const client = makeClient({
      token,
      baseUrl: cfg.github.baseUrl,
      graphqlUrl: cfg.github.graphqlUrl,
      log,
      cache,
    });

    const { prsByRepo, gaps } = await extractAll(client, cfg, quarter, log);
    const tempCfg = { ...cfg, team: { ...cfg.team, members: [args.member] } };
    const team = buildTeamQuarter(tempCfg, quarter, prsByRepo, gaps);
    const dev = team.members[0]!;
    const version = await readPackageVersion();
    const md = await renderDev(dev, quarter, team, {
      version,
      generatedAt: new Date().toISOString(),
    });
    cache.close();
    process.stdout.write(md);
  },
});

const cachePrune = defineCommand({
  meta: { name: "prune", description: "Delete cache entries older than ttlDays." },
  args: { config: { type: "string", required: true } },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const cache = await Cache.open(resolveCachePath(cfg.cache.path), cfg.cache.ttlDays);
    const n = cache.prune();
    cache.close();
    console.log(`Pruned ${n} stale cache entries.`);
  },
});

const cacheCmd = defineCommand({
  meta: { name: "cache", description: "Cache operations." },
  subCommands: { prune: cachePrune },
});

const doctor = defineCommand({
  meta: { name: "doctor", description: "Probe token, reachability, optional puppeteer." },
  args: { config: { type: "string", required: true } },
  async run({ args }) {
    const cfg = await loadConfig(args.config);
    const token = requireToken(cfg);
    const client = makeClient({
      token,
      baseUrl: cfg.github.baseUrl,
      graphqlUrl: cfg.github.graphqlUrl,
    });

    const info = await probeToken(client);
    console.log(`Authenticated as: ${info.login}`);
    console.log(`Token scopes:     ${info.scopes.join(", ") || "(none reported — likely fine-grained PAT)"}`);
    console.log(`GHES version:     ${info.ghesVersion ?? "github.com"}`);
    console.log(`Base URL:         ${cfg.github.baseUrl}`);
    console.log(`Cache path:       ${resolveCachePath(cfg.cache.path)}`);

    if (cfg.output.formats.includes("pdf")) {
      try {
        await import("puppeteer");
        console.log(`Puppeteer:        available (PDF output ready)`);
      } catch {
        console.log(`Puppeteer:        MISSING — install with \`pnpm add puppeteer\` for PDF output`);
      }
    }
  },
});

const main = defineCommand({
  meta: {
    name: "shipreport",
    version: "0.1.0",
    description: "Quarterly engineering success story generator.",
  },
  subCommands: { run, preview, cache: cacheCmd, doctor },
});

runMain(main);
