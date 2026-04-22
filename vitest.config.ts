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
  },
  ssr: {
    external: ["node:sqlite", "sqlite"],
  },
  resolve: {
    extensions: [".ts", ".js", ".json"],
  },
});
