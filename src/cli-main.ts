// Binary entry point. Kept as a single-line shim so importing src/cli.ts
// under test never triggers runMain (which would parse vitest's argv and
// crash). bin/shipreport.js dynamic-imports this file.
import { runMain } from "citty";
import { main } from "./cli.js";

runMain(main);
