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
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
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
