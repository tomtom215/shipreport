import type { Config } from "./config.js";
import type { PRKind, RawPR } from "./types.js";

const CC = /^(?<kind>feat|fix|refactor|docs|chore|ci|build|perf|test)(\([^)]+\))?!?:/i;

export type ClassificationConfig = Config["classification"];

export function classifyPR(pr: RawPR, cfg: ClassificationConfig): PRKind {
  const labels = new Set(pr.labels.map((l) => l.name.toLowerCase()));

  if (cfg.bugfixLabels.some((l) => labels.has(l.toLowerCase()))) return "bugfix";
  if (cfg.featureLabels.some((l) => labels.has(l.toLowerCase()))) return "feature";
  if (cfg.infraLabels.some((l) => labels.has(l.toLowerCase()))) return "infra";
  if (cfg.docsLabels.some((l) => labels.has(l.toLowerCase()))) return "docs";

  const m = CC.exec(pr.title);
  if (m?.groups?.kind) {
    const k = m.groups.kind.toLowerCase();
    if (k === "feat") return "feature";
    if (k === "fix") return "bugfix";
    if (k === "refactor" || k === "perf") return "refactor";
    if (k === "docs") return "docs";
    if (k === "ci" || k === "build" || k === "chore") return "infra";
  }

  return "other";
}
