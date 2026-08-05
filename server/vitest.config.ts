import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/dist/**", "**/node_modules/**"],
    include: ["src/**/*.test.ts"],
    // Coverage focuses on the pure logic modules that are unit-testable.
    // Entry points, socket wiring, and process spawning are excluded because
    // they require a live Claude CLI / sockets and are exercised by manual runs.
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/__tests__/**",
        "src/index.ts",
        "src/types/**",
        "src/**/*.d.ts",
      ],
    },
  },
});
