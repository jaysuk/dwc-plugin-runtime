import { describe, expect, it, vi } from "vitest";

import {
	applyUpdate, checkForUpdate, cleanReleaseNotes, compareVersions, fetchReleaseHistory,
	formatReleaseNotesHtml, isDwcCompatible,
} from "../src/updates.js";

// ────────────────────────────────────────────────────────────────────────────
// cleanReleaseNotes
// ────────────────────────────────────────────────────────────────────────────

const FOOTER = `
---

### 📦 Install
1. Download the ZIP.

> Built against **DuetWebControl 3.7.0**.

<!-- dwc-plugin-update {"version":"1.0.20","dwcVersion":"3.7","asset":"FlexibleLayouts-1.0.20.zip"} -->
`;

describe("cleanReleaseNotes", () => {
	it("strips the machine-readable comment", () => {
		const body = 'changelog\n<!-- dwc-plugin-update {"v":"1"} -->\nmore';
		const result = cleanReleaseNotes(body);
		expect(result).not.toContain("dwc-plugin-update");
		expect(result).toContain("changelog");
	});

	it("strips the static footer (--- + Install heading onward)", () => {
		const body = "## Changelog\n- did a thing\n" + FOOTER;
		const result = cleanReleaseNotes(body);
		expect(result).toContain("did a thing");
		expect(result).not.toContain("📦 Install");
		expect(result).not.toContain("dwc-plugin-update");
	});

	it("returns trimmed body minus comment when no footer marker found", () => {
		const body = "  - fix: something\n- feat: other  ";
		expect(cleanReleaseNotes(body)).toBe("- fix: something\n- feat: other");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// formatReleaseNotesHtml
// ────────────────────────────────────────────────────────────────────────────

describe("formatReleaseNotesHtml", () => {
	it("HTML-escapes <script> tags (XSS prevention)", () => {
		const html = formatReleaseNotesHtml("<script>alert(1)</script>");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("escapes & and quotes", () => {
		const html = formatReleaseNotesHtml('Tom & Jerry "quoted"');
		expect(html).toContain("&amp;");
		expect(html).toContain("&quot;");
	});

	it("renders ### heading as <h4>", () => {
		const html = formatReleaseNotesHtml("### My Heading");
		expect(html).toContain("<h4");
		expect(html).toContain("My Heading");
	});

	it("renders ## heading as <h4>", () => {
		const html = formatReleaseNotesHtml("## Another");
		expect(html).toContain("<h4");
	});

	it("renders **bold** as <strong>", () => {
		const html = formatReleaseNotesHtml("Some **bold** text");
		expect(html).toContain("<strong>bold</strong>");
	});

	it("renders bullet with bold correctly — <strong> not literal escaped tags", () => {
		// This was the bug: `- **scope:** msg` was rendering &lt;strong&gt; inside bullets.
		const html = formatReleaseNotesHtml("- **scope:** fixed it");
		expect(html).toContain("<strong>scope:</strong>");
		expect(html).not.toContain("&lt;strong&gt;");
		expect(html).toContain("•");
	});

	it("renders `code` as <code>", () => {
		const html = formatReleaseNotesHtml("Run `npm install`");
		expect(html).toContain("<code>npm install</code>");
	});

	it("renders --- as <hr>", () => {
		const html = formatReleaseNotesHtml("---");
		expect(html).toContain("<hr");
	});

	it("renders blank line as spacer div", () => {
		const html = formatReleaseNotesHtml("line1\n\nline2");
		expect(html).toContain('height:0.4em');
	});
});

// ────────────────────────────────────────────────────────────────────────────
// fetchReleaseHistory
// ────────────────────────────────────────────────────────────────────────────

function listReleaseResponse(releases: unknown[]) {
	return { ok: true, status: 200, json: async () => releases } as unknown as Response;
}

describe("fetchReleaseHistory", () => {
	it("filters out releases not newer than sinceVersion and sorts newest-first", async () => {
		const fetchImpl = vi.fn(async () => listReleaseResponse([
			{ tag_name: "v1.0.20", name: "Savasana", body: "feat: gallery", draft: false },
			{ tag_name: "v1.0.19", name: "Warrior", body: "fix: something", draft: false },
			{ tag_name: "v1.0.18", name: "Cobra", body: "chore: bump", draft: false },
		]));
		const result = await fetchReleaseHistory({
			owner: "jaysuk", repo: "Demo", sinceVersion: "1.0.19",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		// Only v1.0.20 is newer than 1.0.19
		expect(result).toHaveLength(1);
		expect(result[0].version).toBe("1.0.20");
		expect(result[0].name).toBe("Savasana");
	});

	it("excludes drafts", async () => {
		const fetchImpl = vi.fn(async () => listReleaseResponse([
			{ tag_name: "v1.0.21", name: "Draft", body: "", draft: true },
			{ tag_name: "v1.0.20", name: "Published", body: "", draft: false },
		]));
		const result = await fetchReleaseHistory({
			owner: "jaysuk", repo: "Demo", sinceVersion: "1.0.19",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result.every((r) => r.name !== "Draft")).toBe(true);
	});

	it("returns [] and never throws on a failed fetch", async () => {
		const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
		const result = await fetchReleaseHistory({
			owner: "jaysuk", repo: "Demo", sinceVersion: "1.0.0",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toEqual([]);
	});

	it("returns [] on non-ok HTTP response", async () => {
		const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 } as unknown as Response));
		const result = await fetchReleaseHistory({
			owner: "jaysuk", repo: "Demo", sinceVersion: "1.0.0",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toEqual([]);
	});

	it("applies cleanReleaseNotes to strip footer from notes", async () => {
		const body = "- feat: gallery\n---\n### 📦 Install\ndownload it\n<!-- dwc-plugin-update {} -->";
		const fetchImpl = vi.fn(async () => listReleaseResponse([
			{ tag_name: "v1.0.20", name: "Release", body, draft: false },
		]));
		const result = await fetchReleaseHistory({
			owner: "jaysuk", repo: "Demo", sinceVersion: "1.0.19",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result[0].notes).not.toContain("📦 Install");
		expect(result[0].notes).not.toContain("dwc-plugin-update");
		expect(result[0].notes).toContain("feat: gallery");
	});
});

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

	it("defaults to a zip that isn't the srcmap bundle, even when GitHub lists it first", async () => {
		// A release commonly carries both -- order is whatever GitHub returns, not guaranteed.
		const assets = [
			{ name: "Demo-1.0.1-srcmap.zip", browser_download_url: "https://example/Demo-1.0.1-srcmap.zip" },
			{ name: "Demo-1.0.1.zip", browser_download_url: "https://example/Demo-1.0.1.zip" },
		];
		const fetchImpl = vi.fn(async () => releaseResponse({ tag_name: "v1.0.1", assets }));
		const r = await checkForUpdate({ ...base, assets: undefined, fetchImpl: fetchImpl as unknown as typeof fetch });
		expect(r.assetName).toBe("Demo-1.0.1.zip");
		expect(r.assetUrl).toBe("https://example/Demo-1.0.1.zip");
	});

	it("an explicit assetPattern still overrides the default", async () => {
		const assets = [
			{ name: "Demo-1.0.1.zip", browser_download_url: "https://example/Demo-1.0.1.zip" },
			{ name: "Demo-1.0.1-debug.zip", browser_download_url: "https://example/Demo-1.0.1-debug.zip" },
		];
		const fetchImpl = vi.fn(async () => releaseResponse({ tag_name: "v1.0.1", assets }));
		const r = await checkForUpdate({
			...base, assets: undefined, assetPattern: /^Demo-[\d.]+-debug\.zip$/i,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(r.assetName).toBe("Demo-1.0.1-debug.zip");
	});

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
	it("downloads the asset and hands the blob to the injected installer", async () => {
		// Create a minimal valid ZIP blob for download simulation.
		const { default: JSZip } = await import("jszip");
		const zipBlob = await new JSZip().generateAsync({ type: "blob" });
		const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, blob: async () => zipBlob } as unknown as Response));
		const installPlugin = vi.fn(async () => {});
		await applyUpdate({
			assetUrl: "https://example/Demo-1.0.1.zip", assetName: "Demo-1.0.1.zip",
			installPlugin, fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(installPlugin).toHaveBeenCalledOnce();
		expect(installPlugin.mock.calls[0][0]).toBe("Demo-1.0.1.zip");
		expect(installPlugin.mock.calls[0][1]).toBeInstanceOf(Blob);
		expect(installPlugin.mock.calls[0][2]).toBe(true);
	});

	it("throws on a failed download", async () => {
		const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 } as unknown as Response));
		await expect(applyUpdate({
			assetUrl: "x", assetName: "x.zip", installPlugin: async () => {},
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})).rejects.toThrow();
	});
});
