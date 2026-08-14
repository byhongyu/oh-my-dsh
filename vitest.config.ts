import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@oh-my-dsh/schema": `${root}packages/schema/src/index.ts`,
      "@oh-my-dsh/catalog": `${root}packages/catalog/src/index.ts`,
      "@oh-my-dsh/core": `${root}packages/core/src/index.ts`,
      "@oh-my-dsh/adapter-dsh-rc5": `${root}packages/adapter-dsh-rc5/src/index.ts`,
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "scenarios/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/*/src/**/*.ts"],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
