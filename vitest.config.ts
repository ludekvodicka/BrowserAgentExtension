import { defineConfig } from "vitest/config";

// CLI discovery sees every real named pipe, including those created by another test file.
export default defineConfig({ test: { include: ["**/tests/*.test.ts"], testTimeout: 10000, fileParallelism: false } });
