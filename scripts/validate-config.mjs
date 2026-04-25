#!/usr/bin/env node
/**
 * Pure-validation entry point: parses a shipreport.yaml against the schema
 * and per-team cron strings WITHOUT touching the network or requiring auth.
 *
 * Used by .github/workflows/validate-config.yml so PR-time checks can run
 * with zero secrets. Exits non-zero on any schema or cron error so the PR
 * status correctly fails.
 */
import { loadConfig } from "../dist/config.js";
import { parseCron } from "../dist/schedule.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: validate-config.mjs <path-to-shipreport.yaml>");
  process.exit(2);
}

try {
  const cfg = await loadConfig(file);
  console.log(`OK — ${cfg.teams.length} team(s) parsed against schema.`);
  for (const t of cfg.teams) {
    if (t.schedule) {
      try {
        parseCron(t.schedule);
        console.log(`  team=${t.name} cron='${t.schedule}' OK`);
      } catch (err) {
        console.error(`  team=${t.name} cron='${t.schedule}' FAILED: ${err.message}`);
        process.exitCode = 1;
      }
    } else {
      console.log(`  team=${t.name} no schedule (manual-only)`);
    }
    if (!t.members && !t.autoMembers) {
      console.log(
        `  team=${t.name} note: no explicit 'members' and no 'autoMembers' — runtime will fall back to auto-discovery defaults.`,
      );
    }
  }
  if (process.exitCode) process.exit(process.exitCode);
} catch (err) {
  console.error(`Validation failed: ${err.message}`);
  process.exit(1);
}
