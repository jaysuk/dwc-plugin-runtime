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
	/** Matches the ZIP asset among a release's assets. Defaults to the first `*.zip`. */
	assetPattern?: RegExp;
	/** Injectable for tests / non-browser. Defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
}

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
	const assetPattern = options.assetPattern ?? /\.zip$/i;

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
