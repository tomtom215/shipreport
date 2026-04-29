import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { QuarterRange } from "./types.js";
import { dateRangeToQuarter, quarterLabelToRange as tzQuarterLabelToRange } from "./tz.js";

const QuarterLabel = z.string().regex(/^\d{4}Q[1-4]$/);

// String comparison on `YYYY-MM-DD` is correct lexicographically because
// the regex above pins a fixed-width zero-padded form. We reject `from`
// strictly after `to` (equality is allowed: a single-day range is still
// well-formed). Empty windows would resolve to zero PRs at extract time
// without any diagnostic, which is exactly the silent failure mode this
// refinement exists to prevent — see docs/08-dry-run.md / 13.
const DateRange = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((r) => r.from <= r.to, {
    message: "quarter date range: `from` must be on or before `to`",
    path: ["from"],
  });

const Classification = z.object({
  bugfixLabels: z.array(z.string()).default(["bug", "hotfix", "p0", "p1"]),
  featureLabels: z.array(z.string()).default(["feature", "enhancement"]),
  infraLabels: z.array(z.string()).default(["ci", "build", "devops", "infra"]),
  docsLabels: z.array(z.string()).default(["docs", "documentation"]),
});

export const CO_AUTHOR_CREDIT = ["full", "split"] as const;
const CoAuthorCredit = z.enum(CO_AUTHOR_CREDIT).default("full");

const Output = z.object({
  dir: z.string().default("./out"),
  formats: z.array(z.enum(["md", "html", "pdf", "png"])).default(["md", "html"]),
  perDev: z.boolean().default(true),
  teamSummary: z.boolean().default(true),
  managerRollup: z.boolean().default(true),
});

const GithubApp = z.object({
  appId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  privateKeyEnv: z.string().optional(),
  privateKeyPath: z.string().optional(),
  installationId: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .optional(),
  clientId: z.string().optional(),
});

const Github = z.object({
  baseUrl: z.string().url().default("https://api.github.com"),
  graphqlUrl: z.string().url().default("https://api.github.com/graphql"),
  tokenEnv: z.string().default("SHIPREPORT_GITHUB_TOKEN"),
  app: GithubApp.optional(),
});

const AutoMembers = z.object({
  limit: z.number().int().positive().default(10),
  excludeBots: z.boolean().default(true),
  excludeLogins: z.array(z.string()).default([]),
});

const Team = z.object({
  name: z.string().min(1),
  manager: z.string().min(1),
  // Omit `members` to auto-discover from merged-PR authors in the team's
  // repos for the target quarter (top `autoMembers.limit`, bots filtered).
  members: z.array(z.string().min(1)).min(1).optional(),
  autoMembers: AutoMembers.optional(),
  repos: z.array(z.string().regex(/^[^/]+\/[^/]+$/)).min(1),
  quarter: z.union([QuarterLabel, DateRange]).optional(),
  schedule: z.string().optional(),
  output: Output.partial().optional(),
  classification: Classification.partial().optional(),
});

const Audit = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default("~/.local/share/shipreport/state.sqlite"),
  signingKeyPath: z.string().default("~/.config/shipreport/audit-ed25519.pem"),
  signer: z.string().default("shipreport"),
});

const Cache = z.object({
  path: z.string().default("~/.cache/shipreport/cache.sqlite"),
  ttlDays: z.number().int().positive().default(7),
});

const Extract = z.object({
  /** Max concurrent per-repo GraphQL fetches (default 4). */
  concurrency: z.number().int().positive().max(32).default(4),
  /**
   * GraphQL quota floor at which we degrade to serial work and extend
   * backoff. Default 100 leaves a comfortable margin over the typical
   * per-request cost (~1) while keeping a safety net for big extracts.
   */
  rateLimitThreshold: z.number().int().positive().default(100),
});

// Full (new) shape.
const MultiTeamShape = z.object({
  github: Github.default({
    baseUrl: "https://api.github.com",
    graphqlUrl: "https://api.github.com/graphql",
    tokenEnv: "SHIPREPORT_GITHUB_TOKEN",
  }),
  org: z.string().min(1),
  teams: z.array(Team).min(1),
  defaults: z
    .object({
      quarter: z.union([QuarterLabel, DateRange]).optional(),
      timezone: z.string().default("UTC"),
      coAuthorCredit: CoAuthorCredit,
      output: Output.default({
        dir: "./out",
        formats: ["md", "html"],
        perDev: true,
        teamSummary: true,
        managerRollup: true,
      }),
      classification: Classification.default({
        bugfixLabels: ["bug", "hotfix", "p0", "p1"],
        featureLabels: ["feature", "enhancement"],
        infraLabels: ["ci", "build", "devops", "infra"],
        docsLabels: ["docs", "documentation"],
      }),
    })
    .default({
      timezone: "UTC",
      coAuthorCredit: "full",
      output: {
        dir: "./out",
        formats: ["md", "html"],
        perDev: true,
        teamSummary: true,
        managerRollup: true,
      },
      classification: {
        bugfixLabels: ["bug", "hotfix", "p0", "p1"],
        featureLabels: ["feature", "enhancement"],
        infraLabels: ["ci", "build", "devops", "infra"],
        docsLabels: ["docs", "documentation"],
      },
    }),
  audit: Audit.default({
    enabled: true,
    path: "~/.local/share/shipreport/state.sqlite",
    signingKeyPath: "~/.config/shipreport/audit-ed25519.pem",
    signer: "shipreport",
  }),
  cache: Cache.default({ path: "~/.cache/shipreport/cache.sqlite", ttlDays: 7 }),
  extract: Extract.default({ concurrency: 4, rateLimitThreshold: 100 }),
});

