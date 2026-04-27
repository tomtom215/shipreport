/**
 * Pluggable token sources for long-running extractions.
 *
 * PATs never expire on the scale of a single run, so the PAT source is a
 * constant. GitHub App installation tokens expire after one hour, so a
 * run that takes more than ~50 minutes has to renew proactively. The
 * `TokenSource` interface lets github.ts call `getToken()` before every
 * request without caring which kind of auth it is.
 *
 * `nowMs` is injectable so tests can exercise the renewal boundary
 * deterministically; production code leaves it at Date.now.
 */

import { createAppAuth } from "@octokit/auth-app";
import type { Config } from "./config.js";
import { readFile } from "node:fs/promises";

export type AuthKind = "pat" | "app";

export interface TokenSource {
  kind: AuthKind;
  identity: string;
  installationId?: number;
  /** Current token, minting a fresh one if the active one is due to expire. */
  getToken: () => Promise<string>;
  /** Count of successful renewals since construction (tests + audit). */
  renewalCount: () => number;
}

/**
 * Installation tokens are valid for one hour. We renew at 50 minutes so
 * there's a healthy buffer against clock skew + in-flight requests.
 */
export const DEFAULT_RENEW_AFTER_MS = 50 * 60 * 1000;

export function createPatTokenSource(envVar: string): TokenSource {
  const tok = process.env[envVar];
  if (!tok) {
    throw new Error(
      `GitHub token not set. Either configure github.app or export ${envVar}.`,
    );
  }
  return {
    kind: "pat",
    identity: `pat:env:${envVar}`,
    getToken: async () => tok,
    renewalCount: () => 0,
  };
}

export interface AppTokenSourceOptions {
  appId: number;
  privateKeyPem: string;
  installationId: number;
  /** Clock — injected for tests. */
  nowMs?: () => number;
  /** Threshold after which a token is re-minted. */
  renewAfterMs?: number;
  /**
   * Called once per successful re-mint (NOT for the first mint). Used by
   * run.ts to emit the SOC2 `token_renewed` audit row. The callback is
   * fire-and-forget — it must not throw or return a promise the source
   * waits on, since the renew path is on the request hot path.
   */
  onRenew?: (info: {
    renewalCount: number;
    mintedAtMs: number;
    previousMintedAtMs: number;
  }) => void;
}

/**
 * App token source. The first token is minted lazily on the first
 * getToken() call. Each subsequent call checks the clock; when the
 * active token is older than `renewAfterMs`, a fresh token is minted
 * before the call returns. Minting is synchronous-enough (ed25519 JWT
 * + one API call) that we don't need to pre-schedule it.
 */
export function createAppTokenSource(opts: AppTokenSourceOptions): TokenSource {
  const nowMs = opts.nowMs ?? Date.now;
  const renewAfterMs = opts.renewAfterMs ?? DEFAULT_RENEW_AFTER_MS;
  const auth = createAppAuth({ appId: opts.appId, privateKey: opts.privateKeyPem });

  let cached: { token: string; mintedAtMs: number } | null = null;
  let renewals = 0;

  const mint = async (): Promise<string> => {
    const res = (await auth({ type: "installation", installationId: opts.installationId })) as {
      token: string;
    };
    cached = { token: res.token, mintedAtMs: nowMs() };
    return res.token;
  };

  return {
    kind: "app",
    identity: `app:${opts.appId}:install:${opts.installationId}`,
    installationId: opts.installationId,
    async getToken() {
      if (!cached) {
        return await mint();
      }
      if (nowMs() - cached.mintedAtMs >= renewAfterMs) {
        const previousMintedAtMs = cached.mintedAtMs;
        renewals += 1;
        const token = await mint();
        if (opts.onRenew && cached) {
          opts.onRenew({
            renewalCount: renewals,
            mintedAtMs: cached.mintedAtMs,
            previousMintedAtMs,
          });
        }
        return token;
      }
      return cached.token;
    },
    renewalCount: () => renewals,
  };
}

/**
 * Build a TokenSource directly from the shipreport config, preferring App
 * over PAT when both are set. Parallels the old resolveAuth() contract but
 * returns an object that can renew rather than a one-shot snapshot.
 */
export async function tokenSourceFromConfig(
  cfg: Config,
  opts: {
    nowMs?: () => number;
    renewAfterMs?: number;
    onRenew?: AppTokenSourceOptions["onRenew"];
  } = {},
): Promise<TokenSource> {
  if (cfg.github.app) {
    const app = cfg.github.app;
    const privateKeyPem = await loadAppPrivateKey(app.privateKeyEnv, app.privateKeyPath);
    const appId = typeof app.appId === "string" ? Number(app.appId) : app.appId;
    const installationId = await resolveInstallationId(cfg, appId, privateKeyPem);
    return createAppTokenSource({
      appId,
      privateKeyPem,
      installationId,
      nowMs: opts.nowMs,
      renewAfterMs: opts.renewAfterMs,
      onRenew: opts.onRenew,
    });
  }
  return createPatTokenSource(cfg.github.tokenEnv);
}

async function loadAppPrivateKey(
  envVar: string | undefined,
  filePath: string | undefined,
): Promise<string> {
  if (envVar) {
    const val = process.env[envVar];
    if (!val) throw new Error(`GitHub App private key env var ${envVar} is empty.`);
    return val.includes("\\n") ? val.replace(/\\n/g, "\n") : val;
  }
  if (filePath) return await readFile(filePath, "utf8");
  throw new Error("GitHub App config needs either privateKeyEnv or privateKeyPath.");
}

async function resolveInstallationId(
  cfg: Config,
  appId: number,
  privateKeyPem: string,
): Promise<number> {
  const app = cfg.github.app!;
  if (app.installationId !== undefined) {
    return typeof app.installationId === "string"
      ? Number(app.installationId)
      : app.installationId;
  }
  const auth = createAppAuth({ appId, privateKey: privateKeyPem });
  const appJwt = (await auth({ type: "app" })) as { token: string };
  const res = await fetch(`${cfg.github.baseUrl}/orgs/${cfg.org}/installation`, {
    headers: {
      authorization: `Bearer ${appJwt.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "shipreport",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to discover GitHub App installation for org ${cfg.org}: ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as { id: number };
  return body.id;
}
