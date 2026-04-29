// Binary entry point. Kept as a single-file shim so importing src/cli.ts
// under test never triggers command dispatch (which would parse vitest's
// argv and crash). bin/shipreport.js dynamic-imports this file.
//
// Error UX: citty's `runMain` calls `console.error(error, "\n")` for any
// non-`CLIError` exception, which dumps the full Error object including
// stack frames. Operator-actionable errors (Zod validation messages,
// "GitHub token not set", invalid cron, etc.) read more cleanly as a
// single line on stderr — no stack, no internal frames. We replicate
// citty's help/version flag handling and dispatch via `runCommand`
// directly so we own the catch block.
//
// Set `SHIPREPORT_DEBUG=1` to force the full Error (including stack) on
// every error path for local debugging.
import { runCommand, showUsage } from "citty";
import { main } from "./cli.js";

async function dispatch(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const helpFlags = new Set(["--help", "-h"]);
  const versionFlags = new Set(["--version"]);

  if (rawArgs.some((a) => helpFlags.has(a))) {
    await showUsage(main);
    return;
  }
  if (rawArgs.length === 1 && versionFlags.has(rawArgs[0]!)) {
    // `meta` on a defineCommand literal is a plain object in shipreport's
    // src/cli.ts, but citty's CommandDef typing allows function/promise
    // forms too. Resolve uniformly without relying on internal helpers.
    const rawMeta = main.meta;
    const meta =
      typeof rawMeta === "function"
        ? await (rawMeta as () => unknown)()
        : await rawMeta;
    const version = (meta as { version?: string } | undefined)?.version;
    if (!version) {
      throw new Error("No version specified");
    }
    console.log(version);
    return;
  }
  await runCommand(main, { rawArgs });
}

dispatch().catch((err: unknown) => {
  if (process.env.SHIPREPORT_DEBUG === "1") {
    console.error(err);
    process.exit(1);
  }
  if (err instanceof Error && typeof err.message === "string" && err.message) {
    console.error(`shipreport: ${err.message}`);
    process.exit(1);
  }
  // Unexpected non-Error throw — print verbatim so we don't lose signal.
  console.error(err);
  process.exit(1);
});
