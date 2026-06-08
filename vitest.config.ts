import { defineConfig } from "vitest/config";

// Pure-logic + DOM-light self-tests for the runtime helpers (happy-dom supplies navigator/window).
export default defineConfig({
	test: {
		environment: "happy-dom",
		include: ["test/**/*.test.ts"],
		coverage: { provider: "v8", include: ["src/**"], reporter: ["text", "text-summary"] },
	},
});
