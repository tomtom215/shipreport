import { coAuthorLoginFromEmail, parseCoAuthors } from "./pr-parse.js";
import type { GithubClient } from "./github.js";
import type { DataGap, QuarterRange, RawPR } from "./types.js";

export interface ExtractScope {
  repos: string[];
}

interface ReviewNode {
  author: { login: string } | null;
  state: string;
  comments: { totalCount: number };
}

interface PullsNode {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  mergedAt: string | null;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  milestone: { title: string } | null;
  comments: { totalCount: number };
  mergeCommit: { message: string | null } | null;
  reviews: { nodes: ReviewNode[] };
  reviewRequests: {
    nodes: { requestedReviewer: { login?: string; name?: string } | null }[];
  };
  closingIssuesReferences: {
    nodes: {
      number: number;
      title: string;
      url: string;
      closedAt: string | null;
      repository: { nameWithOwner: string };
    }[];
  };
}

const PR_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef { name }
      pullRequests(
        first: 50
        after: $cursor
        states: MERGED
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          body
          url
          state
          mergedAt
          baseRefName
          additions
          deletions
          changedFiles
          author { login }
          labels(first: 20) { nodes { name } }
          milestone { title }
          comments { totalCount }
          mergeCommit { message }
          reviews(first: 50) {
            nodes {
              author { login }
              state
              comments { totalCount }
            }
          }
          reviewRequests(first: 20) {
            nodes {
              requestedReviewer {
                ... on User { login }
                ... on Team { name }
              }
            }
          }
          closingIssuesReferences(first: 20) {
            nodes {
              number
              title
              url
              closedAt
              repository { nameWithOwner }
            }
          }
        }
      }
    }
  }
`;

export interface ExtractResult {
  prsByRepo: Map<string, RawPR[]>;
  gaps: DataGap[];
  /** Default-branch-only filter dropped this many PRs (audit signal). */
  droppedNonDefaultBranch: number;
}

export async function extractAll(
  client: GithubClient,
  scope: ExtractScope,
  quarter: QuarterRange,
  log: (msg: string) => void = () => {},
): Promise<ExtractResult> {
  const prsByRepo = new Map<string, RawPR[]>();
  const gaps: DataGap[] = [];
  let droppedNonDefaultBranch = 0;

  for (const repoPath of scope.repos) {
    const [owner, name] = repoPath.split("/") as [string, string];
    try {
      const res = await fetchRepoPRs(client, owner, name, quarter, log);
      prsByRepo.set(repoPath, res.prs);
      droppedNonDefaultBranch += res.droppedNonDefault;
      log(
        `${repoPath}: ${res.prs.length} merged PRs on default branch (${res.droppedNonDefault} dropped: non-default base)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${repoPath}: failed (${msg}) — skipping`);
      gaps.push({ repo: repoPath, reason: msg, at: new Date().toISOString() });
      prsByRepo.set(repoPath, []);
    }
  }

  return { prsByRepo, gaps, droppedNonDefaultBranch };
}

interface RepoFetchResult {
  prs: RawPR[];
  droppedNonDefault: number;
}

async function fetchRepoPRs(
  client: GithubClient,
  owner: string,
  name: string,
  quarter: QuarterRange,
  log: (msg: string) => void,
): Promise<RepoFetchResult> {
  const out: RawPR[] = [];
  let droppedNonDefault = 0;
  let cursor: string | null = null;
  let pages = 0;
  let defaultBranch = "main";

  for (;;) {
    pages += 1;
    const data: {
      repository: {
        defaultBranchRef: { name: string } | null;
        pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: PullsNode[] };
      };
    } = await client.graphql(PR_QUERY, { owner, name, cursor });

    defaultBranch = data.repository.defaultBranchRef?.name ?? defaultBranch;
    const nodes = data.repository.pullRequests.nodes ?? [];
    let sawOlder = false;

    for (const n of nodes) {
      if (!n.mergedAt) continue;
      const ts = new Date(n.mergedAt).getTime();
      if (ts > quarter.toTs) continue;
      if (ts < quarter.fromTs) {
        sawOlder = true;
        continue;
      }
      if (n.baseRefName !== defaultBranch) {
        droppedNonDefault += 1;
        continue;
      }
      out.push(nodeToRaw(`${owner}/${name}`, defaultBranch, n));
    }

    // results are sorted by UPDATED_AT desc; we can stop once we've paginated
    // past the window AND nothing recent matched.
    if (!data.repository.pullRequests.pageInfo.hasNextPage) break;
    if (sawOlder && out.length > 0 && oldestMerged(out) < quarter.fromTs) break;

    cursor = data.repository.pullRequests.pageInfo.endCursor;
    if (pages > 40) {
      log(`${owner}/${name}: stopping at 40 pages (safety cap)`);
      break;
    }
  }

  return { prs: out, droppedNonDefault };
}

function oldestMerged(prs: RawPR[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const p of prs) {
    if (!p.mergedAt) continue;
    const t = new Date(p.mergedAt).getTime();
    if (t < min) min = t;
  }
  return min;
}

function nodeToRaw(repo: string, defaultBranch: string, n: PullsNode): RawPR {
  const coAuthors = parseCoAuthors(n.mergeCommit?.message ?? null)
    .map((c) => coAuthorLoginFromEmail(c.email))
    .filter((l): l is string => l !== null);

  return {
    repo,
    number: n.number,
    url: n.url,
    title: n.title,
    body: n.body ?? "",
    state: n.state,
    mergedAt: n.mergedAt,
    author: n.author?.login ?? "ghost",
    coAuthors,
    baseRefName: n.baseRefName,
    defaultBranch,
    mergeCommitMessage: n.mergeCommit?.message ?? null,
    labels: (n.labels.nodes ?? []).map((l) => ({ name: l.name })),
    milestone: n.milestone ? { title: n.milestone.title } : null,
    reviews: (n.reviews.nodes ?? [])
      .filter((r) => r.author?.login)
      .map((r) => ({
        user: r.author!.login,
        state: r.state,
        inlineCommentCount: r.comments?.totalCount ?? 0,
      })),
    comments: n.comments.totalCount,
    linkedIssues: (n.closingIssuesReferences.nodes ?? []).map((i) => ({
      repo: i.repository.nameWithOwner,
      number: i.number,
      title: i.title,
      url: i.url,
      closedAt: i.closedAt,
    })),
    additions: n.additions,
    deletions: n.deletions,
    changedFiles: n.changedFiles,
    reviewRequests: (n.reviewRequests.nodes ?? [])
      .map((rr) => rr.requestedReviewer?.login ?? rr.requestedReviewer?.name ?? "")
      .filter(Boolean),
  };
}
