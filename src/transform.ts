import { classifyPR } from "./classify.js";
import type { ClassificationConfig } from "./classify.js";
import {
  detectRevert,
  mergeLinkedIssues,
  parseBodyIssueRefs,
} from "./pr-parse.js";
import type {
  DevQuarter,
  IssueRef,
  PRKind,
  PRSummary,
  QuarterRange,
  RawPR,
  TeamQuarter,
} from "./types.js";

function emptyKinds(): Record<PRKind, number> {
  return { feature: 0, bugfix: 0, refactor: 0, docs: 0, infra: 0, other: 0 };
}

export type CoAuthorCredit = "full" | "split";

export interface TransformOptions {
  classification: ClassificationConfig;
  coAuthorCredit: CoAuthorCredit;
}

/** Substantive review = non-COMMENTED state, or COMMENTED with inline replies. */
export function isSubstantiveReview(r: RawPR["reviews"][number]): boolean {
  if (r.state !== "COMMENTED") return true;
  return (r.inlineCommentCount ?? 0) > 0;
}

export function toPRSummary(pr: RawPR, cfg: ClassificationConfig): PRSummary {
  const mergedIssues = mergeLinkedIssues(pr.linkedIssues, parseBodyIssueRefs(pr.body), pr.repo);
  const reviewersSet = new Set(
    pr.reviews.filter((r) => r.user !== pr.author).map((r) => r.user),
  );
  const substantiveReviewers = new Set(
    pr.reviews.filter((r) => r.user !== pr.author && isSubstantiveReview(r)).map((r) => r.user),
  );
  const revert = detectRevert(pr.title, pr.body);
  return {
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    mergedAt: pr.mergedAt ?? "",
    author: pr.author,
    coAuthors: [...pr.coAuthors],
    reviewers: [...reviewersSet],
    linkedIssues: mergedIssues.map((i) => `${i.repo}#${i.number}`),
    body: pr.body,
    labels: pr.labels.map((l) => l.name),
    milestone: pr.milestone?.title ?? null,
    kind: classifyPR(pr, cfg),
    reviewEventsCount: pr.reviews.length,
    reviewCount: substantiveReviewers.size,
    commentCount: pr.comments,
    filesChanged: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    isRevert: revert !== null,
    revert:
      revert && revert.revertedNumber !== null
        ? { repo: pr.repo, number: revert.revertedNumber }
        : null,
  };
}

function rankScore(p: PRSummary): number {
  return p.reviewCount * 3 + p.commentCount + p.linkedIssues.length * 2;
}

function byRankThenNumber(a: PRSummary, b: PRSummary): number {
  const d = rankScore(b) - rankScore(a);
  if (d !== 0) return d;
  if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
  return a.number - b.number;
}

/** Return everyone credited for a PR (author + co-authors, deduped). */
export function creditedContributors(pr: RawPR): string[] {
  const out = new Set<string>();
  if (pr.author) out.add(pr.author);
  for (const c of pr.coAuthors) if (c !== pr.author) out.add(c);
  return [...out];
}

function creditShare(contributors: number, mode: CoAuthorCredit): number {
  if (mode === "split" && contributors > 0) return 1 / contributors;
  return 1;
}

/** Map each PR to the reverted-original key `${repo}#${number}`, when applicable. */
function revertTargets(prs: RawPR[]): Map<string, RawPR> {
  const m = new Map<string, RawPR>();
  for (const pr of prs) {
    const info = detectRevert(pr.title, pr.body);
    if (info && info.revertedNumber !== null) {
      m.set(`${pr.repo}#${info.revertedNumber}`, pr);
    }
  }
  return m;
}

