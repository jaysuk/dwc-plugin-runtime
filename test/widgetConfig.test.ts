import { beforeEach, describe, expect, it } from "vitest";

import {
	applyDefaults,
	clampFieldValue,
	defaultsFor,
	getWidgetConfig,
	getWidgetConfigs,
	migrateConfig,
	registerWidgetConfig,
	subscribeToWidgetConfigs,
	unregisterWidgetConfig,
	type WidgetConfigSchema,
} from "../src/widgetConfig.js";

const schema: WidgetConfigSchema = {
	id: "Test.Widget",
	version: 2,
	fields: [
		{ key: "url", type: "text", label: "URL", default: "" },
		{ key: "gain", type: "number", label: "Gain", default: 0.8, min: 0.1, max: 1.5 },
		{ key: "mode", type: "select", label: "Mode", default: "a", options: [{ title: "A", value: "a" }, { title: "B", value: "b" }] },
		{ key: "on", type: "toggle", label: "On", default: true },
	],
	migrate: (config, from) => (from < 2 ? { ...config, gain: 0.8 } : config),
};

function resetRegistry(): void {
	for (const e of getWidgetConfigs()) unregisterWidgetConfig(e.schema.id);
}

describe("defaultsFor / applyDefaults", () => {
	it("builds a full defaults object", () => {
		expect(defaultsFor(schema)).toEqual({ url: "", gain: 0.8, mode: "a", on: true });
	});
	it("backfills only missing keys, keeping existing values", () => {
		expect(applyDefaults(schema, { url: "http://x", gain: 1.2 })).toEqual({ url: "http://x", gain: 1.2, mode: "a", on: true });
	});
	it("handles undefined config", () => {
		expect(applyDefaults(schema, undefined)).toEqual(defaultsFor(schema));
	});
});

describe("migrateConfig", () => {
	it("runs migrate when the stored version is behind, then backfills", () => {
		const out = migrateConfig(schema, { url: "u", gain: 9 }, 1);
		expect(out.gain).toBe(0.8); // migrate reset it
		expect(out.url).toBe("u");
		expect(out.mode).toBe("a"); // backfilled
	});
	it("skips migrate when up to date", () => {
		const out = migrateConfig(schema, { url: "u", gain: 1.1 }, 2);
		expect(out.gain).toBe(1.1);
	});
});

describe("clampFieldValue", () => {
	const gain = schema.fields[1];
	it("clamps numbers to min/max and coerces strings", () => {
		expect(clampFieldValue(gain, "2.0")).toBe(1.5);
		expect(clampFieldValue(gain, "0")).toBe(0.1);
		expect(clampFieldValue(gain, "0.9")).toBe(0.9);
	});
	it("falls back to default for non-numeric", () => {
		expect(clampFieldValue(gain, "abc")).toBe(0.8);
	});
	it("coerces toggles to boolean", () => {
		expect(clampFieldValue(schema.fields[3], 1)).toBe(true);
		expect(clampFieldValue(schema.fields[3], "")).toBe(false);
	});
});

describe("registry", () => {
	beforeEach(resetRegistry);

	it("registers, reads, and unregisters", () => {
		registerWidgetConfig({ schema });
		expect(getWidgetConfig("Test.Widget")?.schema.version).toBe(2);
		expect(getWidgetConfigs()).toHaveLength(1);
		unregisterWidgetConfig("Test.Widget");
		expect(getWidgetConfig("Test.Widget")).toBeUndefined();
	});

	it("notifies subscribers on change", () => {
		let hits = 0;
		const off = subscribeToWidgetConfigs(() => { hits++; });
		registerWidgetConfig({ schema });
		unregisterWidgetConfig("Test.Widget");
		off();
		registerWidgetConfig({ schema }); // after unsubscribe — not counted
		expect(hits).toBe(2);
	});
});
