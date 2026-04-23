/**
 * Pure parsers for signals that live in PR prose (body, title, merge commit).
 *
 * These do not touch I/O or GraphQL; they take strings and return structured
 * data so that extract.ts can stay focused on transport and transform.ts can
 * stay focused on aggregation.
 */

import type { IssueRef } from "./types.js";

const CLOSE_VERBS = "(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)";
// Same-repo form: "Fixes #123"; cross-repo form: "Closes owner/repo#123".
const LINKED_ISSUE_RE = new RegExp(
  `\\b${CLOSE_VERBS}\\s+(?:([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+))?#(\\d+)\\b`,
  "gi",
);

export interface BodyIssueRef {
  repo: string | null; // null → same repo as the PR
  number: number;
}

/**
 * Scan a PR body for "Fixes #N" / "Closes owner/repo#N" style references.
 * GitHub resolves these at close time via closingIssuesReferences, but we
 * still need a fallback for PRs where GraphQL returned nothing (older PRs,
 * cross-repo refs that never resolved, or bodies with non-canonical links).
 */
export function parseBodyIssueRefs(body: string): BodyIssueRef[] {
  if (!body) return [];
  const out: BodyIssueRef[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(LINKED_ISSUE_RE)) {
    const owner = m[1];
    const name = m[2];
    const num = Number(m[3]);
    if (!Number.isFinite(num)) continue;
    const repo = owner && name ? `${owner}/${name}` : null;
    const key = `${repo ?? ""}#${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, number: num });
  }
  return out;
}

/**
 * Merge body-sourced refs into an existing list from GraphQL, deduping by
 * repo#number. `prRepo` is the PR's own repo (used to resolve bare "#N").
 */
export function mergeLinkedIssues(
  fromGraphql: IssueRef[],
  fromBody: BodyIssueRef[],
  prRepo: string,
): IssueRef[] {
  const seen = new Set(fromGraphql.map((r) => `${r.repo}#${r.number}`));
  const out = [...fromGraphql];
  for (const b of fromBody) {
    const repo = b.repo ?? prRepo;
    const key = `${repo}#${b.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, number: b.number, title: "", url: "", closedAt: null });
  }
  return out;
}

const TRAILER_RE = /^Co-authored-by:\s*(?:([^<]+?)\s+)?<([^>]+)>\s*$/gim;

export interface CoAuthor {
  /** Best-effort display name; may equal email if no display name was given. */
  name: string;
  email: string;
}

/**
 * Parse Co-authored-by: trailers from a commit message body. Matches the
 * standard Git trailer form used by GitHub's "co-authored commit" feature.
 */
export function parseCoAuthors(commitMessage: string | null | undefined): CoAuthor[] {
  if (!commitMessage) return [];
  const out: CoAuthor[] = [];
  const seen = new Set<string>();
  for (const m of commitMessage.matchAll(TRAILER_RE)) {
    const email = m[2]!.trim().toLowerCase();
    const name = (m[1] ?? "").trim() || email;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ name, email });
  }
  return out;
}

/**
 * Map a co-author email to a GitHub login when possible. GitHub sets the
 * "noreply" email to `<id>+<login>@users.noreply.github.com` for users who
 * hide their real email. That is the only mapping we can do without an
 * extra API call, so other emails fall back to null and the caller decides.
 */
export function coAuthorLoginFromEmail(email: string): string | null {
  const m = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i.exec(email);
  return m ? m[1]!.toLowerCase() : null;
}

const REVERT_TITLE_RE =
  /^\s*revert\b\s*[:!]|^\s*revert\s+"|\breverts?\s+(?:pr\s+)?#(\d+)\b|\breverts?\s+(?:commit\s+)?[0-9a-f]{7,40}\b/i;
const REVERTS_NUMBER_RE = /\breverts?\s+(?:pr\s+)?#(\d+)\b/i;
// GitHub's default UI-generated revert title is: Revert "<original title>" (#N)
const REVERT_DEFAULT_RE = /^\s*Revert\s+"(.+)"\s*\(#(\d+)\)\s*$/;

export interface RevertInfo {
  /** PR number that was reverted, if we could extract it. */
  revertedNumber: number | null;
}

export function detectRevert(title: string, body: string): RevertInfo | null {
  if (REVERT_DEFAULT_RE.test(title)) {
    const m = REVERT_DEFAULT_RE.exec(title)!;
    return { revertedNumber: Number(m[2]) };
  }
  if (REVERT_TITLE_RE.test(title)) {
    const m = REVERTS_NUMBER_RE.exec(title);
    if (m) return { revertedNumber: Number(m[1]) };
    const b = body ? REVERTS_NUMBER_RE.exec(body) : null;
    return { revertedNumber: b ? Number(b[1]) : null };
  }
  if (body) {
    const m = REVERTS_NUMBER_RE.exec(body);
    if (m && /^reverts?\b/i.test(body.trim())) {
      return { revertedNumber: Number(m[1]) };
    }
  }
  return null;
}
