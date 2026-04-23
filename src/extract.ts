import { runConcurrent } from "./concurrency.js";
import { ExtractCache, maxUpdatedAt, mergeByNumber } from "./extract-cache.js";
import { coAuthorLoginFromEmail, parseCoAuthors } from "./pr-parse.js";
import type { RunCounters } from "./counters.js";
import type { GithubClient } from "./github.js";
import type { DataGap, QuarterRange, RawPR } from "./types.js";

export interface ExtractScope {
  repos: string[];
}

export interface ExtractOptions {
  /** Max concurrent repo fetches. Default 4. */
  concurrency?: number;
  /** When true: never touch the network. Cold cache → throw. */
  dryRun?: boolean;
  /** Counters bag; incremented in-place. */
  counters?: RunCounters;
  /** Cache handle for incremental extraction. Optional but strongly advised. */
  cache?: ExtractCache;
  log?: (msg: string) => void;
}

export interface ExtractResult {
  prsByRepo: Map<string, RawPR[]>;
  gaps: DataGap[];
  /** Default-branch-only filter dropped this many PRs (audit signal). */
  droppedNonDefaultBranch: number;
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
  updatedAt: string;
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
          updatedAt
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

export async function extractAll(
  client: GithubClient,
  scope: ExtractScope,
  quarter: QuarterRange,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const log = opts.log ?? (() => {});
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const prsByRepo = new Map<string, RawPR[]>();
  const gaps: DataGap[] = [];
  let droppedNonDefaultBranch = 0;

  const { stats } = await runConcurrent(scope.repos, concurrency, async (repoPath) => {
    const [owner, name] = repoPath.split("/") as [string, string];
    try {
      const res = await fetchRepo(client, owner, name, quarter, opts, log);
      prsByRepo.set(repoPath, res.prs);
      droppedNonDefaultBranch += res.droppedNonDefault;
      log(
        `${repoPath}: ${res.prs.length} merged PRs on default branch (${res.droppedNonDefault} dropped: non-default base; ${res.cacheHits} from cache)`,
      );
    } catch (err) {
      // Dry-run is an explicit cache-only mode; any failure (cold cache,
      // corrupt snapshot) must surface to the caller, not silently degrade.
      if (opts.dryRun) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      log(`${repoPath}: failed (${msg}) — skipping`);
      gaps.push({ repo: repoPath, reason: msg, at: new Date().toISOString() });
      prsByRepo.set(repoPath, []);
    }
  });

  if (opts.counters) opts.counters.peakConcurrency = stats.peakConcurrency;

  return { prsByRepo, gaps, droppedNonDefaultBranch };
}

interface RepoFetchResult {
  prs: RawPR[];
  droppedNonDefault: number;
  cacheHits: number;
}

async function fetchRepo(
  client: GithubClient,
  owner: string,
  name: string,
  quarter: QuarterRange,
  opts: ExtractOptions,
  log: (msg: string) => void,
): Promise<RepoFetchResult> {
  const repoPath = `${owner}/${name}`;
  const cached = opts.cache?.load(repoPath, quarter) ?? null;

  if (opts.dryRun) {
    if (!cached) {
      throw new Error(
        `--dry-run set but no cached snapshot for ${repoPath} @ ${quarter.label}; run once without --dry-run to warm the cache.`,
      );
    }
    if (opts.counters) opts.counters.cacheHits += cached.prs.length;
    return { prs: cached.prs, droppedNonDefault: 0, cacheHits: cached.prs.length };
  }

  const lastSeen = cached?.lastSeenUpdatedAt ?? null;
  const freshPRs: RawPR[] = [];
  let droppedNonDefault = 0;
  let cursor: string | null = null;
  let pages = 0;
  let defaultBranch = "main";
  let caughtUp = false;

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
      // Incremental: once a node's updatedAt is <= our lastSeen, everything
      // that follows (sorted updatedAt DESC) is cached and unchanged. Stop.
      if (lastSeen && n.updatedAt <= lastSeen) {
        caughtUp = true;
        break;
      }
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
      freshPRs.push(nodeToRaw(repoPath, defaultBranch, n));
    }

    if (caughtUp) break;
    if (!data.repository.pullRequests.pageInfo.hasNextPage) break;
    if (sawOlder && freshPRs.length > 0 && oldestMerged(freshPRs) < quarter.fromTs) break;

    cursor = data.repository.pullRequests.pageInfo.endCursor;
    if (pages > 40) {
      log(`${repoPath}: stopping at 40 pages (safety cap)`);
      break;
    }
  }

  const cachedPrs = cached?.prs ?? [];
  const merged = mergeByNumber(cachedPrs, freshPRs).filter((p) => {
    // Respect the current quarter window; a cached PR from a prior quarter
    // cannot leak in since the cache key includes the label, but defensively
    // re-apply the range here for correctness.
    if (!p.mergedAt) return false;
    const ts = new Date(p.mergedAt).getTime();
    return ts >= quarter.fromTs && ts <= quarter.toTs;
  });

  const lastSeenUpdated = maxUpdatedAt([...cachedPrs, ...freshPRs], lastSeen);
  opts.cache?.save(repoPath, quarter, merged, lastSeenUpdated);

  const cacheHits = Math.max(0, merged.length - freshPRs.length);
  if (opts.counters) opts.counters.cacheHits += cacheHits;

  return { prs: merged, droppedNonDefault, cacheHits };
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
    updatedAt: n.updatedAt,
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

// Re-export for the ExtractCache interface surface used by run.ts.
export { ExtractCache } from "./extract-cache.js";