// Legacy (v0.1) single-team shape — still accepted; normalized to multi-team.
const LegacyShape = z.object({
  github: Github.default({
    baseUrl: "https://api.github.com",
    graphqlUrl: "https://api.github.com/graphql",
    tokenEnv: "SHIPREPORT_GITHUB_TOKEN",
  }),
  org: z.string().min(1),
  repos: z.array(z.string().regex(/^[^/]+\/[^/]+$/)).min(1),
  quarter: z.union([QuarterLabel, DateRange]),
  timezone: z.string().default("UTC"),
  team: z.object({
    manager: z.string().min(1),
    members: z.array(z.string().min(1)).min(1),
  }),
  classification: Classification.default({
    bugfixLabels: ["bug", "hotfix", "p0", "p1"],
    featureLabels: ["feature", "enhancement"],
    infraLabels: ["ci", "build", "devops", "infra"],
    docsLabels: ["docs", "documentation"],
  }),
  output: Output.default({
    dir: "./out",
    formats: ["md", "html"],
    perDev: true,
    teamSummary: true,
    managerRollup: true,
  }),
  audit: Audit.default({
    enabled: true,
    path: "~/.local/share/shipreport/state.sqlite",
    signingKeyPath: "~/.config/shipreport/audit-ed25519.pem",
    signer: "shipreport",
  }),
  cache: Cache.default({ path: "~/.cache/shipreport/cache.sqlite", ttlDays: 7 }),
  extract: Extract.default({ concurrency: 4, rateLimitThreshold: 100 }),
});

export type Config = z.infer<typeof MultiTeamShape>;
export type TeamConfig = z.infer<typeof Team>;
export type AuditConfig = z.infer<typeof Audit>;

export async function loadConfig(file: string): Promise<Config> {
  const raw = await readFile(file, "utf8");
  const parsed = parseYaml(raw);
  return normalize(parsed);
}

// Exported for tests.
export function normalize(raw: unknown): Config {
  // Try multi-team first; fall back to legacy.
  const asMulti = MultiTeamShape.safeParse(raw);
  if (asMulti.success) return asMulti.data;

  const asLegacy = LegacyShape.safeParse(raw);
  if (asLegacy.success) return legacyToMulti(asLegacy.data);

  // Re-run multi-team to produce the primary error (more informative).
  throw new Error(
    `Invalid shipreport config:\n${asMulti.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n")}`,
  );
}

function legacyToMulti(l: z.infer<typeof LegacyShape>): Config {
  return {
    github: l.github,
    org: l.org,
    teams: [
      {
        name: l.team.manager + "-team",
        manager: l.team.manager,
        members: l.team.members,
        repos: l.repos,
      },
    ],
    defaults: {
      quarter: l.quarter,
      timezone: l.timezone,
      coAuthorCredit: "full",
      output: l.output,
      classification: l.classification,
    },
    audit: l.audit,
    cache: l.cache,
    extract: { concurrency: 4, rateLimitThreshold: 100 },
  };
}

export function resolveHome(p: string): string {
  if (p.startsWith("~")) return path.join(homedir(), p.slice(1));
  return path.resolve(p);
}

// Back-compat alias.
export const resolveCachePath = resolveHome;

export function resolveQuarter(
  q: Config["defaults"]["quarter"] | TeamConfig["quarter"],
  tz: string,
): QuarterRange {
  if (!q) throw new Error("No quarter specified (team or defaults.quarter).");
  if (typeof q === "string") return tzQuarterLabelToRange(q, tz);
  return dateRangeToQuarter(q.from, q.to, tz);
}

// Re-export for callers that used the old name. Signature unchanged.
export { quarterLabelToRange } from "./tz.js";

export interface ResolvedTeam {
  name: string;
  manager: string;
  /** null when auto-discovery is requested; populated after extraction. */
  members: string[] | null;
  autoMembers: z.infer<typeof AutoMembers>;
  repos: string[];
  quarter: QuarterRange;
  schedule: string | null;
  output: z.infer<typeof Output>;
  classification: z.infer<typeof Classification>;
  coAuthorCredit: z.infer<typeof CoAuthorCredit>;
}

export function resolveTeam(cfg: Config, team: TeamConfig): ResolvedTeam {
  const tz = cfg.defaults.timezone;
  const quarter = resolveQuarter(team.quarter ?? cfg.defaults.quarter, tz);
  const output = Output.parse({ ...cfg.defaults.output, ...(team.output ?? {}) });
  const classification = Classification.parse({
    ...cfg.defaults.classification,
    ...(team.classification ?? {}),
  });
  const autoMembers = AutoMembers.parse(team.autoMembers ?? {});
  return {
    name: team.name,
    manager: team.manager,
    members: team.members ?? null,
    autoMembers,
    repos: team.repos,
    quarter,
    schedule: team.schedule ?? null,
    output,
    classification,
    coAuthorCredit: cfg.defaults.coAuthorCredit,
  };
}

export function selectTeams(cfg: Config, name: string | undefined): TeamConfig[] {
  if (!name) return cfg.teams;
  const matches = cfg.teams.filter((t) => t.name === name);
  if (matches.length === 0) {
    throw new Error(
      `No team named "${name}". Known teams: ${cfg.teams.map((t) => t.name).join(", ")}.`,
    );
  }
  return matches;
}
