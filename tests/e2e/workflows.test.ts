/**
 * Workflow YAML structure / contract tests.
 *
 * These don't actually run a workflow on GitHub — they parse every YAML
 * file under `.github/workflows/` and `examples/github-actions/` and
 * assert structural invariants:
 *   * the file is valid YAML,
 *   * declares `on:`,
 *   * declares `permissions:` at workflow- or job-scope (least-privilege),
 *   * uses pinned `actions/<x>@vN` tags (no floating @main / @master),
 *   * for callers in examples/: references the in-repo reusable workflow
 *     when they `uses:` shipreport's reusable workflow.
 *
 * The point: when an operator copies any of the example files, all of
 * those invariants hold, and a future PR that breaks one fails CI.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const ROOT = path.resolve(__dirname, "..", "..");

interface JobLike {
  permissions?: unknown;
  steps?: { uses?: string }[];
  uses?: string;
}
interface WorkflowDoc {
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<string, JobLike>;
}

async function loadWorkflows(dir: string): Promise<Array<{ file: string; doc: WorkflowDoc }>> {
  const entries = await readdir(dir);
  const out: Array<{ file: string; doc: WorkflowDoc }> = [];
  for (const e of entries) {
    if (!e.endsWith(".yml") && !e.endsWith(".yaml")) continue;
    const p = path.join(dir, e);
    const raw = await readFile(p, "utf8");
    const doc = parse(raw) as WorkflowDoc;
    out.push({ file: p, doc });
  }
  return out;
}

describe("GitHub Actions workflow structure", () => {
  it("every workflow under .github/workflows parses as YAML", async () => {
    const workflows = await loadWorkflows(path.join(ROOT, ".github", "workflows"));
    expect(workflows.length).toBeGreaterThanOrEqual(5); // ci, release, tick, validate, audit-export, reusable
    for (const { file, doc } of workflows) {
      expect(doc, `unparseable: ${file}`).toBeTruthy();
      // YAML's `on:` is parsed as a key but JS treats `on` literally OK.
      expect(doc.on, `${file} missing 'on:'`).toBeDefined();
    }
  });

  it("every workflow declares permissions at workflow- or job-scope (least privilege)", async () => {
    const workflows = await loadWorkflows(path.join(ROOT, ".github", "workflows"));
    for (const { file, doc } of workflows) {
      const top = doc.permissions;
      const jobs = Object.values(doc.jobs ?? {});
      const jobScoped = jobs.some((j) => j.permissions);
      expect(
        top || jobScoped,
        `${file} declares no permissions at workflow- or job-scope`,
      ).toBeTruthy();
    }
  });

  it("every `uses:` step in .github/workflows pins to a 40-hex commit SHA (SLSA-grade supply-chain anchor)", async () => {
    const workflows = await loadWorkflows(path.join(ROOT, ".github", "workflows"));
    const offenders: string[] = [];
    // SHA40 = exactly 40 lowercase hex chars. The `# vX.Y.Z` trailer is
    // optional but encouraged so a human can read the version at a glance.
    const SHA40_PIN = /^[\w./-]+@[a-f0-9]{40}(\s+#\s*v[\w.-]+)?$/;
    for (const { file, doc } of workflows) {
      for (const [name, job] of Object.entries(doc.jobs ?? {})) {
        // Top-level workflow_call `uses:` (caller workflows reference
        // shipreport's reusable workflow). Pinning policy is enforced
        // separately on caller examples — see the next test.
        if (typeof job.uses === "string") continue;
        for (const step of job.steps ?? []) {
          if (!step.uses) continue;
          if (!SHA40_PIN.test(step.uses)) {
            offenders.push(`${path.relative(ROOT, file)}: ${name} -> ${step.uses}`);
          }
        }
      }
    }
    expect(offenders.join("\n"), offenders.join("\n")).toEqual("");
  });

  it("every third-party `uses:` step in examples/github-actions pins to a 40-hex SHA", async () => {
    // Mirrors the rule for .github/workflows above: caller examples in
    // examples/github-actions/ are what operators copy verbatim, so they
    // must hold the same supply-chain anchor as shipreport's own CI.
    // The shipreport reusable-workflow `uses:` is exempt from this test —
    // its pin is always the operator-supplied REPLACE_WITH_TAG_OR_SHA
    // sentinel, which the next test below verifies independently.
    const examples = await loadWorkflows(path.join(ROOT, "examples", "github-actions"));
    const SHA40_PIN = /^[\w./-]+@[a-f0-9]{40}(\s+#\s*v[\w.-]+)?$/;
    const SHIPREPORT_REUSABLE = /^tomtom215\/shipreport\/.+@/;
    const offenders: string[] = [];
    for (const { file, doc } of examples) {
      for (const [name, job] of Object.entries(doc.jobs ?? {})) {
        // Caller-level `uses:` to shipreport's reusable workflow is the
        // operator placeholder; checked elsewhere.
        if (typeof job.uses === "string") continue;
        for (const step of job.steps ?? []) {
          if (!step.uses) continue;
          if (SHIPREPORT_REUSABLE.test(step.uses)) continue;
          if (!SHA40_PIN.test(step.uses)) {
            offenders.push(`${path.relative(ROOT, file)}: ${name} -> ${step.uses}`);
          }
        }
      }
    }
    expect(offenders.join("\n"), offenders.join("\n")).toEqual("");
  });

  it("examples/github-actions caller workflows reference the in-repo reusable workflow with the operator-replace placeholder", async () => {
    const examples = await loadWorkflows(path.join(ROOT, "examples", "github-actions"));
    // Six checked-in callers (hourly-tick, quarterly-pat, quarterly-app,
    // quarterly-image, ghes-self-hosted, dry-run-on-pr); four use the
    // reusable workflow. quarterly-image runs a published Docker image
    // directly; dry-run-on-pr is self-contained.
    expect(examples.length).toBeGreaterThanOrEqual(6);
    let matched = 0;
    for (const { doc } of examples) {
      for (const job of Object.values(doc.jobs ?? {})) {
        if (typeof job.uses === "string" && job.uses.includes("reusable-shipreport.yml")) {
          matched += 1;
          // Every caller of the reusable workflow MUST use the operator-
          // replace sentinel. A real SHA / tag would ship to operators
          // who'd forget to swap it; the placeholder fails fast at GH's
          // first workflow run, which is the safe failure mode.
          expect(job.uses).toMatch(
            /reusable-shipreport\.yml@REPLACE_WITH_TAG_OR_SHA$/,
            `caller does not use the REPLACE_WITH_TAG_OR_SHA sentinel: ${String(job.uses)}`,
          );
        }
      }
    }
    expect(matched).toBeGreaterThanOrEqual(4);
  });

  it("examples/github-actions caller workflows must NOT contain a real-looking 40-hex SHA in a `uses: tomtom215/shipreport/...@` slot", async () => {
    // Defense in depth against the failure mode that motivated the
    // sentinel switch: the previous placeholder was a 40-hex string
    // that GitHub treated as a (non-existent) commit, producing a
    // confusing "ref not found" error. Any 40-hex pin to shipreport's
    // own reusable workflow inside examples/ would re-introduce that
    // hazard. Outside operators are expected to substitute, but the
    // checked-in examples themselves should stay sentinel-pinned.
    const examples = await loadWorkflows(path.join(ROOT, "examples", "github-actions"));
    const offenders: string[] = [];
    for (const { file, doc } of examples) {
      const raw = (doc as { jobs?: Record<string, { uses?: string }> }).jobs ?? {};
      for (const [, job] of Object.entries(raw)) {
        if (typeof job.uses !== "string") continue;
        if (!job.uses.includes("tomtom215/shipreport/")) continue;
        if (/@[a-f0-9]{40}\b/.test(job.uses)) {
          offenders.push(`${path.relative(ROOT, file)}: ${job.uses}`);
        }
      }
    }
    expect(offenders.join("\n"), offenders.join("\n")).toEqual("");
  });
});

describe("Reusable workflow contract", () => {
  it("declares the documented inputs and secrets", async () => {
    const raw = await readFile(
      path.join(ROOT, ".github", "workflows", "reusable-shipreport.yml"),
      "utf8",
    );
    const doc = parse(raw) as {
      on?: { workflow_call?: { inputs?: Record<string, unknown>; secrets?: Record<string, unknown> } };
    };
    const wc = doc.on?.workflow_call;
    expect(wc, "reusable-shipreport.yml is missing on.workflow_call").toBeDefined();
    const inputNames = Object.keys(wc!.inputs ?? {});
    for (const expected of ["config", "mode", "team", "quarter", "shipreport_ref", "runs_on"]) {
      expect(inputNames, `missing input ${expected}`).toContain(expected);
    }
    const secretNames = Object.keys(wc!.secrets ?? {});
    for (const expected of [
      "shipreport_token",
      "shipreport_app_private_key",
      "shipreport_audit_key",
    ]) {
      expect(secretNames, `missing secret ${expected}`).toContain(expected);
    }
  });
});

describe("tick.yml has the documented dispatch modes", () => {
  it("workflow_dispatch declares run / dry-run / doctor / preview", async () => {
    const raw = await readFile(path.join(ROOT, ".github", "workflows", "tick.yml"), "utf8");
    const doc = parse(raw) as {
      on?: { workflow_dispatch?: { inputs?: { mode?: { options?: string[] } } } };
    };
    const opts = doc.on?.workflow_dispatch?.inputs?.mode?.options ?? [];
    expect(opts).toEqual(expect.arrayContaining(["run", "dry-run", "doctor", "preview"]));
  });
});
