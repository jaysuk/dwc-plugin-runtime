/**
 * Self-update support for DuetWebControl (Vue 3) plugins: check GitHub Releases for a newer build and
 * apply it in one click (fetch the ZIP, hand it to DWC's installer, which hot-reloads the bundle).
 *
 * Deliberately store-agnostic, like the rest of this package: it reads the running DWC version from
 * the global `window.DWC.version` (DWC 3.7.0-alpha.7+) and takes the actual install action as an
 * injected callback, so it never imports `@/stores/*`. The consuming plugin wires
 * `useMachineStore().installPlugin` in. DWC 3.7 dd57f65+ has optional JSZip in installPlugin, so
 * the plugin can just pass a blob and DWC reconstructs it — zero bundled deps. No telemetry beyond
 * the GitHub API calls the plugin opts into.
 *
 * Two scenarios are distinguished so the UI can guide the user:
 *  - `pluginUpdate` — a newer release that's compatible with the DWC they're running (one-click apply);
 *  - `dwcUpdate`   — a newer release that needs a newer DWC than they have (update DWC first).
 */

/** Outcome of a version check. `updateAvailable` is true for both `pluginUpdate` and `dwcUpdate`. */
export type UpdateScenario = "upToDate" | "pluginUpdate" | "dwcUpdate" | "unknown";

export interface UpdateResult {
	scenario: UpdateScenario;
	updateAvailable: boolean;
	currentVersion: string;
	latestVersion: string | null;
	releaseUrl: string | null;
	/** Direct download URL of the plugin ZIP asset, or null if none was found. */
	assetUrl: string | null;
	assetName: string | null;
	/** DWC version the release was built for (its resolved plugin.json `dwcVersion`), if published. */
	requiredDwc: string | null;
	runningDwc: string | null;
	/** Whether the running DWC satisfies the release's requirement (mirrors DWC's own install gate). */
	dwcCompatible: boolean;
	notes: string | null;
	/** Set when the check itself failed (offline, rate-limited, CORS) — treated as "unknown", never throws. */
	error?: string;
}

export interface CheckForUpdateOptions {
	/** GitHub repo owner, e.g. "jaysuk". */
	owner: string;
	/** GitHub repo name, e.g. "Flexible-Layouts". */
	repo: string;
	/** The plugin's currently-installed version (from its plugin.json). */
	currentVersion: string;
	/** Running DWC version. Defaults to `window.DWC.version`. */
	dwcVersion?: string;
	/**
	 * Matches the ZIP asset among a release's assets. Defaults to the first ZIP that doesn't look
	 * like a source-map bundle (dwc-plugin-test-kit's `verify-build` publishes both
	 * `<Plugin>-<version>.zip` and `<Plugin>-<version>-srcmap.zip` as separate release assets) — see
	 * DEFAULT_ASSET_PATTERN. Still narrower and safer to pass an explicit pattern anchored to your
	 * own plugin's exact filename (`duet-tool-align` and `duet-eddy-align` both do); this default is
	 * a safety net for whoever doesn't, not a reason to skip it.
	 */
	assetPattern?: RegExp;
	/** Injectable for tests / non-browser. Defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * Any `.zip` NOT ending `-srcmap.zip`. A release commonly carries both the installable plugin ZIP
 * and a separate debug source-map ZIP (dwc-plugin-test-kit's `verify-build`); GitHub's asset order
 * isn't guaranteed, so matching "any zip" and taking the first hit can silently pick the srcmap one
 * instead — this is exactly the bug duet-tool-align hit for real before anchoring its own pattern.
 * A negative lookbehind, not a substring/"contains" check, so a real plugin whose own name happens
 * to contain "srcmap" wouldn't be excluded by accident.
 */
export const DEFAULT_ASSET_PATTERN = /(?<!-srcmap)\.zip$/i;

/** Read the running DWC version exposed on the global API surface (alpha.7+); null on older builds. */
export function runningDwcVersion(): string | null {
	const dwc = (globalThis as { DWC?: { version?: string } }).DWC;
	return dwc && typeof dwc.version === "string" ? dwc.version : null;
}

interface Parsed { nums: Array<number>; pre: string }
function parseVersion(v: string): Parsed {
	const [core, pre = ""] = v.replace(/^[vV]/, "").split(/[-+]/, 2);
	return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre };
}

