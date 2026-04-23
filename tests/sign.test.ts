import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildManifest,
  generateEd25519KeyPair,
  loadOrGenerateKey,
  loadPrivateKeyFromPem,
  signManifest,
  verifySignedManifest,
} from "../src/sign.js";

describe("buildManifest + signManifest + verifySignedManifest", () => {
  it("round-trips: a signed manifest verifies with its embedded public key", () => {
    const { privateKeyPem } = generateEd25519KeyPair();
    const priv = loadPrivateKeyFromPem(privateKeyPem);
    const manifest = buildManifest({
      chainHead: { seq: 42, hash: "a".repeat(64) },
      generatedAt: "2026-04-01T00:00:00Z",
      signer: "acme-compliance",
    });
    const signed = signManifest(manifest, priv);
    expect(verifySignedManifest(signed)).toBe(true);
  });

  it("detects tampering with the manifest bytes", () => {
    const { privateKeyPem } = generateEd25519KeyPair();
    const signed = signManifest(
      buildManifest({
        chainHead: { seq: 1, hash: "b".repeat(64) },
        generatedAt: "2026-04-01T00:00:00Z",
        signer: "x",
      }),
      loadPrivateKeyFromPem(privateKeyPem),
    );
    const tampered = {
      ...signed,
      manifestCanonical: signed.manifestCanonical.replace(
        '"chainHeadSeq":1',
        '"chainHeadSeq":999',
      ),
    };
    // Guard: the replace actually changed the bytes before we assert verification fails.
    expect(tampered.manifestCanonical).not.toBe(signed.manifestCanonical);
    expect(verifySignedManifest(tampered)).toBe(false);
  });

  it("detects tampering with the signature bytes", () => {
    const { privateKeyPem } = generateEd25519KeyPair();
    const signed = signManifest(
      buildManifest({
        chainHead: null,
        generatedAt: "2026-04-01T00:00:00Z",
        signer: "x",
      }),
      loadPrivateKeyFromPem(privateKeyPem),
    );
    // flip one byte of the signature
    const sigBuf = Buffer.from(signed.signature, "base64");
    sigBuf[0] = sigBuf[0]! ^ 0xff;
    const tampered = { ...signed, signature: sigBuf.toString("base64") };
    expect(verifySignedManifest(tampered)).toBe(false);
  });

  it("manifest carries chainHead fields or explicit nulls for an empty log", () => {
    const m = buildManifest({
      chainHead: null,
      generatedAt: "2026-04-01T00:00:00Z",
      signer: "s",
    });
    expect(m.chainHeadSeq).toBeNull();
    expect(m.chainHeadHash).toBeNull();
  });
});

describe("loadOrGenerateKey", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shipreport-key-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates and persists a key with mode 0600 on first call", async () => {
    const keyPath = path.join(dir, "nested", "k.pem");
    const { generated, privateKey } = await loadOrGenerateKey(keyPath);
    expect(generated).toBe(true);
    const s = await stat(keyPath);
    // On POSIX, mask the permission bits; on Windows CI this may be looser.
    if (process.platform !== "win32") {
      expect(s.mode & 0o777).toBe(0o600);
    }
    expect(privateKey.asymmetricKeyType).toBe("ed25519");
  });

  it("reuses the key on subsequent calls", async () => {
    const keyPath = path.join(dir, "k.pem");
    const first = await loadOrGenerateKey(keyPath);
    const second = await loadOrGenerateKey(keyPath);
    expect(second.generated).toBe(false);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
    const onDisk = await readFile(keyPath, "utf8");
    expect(onDisk).toMatch(/BEGIN PRIVATE KEY/);
  });
});
