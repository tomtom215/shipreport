import type { GithubClient } from "./github.js";
import type { DataGap, QuarterRange, RawPR } from "./types.js";

export interface ExtractScope {
  repos: string[];
}

interface PullsNode {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  milestone: { title: string } | null;
  comments: { totalCount: number };
  reviews: { nodes: { author: { login: string } | null; state: string }[] };
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
          additions
          deletions
          changedFiles
          author { login }
          labels(first: 20) { nodes { name } }
          milestone { title }
          comments { totalCount }
          reviews(first: 50) { nodes { author { login } state } }
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
}

export async function extractAll(
  client: GithubClient,
  scope: ExtractScope,
  quarter: QuarterRange,
  log: (msg: string) => void = () => {},
): Promise<ExtractResult> {
  const prsByRepo = new Map<string, RawPR[]>();
  const gaps: DataGap[] = [];

  const from = new Date(`${quarter.from}T00:00:00Z`).getTime();
  const to = new Date(`${quarter.to}T23:59:59Z`).getTime();

  for (const repoPath of scope.repos) {
    const [owner, name] = repoPath.split("/") as [string, string];
    try {
      const prs = await fetchRepoPRs(client, owner, name, from, to, log);
      prsByRepo.set(repoPath, prs);
      log(`${repoPath}: ${prs.length} merged PRs in window`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${repoPath}: failed (${msg}) — skipping`);
      gaps.push({ repo: repoPath, reason: msg, at: new Date().toISOString() });
      prsByRepo.set(repoPath, []);
    }
  }

  return { prsByRepo, gaps };
}

async function fetchRepoPRs(
  client: GithubClient,
  owner: string,
  name: string,
  fromMs: number,
  toMs: number,
  log: (msg: string) => void,
): Promise<RawPR[]> {
  const out: RawPR[] = [];
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    pages += 1;
    const data: {
      repository: {
        pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: PullsNode[] };
      };
    } = await client.graphql(PR_QUERY, { owner, name, cursor });

    const nodes = data.repository.pullRequests.nodes ?? [];
    let sawOlder = false;

    for (const n of nodes) {
      if (!n.mergedAt) continue;
      const ts = new Date(n.mergedAt).getTime();
      if (ts > toMs) continue;
      if (ts < fromMs) {
        sawOlder = true;
        continue;
      }
      out.push(nodeToRaw(`${owner}/${name}`, n));
    }

    // results are sorted by UPDATED_AT desc; we can stop once we've paginated
    // past the window AND nothing recent matched.
    if (!data.repository.pullRequests.pageInfo.hasNextPage) break;
    if (sawOlder && out.length > 0 && oldestMerged(out) < fromMs) break;

    cursor = data.repository.pullRequests.pageInfo.endCursor;
    if (pages > 40) {
      log(`${owner}/${name}: stopping at 40 pages (safety cap)`);
      break;
    }
  }

  return out;
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

function nodeToRaw(repo: string, n: PullsNode): RawPR {
  return {
    repo,
    number: n.number,
    url: n.url,
    title: n.title,
    body: n.body ?? "",
    state: n.state,
    mergedAt: n.mergedAt,
    author: n.author?.login ?? "ghost",
    labels: (n.labels.nodes ?? []).map((l) => ({ name: l.name })),
    milestone: n.milestone ? { title: n.milestone.title } : null,
    reviews: (n.reviews.nodes ?? [])
      .filter((r) => r.author?.login)
      .map((r) => ({ user: r.author!.login, state: r.state })),
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
