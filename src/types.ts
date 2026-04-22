export type PRKind = "feature" | "bugfix" | "refactor" | "docs" | "infra" | "other";

export interface PRSummary {
  repo: string;
  number: number;
  url: string;
  title: string;
  mergedAt: string;
  author: string;
  reviewers: string[];
  linkedIssues: string[];
  body: string;
  labels: string[];
  milestone: string | null;
  kind: PRKind;
  reviewCount: number;
  commentCount: number;
  filesChanged: number;
  additions: number;
  deletions: number;
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
  prsMerged: number;
  prsByKind: Record<PRKind, number>;
  filesTouched: number;
  reviewsGiven: number;
  reviewsOnOwnPRs: number;
  crossRepoCollaboration: number;
  topPRs: PRSummary[];
  shippedMilestones: string[];
  linkedIssuesClosed: IssueRef[];
}

export interface QuarterRange {
  label: string;
  from: string;
  to: string;
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
  labels: { name: string }[];
  milestone: { title: string } | null;
  reviews: { user: string; state: string }[];
  comments: number;
  linkedIssues: { repo: string; number: number; title: string; url: string; closedAt: string | null }[];
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewRequests: string[];
}
