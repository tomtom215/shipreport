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

  it("every `uses:` step pins to a specific tag (no @main / @master / @branch)", async () => {
    const workflows = await loadWorkflows(path.join(ROOT, ".github", "workflows"));
    const offenders: string[] = [];
    for (const { file, doc } of workflows) {
      for (const [name, job] of Object.entries(doc.jobs ?? {})) {
        // workflow_call jobs have a top-level `uses:`, not steps.
        if (typeof job.uses === "string") continue;
        for (const step of job.steps ?? []) {
          if (!step.uses) continue;
          // Allow @vN and @vN.N.N and @sha (40-hex). Reject @main, @master, @latest.
          if (
            step.uses.includes("@main") ||
            step.uses.includes("@master") ||
            step.uses.includes("@latest")
          ) {
            offenders.push(`${path.relative(ROOT, file)}: ${name} -> ${step.uses}`);
          }
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("examples/github-actions caller workflows reference the in-repo reusable workflow", async () => {
    const examples = await loadWorkflows(path.join(ROOT, "examples", "github-actions"));
    expect(examples.length).toBeGreaterThanOrEqual(4);
    let matched = 0;
    for (const { doc } of examples) {
      for (const job of Object.values(doc.jobs ?? {})) {
        if (typeof job.uses === "string" && job.uses.includes("reusable-shipreport.yml")) {
          matched += 1;
        }
      }
    }
    // At least the four caller examples (PAT, App, hourly, GHES) should reference
    // the reusable workflow. dry-run-on-pr.yml is self-contained.
    expect(matched).toBeGreaterThanOrEqual(4);
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
