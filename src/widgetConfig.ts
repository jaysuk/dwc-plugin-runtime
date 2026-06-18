/**
 * Plugin widget config framework — the shared contract that lets a plugin contribute a CONFIGURABLE,
 * editable widget to a host layout (e.g. Flexible Layouts). See docs/rfc-widget-config.md.
 *
 * A plugin declares a {@link WidgetConfigSchema} and registers it here; a host reads the registry,
 * renders an editor (see {@link PluginWidgetConfigForm}) and stores PER-INSTANCE config, passing it to
 * the plugin's component via the {@link PluginWidgetProps} contract. The same schema can drive the
 * plugin's own standalone settings, so there's one source of truth.
 *
 * Store-agnostic and zero-dep like the rest of this package: the registry is a window-global (so it
 * works even though every plugin bundles its OWN copy of this package), exactly like updateHub.
 */
import type { Component } from "vue";

// #region Schema types
export type WidgetFieldType =
	| "number"
	| "text"
	| "textarea"
	| "toggle"
	| "select"
	| "color"
	// Host-provided types (e.g. "omPath", "gcode", "icon") rendered via an injected FieldRenderer.
	| (string & {});

export interface WidgetFieldOption {
	title: string;
	value: unknown;
}

export interface WidgetField {
	/** Key into the config object. */
	key: string;
	type: WidgetFieldType;
	/** Already-localised label (the provider localises). */
	label: string;
	/** Tooltip/help body. The form appends "(default: …)". */
	description?: string;
	/** Authoritative default value. */
	default: unknown;
	/** Optional section heading to group fields under in the editor. */
	group?: string;
	/** Numeric constraints. */
	min?: number;
	max?: number;
	step?: number;
	/** Options for `select`. */
	options?: ReadonlyArray<WidgetFieldOption>;
	placeholder?: string;
	/** Show this field only when the predicate (over the live config) is true. */
	visibleWhen?: (config: Record<string, unknown>) => boolean;
}

export interface WidgetConfigSchema {
	/** Stable, namespaced id — matches the embeddable id, e.g. "DuetToolAlign.AutoAlign". */
	id: string;
	/** Schema version, for migrations. */
	version: number;
	fields: ReadonlyArray<WidgetField>;
	/** Optional: upgrade a stored config from an older schema version. */
	migrate?: (config: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;
}
// #endregion

// #region Component contract
export interface WidgetHostContext {
	/** True while the host is in edit mode (the component can show edit affordances / suppress motion). */
	isEditing: boolean;
	/** The placed-instance id, for any per-instance scratch state. */
	instanceId?: string;
}

/** Props a host passes to a plugin's embeddable component (those that opt in). */
export interface PluginWidgetProps<C = Record<string, unknown>> {
	/** Per-instance config (reactive, defaults applied). Treat as read-only; persist via setConfig. */
	config: C;
	/** Persist a partial change back to the host's layout document. */
	setConfig: (patch: Partial<C>) => void;
	host: WidgetHostContext;
}

/** A Vue component rendering one field: props `{ field, modelValue, "onUpdate:modelValue" }`. */
export type FieldRenderer = Component;
export interface FieldRendererMap {
	[type: string]: FieldRenderer;
}
// #endregion

// #region Registry (window-global, like updateHub)
export interface RegisteredWidgetConfig {
	schema: WidgetConfigSchema;
	/** Optional custom editor (escape hatch); receives the same `{ config, setConfig, host }` contract. */
	editor?: Component;
}

interface HubState {
	configs?: Map<string, RegisteredWidgetConfig>;
}

const KEY = "__dwcPluginWidgetConfigs";
const EVENT = "dwc-plugin-widget-config";

function hub(): HubState {
	const g = globalThis as unknown as Record<string, HubState | undefined>;
	if (!g[KEY]) {
		g[KEY] = {};
	}
	return g[KEY] as HubState;
}
function registry(): Map<string, RegisteredWidgetConfig> {
	const h = hub();
	if (!h.configs) {
		h.configs = new Map();
	}
	return h.configs;
}
function emitChange(): void {
	try {
		window.dispatchEvent(new CustomEvent(EVENT));
	} catch {
		/* non-browser */
	}
}

/** Register (or replace) a plugin's widget config schema. Call again on hot reload to update. */
export function registerWidgetConfig(entry: RegisteredWidgetConfig): void {
	registry().set(entry.schema.id, entry);
	emitChange();
}

/** Remove a plugin's schema (e.g. on dwcPluginUnloaded). */
export function unregisterWidgetConfig(id: string): void {
	if (registry().delete(id)) {
		emitChange();
	}
}

export function getWidgetConfig(id: string): RegisteredWidgetConfig | undefined {
	return registry().get(id);
}

export function getWidgetConfigs(): ReadonlyArray<RegisteredWidgetConfig> {
	return [...registry().values()];
}

/** Subscribe to register/unregister changes. Returns an unsubscribe function. */
export function subscribeToWidgetConfigs(callback: () => void): () => void {
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
// #endregion

// #region Config helpers
/** A config object containing every field's default. */
export function defaultsFor(schema: WidgetConfigSchema): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of schema.fields) {
		out[f.key] = f.default;
	}
	return out;
}

/** Backfill any missing keys in `config` from the schema defaults (non-destructive). */
export function applyDefaults(schema: WidgetConfigSchema, config: Record<string, unknown> | undefined): Record<string, unknown> {
	const out: Record<string, unknown> = { ...(config ?? {}) };
	for (const f of schema.fields) {
		if (!(f.key in out)) {
			out[f.key] = f.default;
		}
	}
	return out;
}

/**
 * Bring a stored config up to the current schema: run the schema's `migrate` when the stored version
 * is behind, then backfill defaults. `storedVersion` defaults to 0 (treat unknown as oldest).
 */
export function migrateConfig(
	schema: WidgetConfigSchema,
	config: Record<string, unknown> | undefined,
	storedVersion = 0,
): Record<string, unknown> {
	let c: Record<string, unknown> = { ...(config ?? {}) };
	if (schema.migrate && storedVersion < schema.version) {
		c = schema.migrate(c, storedVersion);
	}
	return applyDefaults(schema, c);
}

/** Clamp/coerce a value to a field's constraints (numbers to min/max). Returns the value to store. */
export function clampFieldValue(field: WidgetField, value: unknown): unknown {
	if (field.type === "number") {
		let n = typeof value === "number" ? value : Number(value);
		if (!Number.isFinite(n)) {
			n = typeof field.default === "number" ? field.default : 0;
		}
		if (typeof field.min === "number") n = Math.max(field.min, n);
		if (typeof field.max === "number") n = Math.min(field.max, n);
		return n;
	}
	if (field.type === "toggle") {
		return !!value;
	}
	return value;
}
// #endregion