export function aggregateDev(
  login: string,
  prs: RawPR[],
  opts: TransformOptions,
): DevQuarter {
  const share = (pr: RawPR): number =>
    creditShare(creditedContributors(pr).length, opts.coAuthorCredit);

  const credited = prs.filter((p) => p.mergedAt && creditedContributors(p).includes(login));
  const summaries = credited.map((p) => toPRSummary(p, opts.classification));

  const reverts = revertTargets(prs);

  const kinds = emptyKinds();
  let prsMerged = 0;
  let filesTouched = 0;
  let revertsAuthored = 0;
  let revertsReceived = 0;
  const repos = new Set<string>();
  const milestones = new Set<string>();
  const issues: IssueRef[] = [];
  const seenIssue = new Set<string>();
  let reviewsOnOwn = 0;

  for (let i = 0; i < credited.length; i++) {
    const raw = credited[i]!;
    const s = summaries[i]!;
    const w = share(raw);
    prsMerged += w;
    filesTouched += raw.changedFiles * w;
    kinds[s.kind] += w;
    if (s.isRevert) revertsAuthored += w;
    repos.add(raw.repo);
    if (raw.milestone?.title) milestones.add(raw.milestone.title);
    reviewsOnOwn += raw.reviews.filter(
      (r) => r.user !== login && r.state === "APPROVED",
    ).length;

    for (const li of s.linkedIssues) {
      if (!seenIssue.has(li)) {
        seenIssue.add(li);
        // Find the full IssueRef for this key from the merged list.
        const merged = mergeLinkedIssues(raw.linkedIssues, parseBodyIssueRefs(raw.body), raw.repo);
        const match = merged.find((m) => `${m.repo}#${m.number}` === li);
        if (match) issues.push(match);
      }
    }

    // Did a revert in THIS window undo one of this dev's PRs?
    const revertOfMine = reverts.get(`${raw.repo}#${raw.number}`);
    if (revertOfMine && raw.author === login) {
      revertsReceived += 1;
      // Subtract the reverted PR from the original author's prsMerged.
      prsMerged -= w;
      filesTouched -= raw.changedFiles * w;
      kinds[s.kind] -= w;
    }
  }

  let reviewsGiven = 0;
  let reviewEventsGiven = 0;
  for (const p of prs) {
    if (p.author === login) continue;
    const seenSubstantive = new Set<string>();
    for (const r of p.reviews) {
      if (r.user !== login) continue;
      reviewEventsGiven += 1;
      if (isSubstantiveReview(r) && !seenSubstantive.has(p.repo + "#" + p.number)) {
        seenSubstantive.add(p.repo + "#" + p.number);
        reviewsGiven += 1;
      }
    }
  }

  const topPRs = [...summaries].sort(byRankThenNumber).slice(0, 3);

  return {
    login,
    displayName: login,
    prsMerged: roundCredit(prsMerged),
    prsByKind: roundKinds(kinds),
    revertsAuthored: roundCredit(revertsAuthored),
    revertsReceived,
    filesTouched: roundCredit(filesTouched),
    reviewsGiven,
    reviewEventsGiven,
    reviewsOnOwnPRs: reviewsOnOwn,
    crossRepoCollaboration: repos.size,
    topPRs,
    shippedMilestones: [...milestones].sort(),
    linkedIssuesClosed: issues.sort((a, b) =>
      a.repo === b.repo ? a.number - b.number : a.repo < b.repo ? -1 : 1,
    ),
  };
}

/** Keep totals presentable: integers where exact, one decimal when fractional. */
function roundCredit(n: number): number {
  if (n < 0) return 0;
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? rounded : rounded;
}

function roundKinds(k: Record<PRKind, number>): Record<PRKind, number> {
  const out = emptyKinds();
  for (const key of Object.keys(k) as PRKind[]) out[key] = roundCredit(k[key]);
  return out;
}

export interface AggregateScope {
  manager: string;
  members: string[];
  repos: string[];
  classification: ClassificationConfig;
  coAuthorCredit: CoAuthorCredit;
}

export function buildTeamQuarter(
  scope: AggregateScope,
  quarter: QuarterRange,
  prsByRepo: Map<string, RawPR[]>,
  gaps: TeamQuarter["dataGaps"],
): TeamQuarter {
  const allPRs = [...prsByRepo.values()].flat();
  const opts: TransformOptions = {
    classification: scope.classification,
    coAuthorCredit: scope.coAuthorCredit,
  };
  const members = scope.members.map((login) => aggregateDev(login, allPRs, opts));

  const repoSet = new Set<string>();
  const issueSet = new Set<string>();
  let prsMerged = 0;
  let reviewsGiven = 0;
  for (const m of members) {
    prsMerged += m.prsMerged;
    reviewsGiven += m.reviewsGiven;
    for (const p of m.topPRs) repoSet.add(p.repo);
    for (const i of m.linkedIssuesClosed) issueSet.add(`${i.repo}#${i.number}`);
  }

  return {
    quarter,
    manager: scope.manager,
    members,
    totals: {
      prsMerged: roundCredit(prsMerged),
      reviewsGiven,
      reposTouched: repoSet.size || scope.repos.length,
      issuesClosed: issueSet.size,
    },
    dataGaps: gaps,
  };
}
