#!/usr/bin/env node
// Targeted suppression of Node's `node:sqlite` ExperimentalWarning at the
// binary boundary only. shipreport requires Node >=22.13.0 where the
// module is unflagged but Node still prints one warning per process.
// Operators see it as spurious. The test suite does NOT install this
// shim, so any OTHER experimental warning (e.g. a future built-in
// shipreport accidentally pulls in) still surfaces loudly during CI.
//
// Implementation note: Node prints warnings via its default handler
// regardless of whether a `'warning'` listener is attached, so a
// listener alone cannot suppress them. Shadowing `process.emit` for
// the targeted warning is the supported pattern (see Node issue
// nodejs/node#30810). Other warnings pass through untouched.
const __originalEmit = process.emit;
process.emit = function (event, ...args) {
  if (
    event === "warning" &&
    args[0] &&
    args[0].name === "ExperimentalWarning" &&
    typeof args[0].message === "string" &&
    args[0].message.includes("SQLite is an experimental feature")
  ) {
    return false;
  }
  return __originalEmit.apply(this, [event, ...args]);
};

import("../dist/cli-main.js").catch((err) => {
  console.error("shipreport failed to start:", err?.message ?? err);
  process.exit(1);
});
