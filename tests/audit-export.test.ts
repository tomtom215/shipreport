import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AuditLog } from "../src/audit.js";
import { exportJsonl, verifyJsonl } from "../src/audit-export.js";
import { StateDB } from "../src/state.js";

async function freshLog(): Promise<{ log: AuditLog; state: StateDB }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shipreport-audit-export-"));
  const state = await StateDB.open(path.join(dir, "state.sqlite"));
  return { log: new AuditLog(state), state };
}

describe("exportJsonl + verifyJsonl", () => {
  it("round-trips a full chain: every row re-verifies against the genesis zero hash", async () => {
    const { log, state } = await freshLog();
    log.append({ actor: "a", event: "run_started", target: "t" });
    log.append({
      actor: "a",
      event: "report_written",
      target: "t",
      payload: { path: "/x.md", nested: { k: "v" } },
    });
    log.append({ actor: "a", event: "run_completed", target: "t" });
    const rows = log.readForward();
    const jsonl = exportJsonl(rows);
    state.close();

    expect(jsonl.split("\n").filter(Boolean)).toHaveLength(3);
    const res = verifyJsonl(jsonl);
    expect(res).toMatchObject({ ok: true, rows: 3 });
  });

  it("detects a tampered row after export", async () => {
    const { log, state } = await freshLog();
    log.append({ actor: "a", event: "run_started", target: "t" });
    log.append({ actor: "a", event: "run_completed", target: "t" });
    const jsonl = exportJsonl(log.readForward());
    state.close();

    // Tamper with row #1's payload post-export.
    const tampered = jsonl
      .split("\n")
      .map((line, i) => {
        if (i !== 0 || !line) return line;
        const row = JSON.parse(line) as { payload: unknown };
        row.payload = { tampered: true };
        return JSON.stringify(row);
      })
      .join("\n");

    const res = verifyJsonl(tampered);
    expect(res.ok).toBe(false);
  });

  it("supports an incremental export anchored to a prior chain hash", async () => {
    const { log, state } = await freshLog();
    const a = log.append({ actor: "a", event: "run_started", target: "t" });
    log.append({ actor: "a", event: "run_completed", target: "t" });
    log.append({ actor: "a", event: "report_written", target: "t" });
    // Export only rows strictly after #1.
    const rows = log.readForward().filter((r) => r.seq > 1);
    const jsonl = exportJsonl(rows);
    state.close();

    const res = verifyJsonl(jsonl, a.hash);
    expect(res).toMatchObject({ ok: true, rows: 2 });
  });

  it("empty log → empty export → ok:true rows:0", () => {
    expect(verifyJsonl("")).toMatchObject({ ok: true, rows: 0 });
  });
});
