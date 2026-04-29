/**
 * Ed25519 signing for the audit-snapshot manifest.
 *
 * Uses Node's built-in crypto (no native deps). Key material is handled
 * as PEM strings so operators can rotate keys with standard tooling.
 *
 * Snapshot flow:
 *   1. Caller asks for the current chain head from AuditLog.
 *   2. buildManifest() stamps {chain_head_seq, chain_head_hash, generated_at,
 *      signer} and returns a canonical JSON string.
 *   3. signManifest() returns a base64 ed25519 signature over that bytes.
 *   4. The CLI ships {manifest, signature, public_key_pem} so the verifier
 *      has everything it needs offline.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "./audit.js";

export interface SnapshotManifest {
  chainHeadSeq: number | null;
  chainHeadHash: string | null;
  generatedAt: string;
  signer: string;
}

export interface SignedSnapshot {
  manifest: SnapshotManifest;
  /** Canonical JSON of the manifest — the exact bytes that were signed. */
  manifestCanonical: string;
  /** Ed25519 signature over manifestCanonical, base64. */
  signature: string;
  publicKeyPem: string;
}

export function buildManifest(args: {
  chainHead: { seq: number; hash: string } | null;
  generatedAt: string;
  signer: string;
}): SnapshotManifest {
  return {
    chainHeadSeq: args.chainHead?.seq ?? null,
    chainHeadHash: args.chainHead?.hash ?? null,
    generatedAt: args.generatedAt,
    signer: args.signer,
  };
}

export function signManifest(manifest: SnapshotManifest, privateKey: KeyObject): SignedSnapshot {
  const manifestCanonical = canonicalize(manifest);
  const sig = cryptoSign(null, Buffer.from(manifestCanonical, "utf8"), privateKey);
  const publicKey = createPublicKey(privateKey);
  return {
    manifest,
    manifestCanonical,
    signature: sig.toString("base64"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function verifySignedManifest(snap: SignedSnapshot): boolean {
  const publicKey = createPublicKey(snap.publicKeyPem);
  return cryptoVerify(
    null,
    Buffer.from(snap.manifestCanonical, "utf8"),
    publicKey,
    Buffer.from(snap.signature, "base64"),
  );
}

export function generateEd25519KeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function loadPrivateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: "pem" });
}

/**
 * Load a signing key from disk, auto-generating one if missing. A missing
 * key on a fresh install is the common case; a hard error would block
 * `audit snapshot` entirely. The generated key is persisted with mode
 * 0600 so only the owning user can read it.
 */
export async function loadOrGenerateKey(keyPath: string): Promise<{
  privateKey: KeyObject;
  generated: boolean;
  publicKeyPem: string;
}> {
  try {
    const pem = await readFile(keyPath, "utf8");
    const privateKey = loadPrivateKeyFromPem(pem);
    const publicKeyPem = createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString();
    return { privateKey, generated: false, publicKeyPem };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "ENOENT") throw err;
  }
  const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
  // Tighten the parent directory mode to 0700 for the same reason the
  // key itself is 0600: even on a multi-user host the filename should
  // not leak. A pre-existing wider directory is left as-is (mkdir's
  // `mode` only applies to directories it actually creates) — the
  // Dockerfile already chmod 0700s the path, and operators can do the
  // same. The umask wrap is a belt-and-suspenders chmod for the case
  // where the directory was just created by mkdir(recursive) and an
  // overly permissive umask widened the mode anyway.
  const dir = path.dirname(keyPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    /* mkdir-recursive on a deeper tree may have created intermediate
       parents we shouldn't touch; ignore if the leaf is read-only */
  }
  await writeFile(keyPath, privateKeyPem, { mode: 0o600 });
  return {
    privateKey: loadPrivateKeyFromPem(privateKeyPem),
    generated: true,
    publicKeyPem,
  };
}