// Compare dot-separated prerelease fields with semver precedence: numeric fields compared
// numerically, numeric < alphanumeric, and a shorter field set has lower precedence (1.0.0-rc <
// 1.0.0-rc.1). An absent prerelease (a full release) outranks any prerelease.
function comparePrerelease(a: string, b: string): number {
	if (a === b) return 0;
	if (!a) return 1;
	if (!b) return -1;
	const as = a.split(".");
	const bs = b.split(".");
	for (let i = 0; i < Math.max(as.length, bs.length); i++) {
		const x = as[i];
		const y = bs[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const xn = /^\d+$/.test(x);
		const yn = /^\d+$/.test(y);
		if (xn && yn) {
			const d = parseInt(x, 10) - parseInt(y, 10);
			if (d !== 0) return d;
		} else if (xn !== yn) {
			return xn ? -1 : 1; // numeric identifiers have lower precedence than alphanumeric
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

/**
 * Semver-ish compare of two plugin versions. Returns >0 if `a` is newer than `b`. A release
 * (no prerelease tag) sorts after its prereleases (1.0.0 > 1.0.0-rc.1).
 */
export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
		const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
		if (d !== 0) return d;
	}
	return comparePrerelease(pa.pre, pb.pre);
}

/**
 * Mirror of DWC's plugin-compat check (`checkVersion` in @/plugins): compare version segments up to
 * the shorter of the two and require every shared segment to match. We replicate it (rather than
 * import @/plugins) so the prediction exactly matches the gate DWC enforces at install time. So a
 * release built for "3.7" is compatible with any "3.7.x"; one built for the exact "3.7.0-alpha.7" is
 * compatible only with that prerelease.
 */
export function isDwcCompatible(required: string, running: string): boolean {
	if (!required) return true;
	const r = required.split(/[+.\-ab]/);
	const a = running.split(/[+.\-ab]/);
	for (let i = 0; i < Math.min(r.length, a.length); i++) {
		if (r[i] !== a[i]) return false;
	}
	return true;
}

// Releases carry a machine-readable hint emitted by the release workflow, e.g.
//   <!-- dwc-plugin-update {"dwcVersion":"3.7","asset":"FlexibleLayouts-1.0.15.zip"} -->
// so a single CORS-safe api.github.com call yields the DWC requirement too. Falls back to the
// human-readable "Built against DuetWebControl X" line the footer also prints.
function extractRequiredDwc(body: string): string | null {
	const tagged = body.match(/<!--\s*dwc-plugin-update\s*({[\s\S]*?})\s*-->/);
	if (tagged) {
		try {
			const meta = JSON.parse(tagged[1]) as { dwcVersion?: string };
			if (meta.dwcVersion) return meta.dwcVersion;
		} catch {
			/* fall through */
		}
	}
	const built = body.match(/Built against \*?\*?DuetWebControl\*?\*?\s+([0-9][^\s)(*`]*)/i);
	return built ? built[1] : null;
}

interface GhRelease {
	tag_name: string;
	html_url: string;
	body?: string;
	assets?: Array<{ name: string; browser_download_url: string }>;
}

/**
 * Check GitHub for a newer release of the plugin and classify it. Never throws — a failed fetch
 * (offline / rate-limited / CORS) resolves to `scenario: "unknown"` with `error` set, so callers can
 * stay silent. Uses the `releases/latest` endpoint (api.github.com sends permissive CORS).
 */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateResult> {
	const { owner, repo, currentVersion } = options;
	const doFetch = options.fetchImpl ?? fetch;
	const runningDwc = options.dwcVersion ?? runningDwcVersion();
	const assetPattern = options.assetPattern ?? DEFAULT_ASSET_PATTERN;

	const base: UpdateResult = {
		scenario: "unknown", updateAvailable: false, currentVersion,
		latestVersion: null, releaseUrl: null, assetUrl: null, assetName: null,
		requiredDwc: null, runningDwc, dwcCompatible: true, notes: null,
	};

	let release: GhRelease;
	try {
		const res = await doFetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
			headers: { Accept: "application/vnd.github+json" },
		});
		if (!res.ok) {
			return { ...base, error: `GitHub returned ${res.status}` };
		}
		release = (await res.json()) as GhRelease;
	} catch (e) {
		return { ...base, error: (e as Error).message };
	}

	const latestVersion = (release.tag_name || "").replace(/^[vV]/, "");
	const asset = (release.assets ?? []).find((a) => assetPattern.test(a.name));
	const requiredDwc = extractRequiredDwc(release.body ?? "");
	const dwcCompatible = !requiredDwc || !runningDwc || isDwcCompatible(requiredDwc, runningDwc);

	const result: UpdateResult = {
		...base,
		latestVersion,
		releaseUrl: release.html_url || null,
		assetUrl: asset?.browser_download_url ?? null,
		assetName: asset?.name ?? null,
		requiredDwc,
		dwcCompatible,
		notes: release.body ?? null,
	};

	if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) {
		return { ...result, scenario: "upToDate", updateAvailable: false };
	}
	return {
		...result,
		updateAvailable: true,
		scenario: dwcCompatible ? "pluginUpdate" : "dwcUpdate",
	};
}

/**
 * Strip the machine-readable comment and the static release footer from a release body, leaving
 * only the human-readable changelog. The footer begins with a `---` rule that immediately precedes
 * the `### 📦 Install` heading (or any `### ` heading that follows the rule). Trims surrounding
 * whitespace.
 */
export function cleanReleaseNotes(body: string): string {
	// Remove the machine-readable comment wherever it appears.
	let s = body.replace(/<!--\s*dwc-plugin-update\s*{[\s\S]*?}\s*-->/g, "");
	// Strip everything from the `---` line immediately before the Install heading onward.
	// The footer pattern: a `---` line, then (after optional blank lines) a `### ` heading.
	s = s.replace(/\r?\n---\r?\n(?:[\s\S]*?(?:\r?\n|^))?### 📦 Install[\s\S]*/m, "");
	// Fallback: strip a trailing `---` line if no heading was found (keeps changelog clean).
	s = s.replace(/\r?\n---\s*$/, "");
	return s.trim();
}

/**
 * HTML-escape a plain text string (no DOM dependency — pure string replace).
 * MUST be called before any HTML transforms so user content cannot inject tags.
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Convert a (already-cleaned) Markdown release-notes string to a simple HTML fragment suitable for
 * `v-html` / `innerHTML`. Security: HTML-escapes each line first, then applies transforms on the
 * escaped text — so `<script>` in user content comes out as `&lt;script&gt;`, never executed.
 *
 * Supported transforms (applied in this order per line after escaping):
 *  - `### ` / `## ` headings → `<h4>` with inline style
 *  - `**bold**` → `<strong>`
 *  - `` `code` `` → `<code>`
 *  - Lines starting `- ` → bullet div (after bold/code so bold bullets render correctly)
 *  - Lines starting `&gt; ` (escaped `> ` blockquote) → muted div
 *  - `---` alone → `<hr>`
 *  - Blank lines → spacer div
 *  - Everything else → plain `<div>` paragraph
 */
export function formatReleaseNotesHtml(markdown: string): string {
	const lines = markdown.split(/\r?\n/);
	const parts: string[] = [];

	for (const raw of lines) {
		// Step 1: HTML-escape the raw line so any HTML special chars are neutralised.
		let line = escapeHtml(raw);

		// Step 2: apply inline transforms on the escaped text.
		// Bold — match **..** (may appear on heading or bullet lines too).
		line = line.replace(/\*\*([\s\S]*?)\*\*/g, "<strong>$1</strong>");
		// Inline code — match `..`
		line = line.replace(/`([^`]+)`/g, "<code>$1</code>");

		// Step 3: block-level classification.
		if (/^###\s+/.test(line)) {
			// h3 → h4 with styling
			const text = line.replace(/^###\s+/, "");
			parts.push(`<h4 style="margin:0.6em 0 0.2em;font-weight:600">${text}</h4>`);
		} else if (/^##\s+/.test(line)) {
			const text = line.replace(/^##\s+/, "");
			parts.push(`<h4 style="margin:0.8em 0 0.25em;font-weight:700">${text}</h4>`);
		} else if (/^-\s/.test(line)) {
			// Bullet (raw line starts with `- `, so after escaping it's still `- `)
			const text = line.replace(/^-\s/, "");
			parts.push(`<div style="margin-left:1em">• ${text}</div>`);
		} else if (/^&gt;\s/.test(line)) {
			// Blockquote (raw `> ` → escaped `&gt; `)
			const text = line.replace(/^&gt;\s/, "");
			parts.push(`<div style="color:var(--v-medium-emphasis-opacity,0.6);padding-left:0.75em;border-left:2px solid currentColor">${text}</div>`);
		} else if (line === "---") {
			parts.push(`<hr style="margin:0.5em 0;opacity:0.3">`);
		} else if (line.trim() === "") {
			parts.push(`<div style="height:0.4em"></div>`);
		} else {
			parts.push(`<div>${line}</div>`);
		}
	}
	return parts.join("\n");
}

/** A single release entry from fetchReleaseHistory. */
export interface ReleaseHistoryEntry {
	/** Version string (tag minus leading `v`). */
	version: string;
	/** Human-readable release name, or the tag if the release has no name. */
	name: string;
	/** Cleaned release notes (comment + footer stripped). */
	notes: string;
}

export interface FetchReleaseHistoryOptions {
	/** GitHub repo owner. */
	owner: string;
	/** GitHub repo name. */
	repo: string;
	/**
	 * Only include releases NEWER than this version (the currently-installed version). Pass "0.0.0"
	 * to get all releases.
	 */
	sinceVersion: string;
	/** Injectable for tests / non-browser. Defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * Fetch the last 20 GitHub releases for a repo and return those newer than `sinceVersion`, sorted
 * newest-first. Drafts are excluded. Never throws — returns [] on any network or parse error.
 */
export async function fetchReleaseHistory(options: FetchReleaseHistoryOptions): Promise<ReleaseHistoryEntry[]> {
	const { owner, repo, sinceVersion } = options;
	const doFetch = options.fetchImpl ?? fetch;

	interface GhListRelease {
		tag_name: string;
		name?: string;
		body?: string;
		draft?: boolean;
	}

	let releases: GhListRelease[];
	try {
		const res = await doFetch(
			`https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`,
			{ headers: { Accept: "application/vnd.github+json" } },
		);
		if (!res.ok) return [];
		releases = (await res.json()) as GhListRelease[];
	} catch {
		return [];
	}

	try {
		return releases
			.filter((r) => !r.draft)
			.map((r) => {
				const version = (r.tag_name || "").replace(/^[vV]/, "");
				return {
					version,
					name: (r.name && r.name.trim()) ? r.name.trim() : r.tag_name,
					notes: cleanReleaseNotes(r.body ?? ""),
				};
			})
			.filter((r) => r.version && compareVersions(r.version, sinceVersion) > 0)
			.sort((a, b) => compareVersions(b.version, a.version));
	} catch {
		return [];
	}
}

export interface ApplyUpdateOptions {
	/** Direct ZIP URL (UpdateResult.assetUrl). */
	assetUrl: string;
	/** Filename for the upload (UpdateResult.assetName). */
	assetName: string;
	/**
	 * DWC's installer, injected by the plugin: `(filename, blob, start) => Promise<void>`.
	 * Pass `useMachineStore().installPlugin`. DWC 3.7+ validates the manifest + DWC compatibility,
	 * uploads the ZIP (optionally reconstructing JSZip from the blob), and hot-loads the bundle.
	 */
	installPlugin: (filename: string, blob: Blob, start: boolean) => Promise<void>;
	/** Start (hot-reload) the plugin after install. Default true. */
	start?: boolean;
	/** Injectable for tests. Defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * Download a release ZIP and install it through DWC — the one-click apply. Throws on a failed
 * download (the GitHub asset CDN may not allow cross-origin fetch in every browser; callers should
 * catch and offer the release page as a manual fallback) or a failed install.
 */
export async function applyUpdate(options: ApplyUpdateOptions): Promise<void> {
	const doFetch = options.fetchImpl ?? fetch;
	const res = await doFetch(options.assetUrl);
	if (!res.ok) {
		throw new Error(`Could not download the update (${res.status})`);
	}
	const blob = await res.blob();
	await options.installPlugin(options.assetName, blob, options.start ?? true);
}
