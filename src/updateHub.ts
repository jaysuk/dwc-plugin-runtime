/**
 * Cross-plugin update hub.
 *
 * Several DWC plugins each check GitHub for their own updates, but they shouldn't each pop a separate
 * dialog. This is a tiny coordination layer living on the global `window`, so it works even though
 * every plugin bundles its OWN copy of this package: a plugin ANNOUNCES an available update into a
 * shared registry, and a host (typically the active custom-layout shell) reads the registry, listens
 * for changes, and shows ONE aggregated popup listing every plugin with an update. While a host is
 * active (claimUpdateHost) plugins should skip their own fallback notification, so there's no double-up.
 *
 * Store-agnostic like the rest of this package — pure window globals + a DOM CustomEvent, no @/… imports.
 */
import type { UpdateResult } from "./updates.js";

/** An announced update: a plugin's check result plus its identity. */
export interface AnnouncedUpdate extends UpdateResult {
	pluginId: string;
	name: string;
}

/** A plugin's own update check, registered so any UI (e.g. another plugin's "Check now") can trigger it. */
export type UpdateChecker = () => void | Promise<void>;

interface HubState {
	updates?: Map<string, AnnouncedUpdate>;
	hosts?: number;
	checkers?: Map<string, UpdateChecker>;
}

const KEY = "__dwcPluginUpdateHub";
const EVENT = "dwc-plugin-update";

function hub(): HubState {
	const g = globalThis as unknown as Record<string, HubState | undefined>;
	if (!g[KEY]) {
		g[KEY] = {};
	}
	return g[KEY] as HubState;
}
function registry(): Map<string, AnnouncedUpdate> {
	const h = hub();
	if (!h.updates) {
		h.updates = new Map();
	}
	return h.updates;
}
function emitChange(): void {
	try {
		window.dispatchEvent(new CustomEvent(EVENT));
	} catch {
		/* non-browser / no window — listeners only exist in the browser anyway */
	}
}

/** Record (or replace) a plugin's available update and notify any listening host. */
export function announceUpdate(pluginId: string, name: string, result: UpdateResult): void {
	registry().set(pluginId, { ...result, pluginId, name });
	emitChange();
}

/** Remove a plugin's announced update (no longer available, or just applied). */
export function clearAnnouncedUpdate(pluginId: string): void {
	if (registry().delete(pluginId)) {
		emitChange();
	}
}

/** Every currently-announced update. */
export function getAnnouncedUpdates(): Array<AnnouncedUpdate> {
	return [...registry().values()];
}

/** Subscribe to announce/clear changes. Returns an unsubscribe function. */
export function subscribeToUpdates(callback: () => void): () => void {
	const handler = (): void => callback();
	try {
		window.addEventListener(EVENT, handler);
	} catch {
		/* non-browser */
	}
	return () => {
		try {
			window.removeEventListener(EVENT, handler);
		} catch {
			/* ignore */
		}
	};
}

/**
 * Declare that a host (e.g. the active layout shell) will show the aggregated popup, so other plugins
 * skip their own fallback notification. Returns a release function — call it when the host unmounts.
 */
export function claimUpdateHost(): () => void {
	const h = hub();
	h.hosts = (h.hosts ?? 0) + 1;
	return () => {
		h.hosts = Math.max(0, (h.hosts ?? 1) - 1);
	};
}

/** Whether a host is currently present to show the aggregated popup. */
export function isUpdateHostActive(): boolean {
	return (hub().hosts ?? 0) > 0;
}

function checkers(): Map<string, UpdateChecker> {
	const h = hub();
	if (!h.checkers) {
		h.checkers = new Map();
	}
	return h.checkers;
}

/**
 * Register this plugin's update check with the shared hub so another plugin's "Check now" can trigger
 * it too. Keyed by plugin id (re-registering replaces). Returns an unregister function.
 */
export function registerUpdateChecker(pluginId: string, check: UpdateChecker): () => void {
	checkers().set(pluginId, check);
	return () => { hub().checkers?.delete(pluginId); };
}

/**
 * Run every registered plugin's update check (in parallel), so one plugin's "Check now" refreshes all
 * of them; each plugin re-announces its result into the hub. Never throws — a failing checker is
 * isolated from the rest.
 */
export async function runAllUpdateChecks(): Promise<void> {
	const all = [...checkers().values()];
	await Promise.all(all.map(async (check) => {
		try {
			await check();
		} catch {
			/* one plugin's check failing must not stop the others */
		}
	}));
}
