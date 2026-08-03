import { describe, expect, it } from "vitest";

// Imports the BUILT artifact (run `npm run build` first; CI builds before testing). Guards against
// the ESM-output trap where tsc emits extensionless relative specifiers that Node/Vite can't resolve
// — importing dist here fails loudly if that regresses, which src-only tests wouldn't catch.
describe("built dist resolves as valid ESM", () => {
	it("re-exports the public API from dist/index.js", async () => {
		const mod = await import("../dist/index.js");
		for (const name of ["buildReport", "sanitizeModel", "recordError", "installErrorCapture", "copyText", "downloadJson", "downloadBlob"]) {
			expect(typeof (mod as Record<string, unknown>)[name], name).toBe("function");
		}
	});

	it("the ./diagnostics subpath resolves", async () => {
		const mod = await import("../dist/diagnostics.js");
		expect(typeof mod.buildReport).toBe("function");
	});

	it("exports the HelpTip component (render-function, name + props)", async () => {
		const mod = await import("../dist/index.js") as { HelpTip?: { name?: string; props?: Record<string, unknown> } };
		expect(mod.HelpTip).toBeDefined();
		expect(mod.HelpTip?.name).toBe("HelpTip");
		expect(mod.HelpTip?.props).toHaveProperty("text");
		expect(mod.HelpTip?.props).toHaveProperty("href");
	});

	// Locks in that diagnosticState (the plugin-specific report payload passthrough) actually reached
	// the built artifact - this package has no Vuetify/DWC mount harness of its own, so the built
	// component's declared props are the cheapest thing that can be checked here; actual rendering is
	// exercised by consuming plugins' own smoke tests (dwc-plugin-test-kit).
	it("exports AboutDialog/AboutPanel with the diagnosticState prop", async () => {
		const mod = await import("../dist/index.js") as {
			AboutDialog?: { name?: string; props?: Record<string, unknown> };
			AboutPanel?: { name?: string; props?: Record<string, unknown> };
		};
		expect(mod.AboutDialog?.name).toBe("AboutDialog");
		expect(mod.AboutDialog?.props).toHaveProperty("diagnosticState");
		expect(mod.AboutPanel?.name).toBe("AboutPanel");
		expect(mod.AboutPanel?.props).toHaveProperty("diagnosticState");
	});
});
