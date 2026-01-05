import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		exclude: ["node_modules", "dist"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["src/**/*.ts"],
			exclude: [
				"src/index.ts",
				"src/telemetry/instrumentation.ts",
				"src/config.ts",
				"src/db/index.ts",
			],
		},
		setupFiles: ["./tests/setup.ts"],
		mockReset: true,
		restoreMocks: true,
	},
});
