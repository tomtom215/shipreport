import type { RawPR } from "./types.js";

/**
 * Auto-discover team members from merged-PR activity.
 *
 * When a team's config omits `members:`, we rank distinct PR authors by
 * merged-PR count across the team's repos for the target quarter and take
 * the top N. Bots are filtered by default — GitHub Apps surface as authors
 * ending in "[bot]", and common CI/automation logins are in BUILTIN_BOTS.
 *
 * Ties in merged-PR count are broken by login (alphabetical) for
 * determinism — same inputs always produce the same team.
 */

export interface DiscoverOptions {
  limit: number;
  excludeBots: boolean;
  excludeLogins: string[];
}

export const DEFAULT_DISCOVER: DiscoverOptions = {
  limit: 10,
  excludeBots: true,
  excludeLogins: [],
};

const BUILTIN_BOTS = new Set([
  "dependabot",
  "dependabot-preview",
  "renovate",
  "renovate-bot",
  "mergify",
  "pre-commit-ci",
  "github-actions",
  "ghost",
  "release-please",
  "imgbot",
  "snyk-bot",
  "allcontributors",
  "codecov-commenter",
  "stale",
  "copybara-service",
]);

export interface DiscoveryResult {
  members: string[];
  considered: number;
  skippedBots: string[];
  rankings: Array<{ login: string; mergedPRs: number }>;
}

export function discoverMembers(prs: RawPR[], opts: DiscoverOptions = DEFAULT_DISCOVER): DiscoveryResult {
  const counts = new Map<string, number>();
  const skippedBots = new Set<string>();
  const excludeLogins = new Set(opts.excludeLogins.map((s) => s.toLowerCase()));

  for (const pr of prs) {
    if (!pr.mergedAt) continue;
    const login = pr.author;
    if (!login || login === "ghost") continue;

    if (opts.excludeBots && isBot(login)) {
      skippedBots.add(login);
      continue;
    }
    if (excludeLogins.has(login.toLowerCase())) continue;

    counts.set(login, (counts.get(login) ?? 0) + 1);
  }

  const rankings = [...counts.entries()]
    .map(([login, mergedPRs]) => ({ login, mergedPRs }))
    .sort((a, b) => {
      if (b.mergedPRs !== a.mergedPRs) return b.mergedPRs - a.mergedPRs;
      return a.login < b.login ? -1 : a.login > b.login ? 1 : 0;
    });

  return {
    members: rankings.slice(0, opts.limit).map((r) => r.login),
    considered: counts.size,
    skippedBots: [...skippedBots].sort(),
    rankings,
  };
}

export function isBot(login: string): boolean {
  const l = login.toLowerCase();
  if (BUILTIN_BOTS.has(l)) return true;
  if (l.endsWith("[bot]")) return true;
  if (l.endsWith("-bot")) return true;
  if (l.endsWith("-robot")) return true;
  return false;
}
