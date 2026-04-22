import { classifyPR } from "./classify.js";
import type { ClassificationConfig } from "./classify.js";
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

export function toPRSummary(pr: RawPR, cfg: ClassificationConfig): PRSummary {
  const reviewers = Array.from(
    new Set(pr.reviews.filter((r) => r.user !== pr.author).map((r) => r.user)),
  );
  return {
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    mergedAt: pr.mergedAt ?? "",
    author: pr.author,
    reviewers,
    linkedIssues: pr.linkedIssues.map((i) => `${i.repo}#${i.number}`),
    body: pr.body,
    labels: pr.labels.map((l) => l.name),
    milestone: pr.milestone?.title ?? null,
    kind: classifyPR(pr, cfg),
    reviewCount: pr.reviews.length,
    commentCount: pr.comments,
    filesChanged: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
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

export function aggregateDev(
  login: string,
  prs: RawPR[],
  classification: ClassificationConfig,
): DevQuarter {
  const authored = prs.filter((p) => p.author === login && p.mergedAt);
  const summaries = authored.map((p) => toPRSummary(p, classification));

  const kinds = emptyKinds();
  let filesTouched = 0;
  const repos = new Set<string>();
  const milestones = new Set<string>();
  const issues: IssueRef[] = [];
  const seenIssue = new Set<string>();
  let reviewsOnOwn = 0;

  for (const raw of authored) {
    filesTouched += raw.changedFiles;
    repos.add(raw.repo);
    if (raw.milestone?.title) milestones.add(raw.milestone.title);
    reviewsOnOwn += raw.reviews.filter((r) => r.user !== login && r.state === "APPROVED").length;
    for (const li of raw.linkedIssues) {
      const key = `${li.repo}#${li.number}`;
      if (!seenIssue.has(key)) {
        seenIssue.add(key);
        issues.push(li);
      }
    }
  }
  for (const s of summaries) kinds[s.kind] += 1;

  let reviewsGiven = 0;
  for (const p of prs) {
    if (p.author === login) continue;
    for (const r of p.reviews) {
      if (r.user === login) reviewsGiven += 1;
    }
  }

  const topPRs = [...summaries].sort(byRankThenNumber).slice(0, 3);

  return {
    login,
    displayName: login,
    prsMerged: summaries.length,
    prsByKind: kinds,
    filesTouched,
    reviewsGiven,
    reviewsOnOwnPRs: reviewsOnOwn,
    crossRepoCollaboration: repos.size,
    topPRs,
    shippedMilestones: [...milestones].sort(),
    linkedIssuesClosed: issues.sort((a, b) =>
      a.repo === b.repo ? a.number - b.number : a.repo < b.repo ? -1 : 1,
    ),
  };
}

export interface AggregateScope {
  manager: string;
  members: string[];
  repos: string[];
  classification: ClassificationConfig;
}

export function buildTeamQuarter(
  scope: AggregateScope,
  quarter: QuarterRange,
  prsByRepo: Map<string, RawPR[]>,
  gaps: TeamQuarter["dataGaps"],
): TeamQuarter {
  const allPRs = [...prsByRepo.values()].flat();
  const members = scope.members.map((login) =>
    aggregateDev(login, allPRs, scope.classification),
  );

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
      prsMerged,
      reviewsGiven,
      reposTouched: repoSet.size || scope.repos.length,
      issuesClosed: issueSet.size,
    },
    dataGaps: gaps,
  };
}
