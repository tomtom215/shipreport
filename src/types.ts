export type PRKind = "feature" | "bugfix" | "refactor" | "docs" | "infra" | "other";

export interface PRSummary {
  repo: string;
  number: number;
  url: string;
  title: string;
  mergedAt: string;
  author: string;
  /** Co-author logins credited via Co-authored-by: trailers. */
  coAuthors: string[];
  reviewers: string[];
  linkedIssues: string[];
  body: string;
  labels: string[];
  milestone: string | null;
  kind: PRKind;
  /** Raw review-event count (all reviews, including bare COMMENTED). */
  reviewEventsCount: number;
  /** Substantive review count (excludes COMMENTED with zero inline replies). */
  reviewCount: number;
  commentCount: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  /** True when this PR reverts another PR (see `revert` for the target). */
  isRevert: boolean;
  revert: { repo: string; number: number } | null;
}

export interface IssueRef {
  repo: string;
  number: number;
  title: string;
  url: string;
  closedAt: string | null;
}

export interface DevQuarter {
  login: string;
  displayName: string;
  /** May be fractional when coAuthorCredit = "split". */
  prsMerged: number;
  prsByKind: Record<PRKind, number>;
  /** Reverts authored by this dev (a subset of prsByKind.bugfix). */
  revertsAuthored: number;
  /** PRs by this dev that were reverted in the same quarter. */
  revertsReceived: number;
  filesTouched: number;
  /** Substantive reviews only: state != COMMENTED OR ≥1 inline-thread reply. */
  reviewsGiven: number;
  /** Raw review-event count (previous behavior; kept for parity/debug). */
  reviewEventsGiven: number;
  reviewsOnOwnPRs: number;
  crossRepoCollaboration: number;
  topPRs: PRSummary[];
  shippedMilestones: string[];
  linkedIssuesClosed: IssueRef[];
}

export interface QuarterRange {
  label: string;
  /** Inclusive start date in the configured timezone, YYYY-MM-DD. */
  from: string;
  /** Inclusive end date in the configured timezone, YYYY-MM-DD. */
  to: string;
  /** Absolute timestamp (ms) of `from` 00:00:00 in `tz`. */
  fromTs: number;
  /** Absolute timestamp (ms) of `to` 23:59:59 in `tz`. */
  toTs: number;
  /** IANA timezone name used to compute fromTs/toTs. */
  tz: string;
}

export interface TeamQuarter {
  quarter: QuarterRange;
  manager: string;
  members: DevQuarter[];
  totals: {
    prsMerged: number;
    reviewsGiven: number;
    reposTouched: number;
    issuesClosed: number;
  };
  dataGaps: DataGap[];
}

export interface DataGap {
  repo: string;
  reason: string;
  at: string;
}

export interface RawPR {
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  mergedAt: string | null;
  author: string;
  /** Co-author logins parsed from merge commit Co-authored-by: trailers. */
  coAuthors: string[];
  /** PR's base branch; PRs landing outside the default branch are dropped. */
  baseRefName: string;
  /** Default branch at extract time, carried for filter + audit. */
  defaultBranch: string;
  /** Raw merge commit message (for provenance / re-parsing). */
  mergeCommitMessage: string | null;
  labels: { name: string }[];
  milestone: { title: string } | null;
  reviews: {
    user: string;
    state: string;
    /** Inline review-comment count on this individual review (optional: old fixtures default to 0). */
    inlineCommentCount?: number;
  }[];
  comments: number;
  linkedIssues: IssueRef[];
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewRequests: string[];
}
