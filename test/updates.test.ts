import { describe, expect, it, vi } from "vitest";

import { applyUpdate, checkForUpdate, compareVersions, isDwcCompatible } from "../src/updates.js";

describe("compareVersions", () => {
	it("orders numeric segments", () => {
		expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0", "1.1.0")).toBeLessThan(0);
		expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
	});
	it("sorts a release after its prereleases and tolerates a leading v", () => {
		expect(compareVersions("v1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
	});
});

describe("isDwcCompatible (mirrors DWC's prefix check)", () => {
	it("matches on the shared prefix", () => {
		expect(isDwcCompatible("3.7", "3.7.0-alpha.8")).toBe(true); // built for the 3.7 line
		expect(isDwcCompatible("3.7.0-alpha.7", "3.7.0-alpha.7")).toBe(true); // exact prerelease
		expect(isDwcCompatible("3.7.0-alpha.7", "3.7.0-alpha.8")).toBe(false); // pinned prerelease mismatch
		expect(isDwcCompatible("3.7", "3.8.0")).toBe(false); // newer minor
	});
	it("treats an empty requirement as compatible", () => {
		expect(isDwcCompatible("", "3.7.0")).toBe(true);
	});
});

function releaseResponse(body: Partial<{ tag_name: string; html_url: string; body: string; assets: Array<{ name: string; browser_download_url: string }> }>) {
	return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe("checkForUpdate", () => {
	const base = {
		owner: "jaysuk", repo: "Demo", currentVersion: "1.0.0", dwcVersion: "3.7.0-alpha.7",
		assets: [{ name: "Demo-1.0.1.zip", browser_download_url: "https://example/Demo-1.0.1.zip" }],
	};

	it("flags a compatible plugin update", async () => {
		const fetchImpl = vi.fn(async () => releaseResponse({
			tag_name: "v1.0.1", html_url: "https://example/r", assets: base.assets,
			body: 'notes\n<!-- dwc-plugin-update {"dwcVersion":"3.7"} -->',
		}));
		const r = await checkForUpdate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
		expect(r.scenario).toBe("pluginUpdate");
		expect(r.updateAvailable).toBe(true);
		expect(r.latestVersion).toBe("1.0.1");
		expect(r.assetUrl).toBe("https://example/Demo-1.0.1.zip");
		expect(r.dwcCompatible).toBe(true);
	});

	it("flags an update that needs a newer DWC", async () => {
		const fetchImpl = vi.fn(async () => releaseResponse({
			tag_name: "v2.0.0", html_url: "https://example/r", assets: base.assets,
			body: '<!-- dwc-plugin-update {"dwcVersion":"3.8"} -->',
		}));
		const r = await checkForUpdate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
		expect(r.scenario).toBe("dwcUpdate");
		expect(r.updateAvailable).toBe(true);
		expect(r.dwcCompatible).toBe(false);
		expect(r.requiredDwc).toBe("3.8");
	});

	it("reports up to date when the latest is not newer", async () => {
		const fetchImpl = vi.fn(async () => releaseResponse({ tag_name: "v1.0.0", assets: base.assets }));
		const r = await checkForUpdate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
		expect(r.scenario).toBe("upToDate");
		expect(r.updateAvailable).toBe(false);
	});

	it("never throws on a failed fetch — returns unknown with an error", async () => {
		const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
		const r = await checkForUpdate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
		expect(r.scenario).toBe("unknown");
		expect(r.error).toBe("offline");
		expect(r.updateAvailable).toBe(false);
	});

	it("falls back to the 'Built against' line when no tagged metadata", async () => {
		const fetchImpl = vi.fn(async () => releaseResponse({
			tag_name: "v1.0.1", assets: base.assets,
			body: "> 🔧 Built against **DuetWebControl 3.7.0-alpha.7** (`abc`, ref `v3.7-dev`).",
		}));
		const r = await checkForUpdate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
		expect(r.requiredDwc).toBe("3.7.0-alpha.7");
		expect(r.scenario).toBe("pluginUpdate");
	});
});

describe("applyUpdate", () => {
	it("downloads the asset and hands a JSZip to the injected installer", async () => {
		// A minimal valid ZIP (empty archive) so JSZip.loadAsync succeeds.
		const { default: JSZip } = await import("jszip");
		const blob = await new JSZip().generateAsync({ type: "blob" });
		const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob } as unknown as Response));
		const installPlugin = vi.fn(async () => {});
		await applyUpdate({
			assetUrl: "https://example/Demo-1.0.1.zip", assetName: "Demo-1.0.1.zip",
			installPlugin, fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(installPlugin).toHaveBeenCalledOnce();
		expect(installPlugin.mock.calls[0][0]).toBe("Demo-1.0.1.zip");
		expect(installPlugin.mock.calls[0][3]).toBe(true);
	});

	it("throws on a failed download", async () => {
		const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 } as unknown as Response));
		await expect(applyUpdate({
			assetUrl: "x", assetName: "x.zip", installPlugin: async () => {},
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})).rejects.toThrow();
	});
});
