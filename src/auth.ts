import { readFile } from "node:fs/promises";
import { createAppAuth } from "@octokit/auth-app";
import type { Config } from "./config.js";

export type AuthKind = "pat" | "app";

export interface AuthResolved {
  kind: AuthKind;
  /** Actor identity for audit logs. Never contains the secret. */
  identity: string;
  /** Bearer token usable by Octokit. For App auth, a short-lived installation token. */
  token: string;
  /** For App auth, the installation id that minted the token. */
  installationId?: number;
}

/**
 * Resolve auth from the config, preferring App over PAT when both are set.
 * Never persists the resolved token; callers should treat it as write-once.
 */
export async function resolveAuth(cfg: Config): Promise<AuthResolved> {
  if (cfg.github.app) {
    return await resolveAppAuth(cfg);
  }
  const tok = process.env[cfg.github.tokenEnv];
  if (!tok) {
    throw new Error(
      `GitHub token not set. Either configure github.app or export ${cfg.github.tokenEnv} (fine-grained PAT with contents:read, issues:read, pull-requests:read, metadata:read, members:read).`,
    );
  }
  return {
    kind: "pat",
    identity: `pat:env:${cfg.github.tokenEnv}`,
    token: tok,
  };
}

async function resolveAppAuth(cfg: Config): Promise<AuthResolved> {
  const app = cfg.github.app!;
  const privateKey = await loadPrivateKey(app.privateKeyEnv, app.privateKeyPath);
  const appId = typeof app.appId === "string" ? Number(app.appId) : app.appId;

  const auth = createAppAuth({ appId, privateKey });
  let installationId: number;

  if (app.installationId !== undefined) {
    installationId =
      typeof app.installationId === "string" ? Number(app.installationId) : app.installationId;
  } else {
    // Discover the installation for this org via the app JWT.
    const appJwt = await auth({ type: "app" });
    const res = await fetch(`${cfg.github.baseUrl}/orgs/${cfg.org}/installation`, {
      headers: {
        authorization: `Bearer ${(appJwt as { token: string }).token}`,
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
    installationId = body.id;
  }

  const installationToken = await auth({ type: "installation", installationId });
  return {
    kind: "app",
    identity: `app:${appId}:install:${installationId}`,
    token: (installationToken as { token: string }).token,
    installationId,
  };
}

async function loadPrivateKey(env: string | undefined, filePath: string | undefined): Promise<string> {
  if (env) {
    const val = process.env[env];
    if (!val) throw new Error(`GitHub App private key env var ${env} is empty.`);
    // Allow single-line PEM (env vars often can't carry newlines); restore them.
    if (val.includes("\\n")) return val.replace(/\\n/g, "\n");
    return val;
  }
  if (filePath) {
    return await readFile(filePath, "utf8");
  }
  throw new Error("GitHub App config needs either privateKeyEnv or privateKeyPath.");
}
