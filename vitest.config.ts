import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    server: {
      deps: {
        // Node 22+ built-ins — don't let Vite try to bundle them.
        external: [/^node:/, "sqlite"],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        // pure type declarations, no runtime statements
        "src/types.ts",
        "src/templates/**",
        // cli-main.ts is a 1-line wrapper that only runMain(main)s — its
        // sole purpose is to keep src/cli.ts side-effect-free under test.
        // Exercised by the bin/shipreport.js entrypoint at runtime.
        "src/cli-main.ts",
      ],
      thresholds: {
        // Global totals — the suite as a whole must stay at this floor.
        // Real reachable code coverage; defensive / Chromium-runtime
        // branches are c8-ignored individually with rationale comments.
        lines: 95,
        functions: 95,
        branches: 85,
        statements: 95,

        // Per-glob: the audit chain and signing path are SOC2 evidence
        // surfaces. They get a stricter floor that does not inherit
        // from the global block above. (Vitest's per-glob thresholds
        // REPLACE — not extend — the global ones for matching files.)
        "src/audit.ts": {
          lines: 100,
          functions: 100,
          branches: 95,
          statements: 100,
        },
        "src/audit-export.ts": {
          lines: 100,
          functions: 100,
          branches: 90,
          statements: 100,
        },
        "src/sign.ts": {
          lines: 100,
          functions: 100,
          branches: 85,
          statements: 100,
        },
        "src/state.ts": {
          lines: 100,
          functions: 100,
          branches: 90,
          statements: 100,
        },
      },
    },
  },
  ssr: {
    external: ["node:sqlite", "sqlite"],
  },
  resolve: {
    extensions: [".ts", ".js", ".json"],
  },
});
