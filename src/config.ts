import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { QuarterRange } from "./types.js";

const QuarterLabel = z.string().regex(/^\d{4}Q[1-4]$/);

const DateRange = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const ConfigSchema = z.object({
  github: z.object({
    baseUrl: z.string().url().default("https://api.github.com"),
    graphqlUrl: z.string().url().default("https://api.github.com/graphql"),
    tokenEnv: z.string().default("SHIPREPORT_GITHUB_TOKEN"),
  }),
  org: z.string().min(1),
  repos: z.array(z.string().regex(/^[^/]+\/[^/]+$/)).min(1),
  quarter: z.union([QuarterLabel, DateRange]),
  timezone: z.string().default("UTC"),
  team: z.object({
    manager: z.string().min(1),
    members: z.array(z.string().min(1)).min(1),
  }),
  classification: z
    .object({
      bugfixLabels: z.array(z.string()).default(["bug", "hotfix", "p0", "p1"]),
      featureLabels: z.array(z.string()).default(["feature", "enhancement"]),
      infraLabels: z.array(z.string()).default(["ci", "build", "devops", "infra"]),
      docsLabels: z.array(z.string()).default(["docs", "documentation"]),
    })
    .default({
      bugfixLabels: ["bug", "hotfix", "p0", "p1"],
      featureLabels: ["feature", "enhancement"],
      infraLabels: ["ci", "build", "devops", "infra"],
      docsLabels: ["docs", "documentation"],
    }),
  output: z
    .object({
      dir: z.string().default("./out"),
      formats: z.array(z.enum(["md", "html", "pdf"])).default(["md", "html"]),
      perDev: z.boolean().default(true),
      teamSummary: z.boolean().default(true),
      managerRollup: z.boolean().default(true),
    })
    .default({
      dir: "./out",
      formats: ["md", "html"],
      perDev: true,
      teamSummary: true,
      managerRollup: true,
    }),
  cache: z
    .object({
      path: z.string().default("~/.cache/shipreport/cache.sqlite"),
      ttlDays: z.number().int().positive().default(7),
    })
    .default({ path: "~/.cache/shipreport/cache.sqlite", ttlDays: 7 }),
});

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(file: string): Promise<Config> {
  const raw = await readFile(file, "utf8");
  const parsed = parseYaml(raw);
  return ConfigSchema.parse(parsed);
}

export function resolveCachePath(p: string): string {
  if (p.startsWith("~")) return path.join(homedir(), p.slice(1));
  return path.resolve(p);
}

export function resolveQuarter(q: Config["quarter"], tz: string): QuarterRange {
  if (typeof q === "string") return quarterLabelToRange(q, tz);
  return { label: `${q.from}..${q.to}`, from: q.from, to: q.to };
}

export function quarterLabelToRange(label: string, _tz: string): QuarterRange {
  const m = /^(\d{4})Q([1-4])$/.exec(label);
  if (!m) throw new Error(`bad quarter label: ${label}`);
  const year = Number(m[1]);
  const qi = Number(m[2]);
  const startMonth = (qi - 1) * 3;
  const endMonth = startMonth + 3;
  const from = new Date(Date.UTC(year, startMonth, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(year, endMonth, 0)).toISOString().slice(0, 10);
  return { label, from, to };
}

export function requireToken(cfg: Config): string {
  const tok = process.env[cfg.github.tokenEnv];
  if (!tok) {
    throw new Error(
      `GitHub token not set. Export ${cfg.github.tokenEnv} in your environment (fine-grained PAT with contents:read, issues:read, pull-requests:read, metadata:read, members:read).`,
    );
  }
  return tok;
}

// Redacts tokens for `shipreport config print`. Never dump the live env value.
export function redactedConfig(cfg: Config): Config {
  return {
    ...cfg,
    github: { ...cfg.github, tokenEnv: cfg.github.tokenEnv },
  };
}
