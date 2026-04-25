import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    server: {
      deps: {
        // Node 22 built-ins — don't let Vite try to bundle them.
        external: [/^node:/, "sqlite"],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        // citty dispatch layer; exercised end-to-end not unit-tested
        "src/cli.ts",
        // pure type declarations, no runtime statements
        "src/types.ts",
        // Octokit transport wrapper; behaviour under test is in the stub
        // clients used by extract tests — wrapping Octokit itself has no
        // branch logic worth mocking
        "src/github.ts",
        "src/templates/**",
      ],
      thresholds: {
        // Locked to the levels achieved by the suite that ships with
        // the repo. Defensive / Chromium-runtime branches are explicitly
        // c8-ignored where unreachable from unit tests; the percentages
        // below represent real reachable code coverage.
        lines: 95,
        functions: 95,
        branches: 88,
        statements: 95,
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
