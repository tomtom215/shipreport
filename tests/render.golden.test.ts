import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDev, renderManagerRollup, renderTeamSummary } from "../src/render.js";
import type { DevQuarter, TeamQuarter } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

const QUARTER = { label: "2026Q1", from: "2026-01-01", to: "2026-03-31" };
const CTX = { version: "0.1.0", generatedAt: "2026-04-01T00:00:00.000Z" };

async function loadDev(): Promise<DevQuarter> {
  const raw = await readFile(path.join(FIXTURES, "golden-dev.json"), "utf8");
  return JSON.parse(raw) as DevQuarter;
}

function teamOf(dev: DevQuarter): TeamQuarter {
  return {
    quarter: QUARTER,
    manager: "jdoe",
    members: [dev],
    totals: {
      prsMerged: dev.prsMerged,
      reviewsGiven: dev.reviewsGiven,
      reposTouched: dev.crossRepoCollaboration,
      issuesClosed: dev.linkedIssuesClosed.length,
    },
    dataGaps: [],
  };
}

async function checkGolden(name: string, actual: string): Promise<void> {
  const goldenPath = path.join(FIXTURES, name);
  if (UPDATE) {
    await writeFile(goldenPath, actual, "utf8");
    return;
  }
  const expected = await readFile(goldenPath, "utf8");
  expect(actual).toBe(expected);
}

describe("golden renders", () => {
  it("success story is byte-identical to the checked-in golden", async () => {
    const dev = await loadDev();
    const team = teamOf(dev);
    const md = await renderDev(dev, QUARTER, team, CTX);
    await checkGolden("success-story.md", md);
  });

  it("team summary is byte-identical", async () => {
    const dev = await loadDev();
    const team = teamOf(dev);
    const md = await renderTeamSummary(team, CTX);
    await checkGolden("team-summary.md", md);
  });

  it("manager rollup is byte-identical", async () => {
    const dev = await loadDev();
    const team = teamOf(dev);
    const md = await renderManagerRollup(team, CTX);
    await checkGolden("manager-rollup.md", md);
  });
});
