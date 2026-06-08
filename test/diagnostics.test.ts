import { beforeEach, describe, expect, it } from "vitest";

import {
	buildReport,
	clearErrors,
	getErrors,
	recordError,
	reportToJson,
	sanitizeModel,
} from "../src/diagnostics";

describe("diagnostics", () => {
	beforeEach(() => clearErrors());

	it("records errors into a capped ring buffer (newest kept, oldest dropped)", () => {
		for (let i = 0; i < 30; i++) recordError("test", new Error(`e${i}`));
		const errs = getErrors();
		expect(errs.length).toBe(25);
		expect(errs[errs.length - 1].message).toBe("e29");
		expect(errs[0].message).toBe("e5");
	});

	it("captures message + a trimmed stack and handles non-Error throws", () => {
		recordError("x", "plain string");
		recordError("y", new Error("boom"));
		const [a, b] = getErrors();
		expect(a.message).toBe("plain string");
		expect(b.message).toBe("boom");
		expect((b.stack ?? "").split("\n").length).toBeLessThanOrEqual(12);
	});

	it("scrubs network details, serials and file names but keeps structure", () => {
		const clean = sanitizeModel({
			network: { hostname: "duet3", name: "printer", interfaces: [{ actualIP: "192.168.1.50", mac: "AA:BB", ssid: "Home", state: "active" }] },
			boards: [{ uniqueId: "SECRET", firmwareVersion: "3.7.0", firmwareName: "RRF" }],
			job: { lastFileName: "0:/gcodes/private.gcode", file: { fileName: "0:/gcodes/private.gcode" } },
			state: { status: "idle" },
		}) as any;
		expect(clean.network.hostname).toBe("<redacted>");
		expect(clean.network.interfaces[0].actualIP).toBe("<redacted>");
		expect(clean.network.interfaces[0].mac).toBe("<redacted>");
		expect(clean.network.interfaces[0].state).toBe("active");
		expect(clean.boards[0].uniqueId).toBe("<redacted>");
		expect(clean.boards[0].firmwareVersion).toBe("3.7.0");
		expect(clean.job.lastFileName).toBe("<redacted>");
		expect(clean.job.file.fileName).toBe("<redacted>");
	});

	it("does not mutate the source model", () => {
		const src = { network: { hostname: "duet3" }, state: {} };
		sanitizeModel(src);
		expect(src.network.hostname).toBe("duet3");
	});

	it("derives versions from model.plugins + boards and serialises a Map global", () => {
		const report = buildReport({
			pluginId: "MyPlugin",
			model: {
				boards: [{ firmwareName: "RepRapFirmware", firmwareVersion: "3.7.0-beta" }],
				plugins: { MyPlugin: { version: "1.2.3", dwcVersion: "3.7.0" } },
				global: new Map<string, unknown>([["myVar", 7]]),
				state: { status: "idle" },
			},
		});
		expect(report.plugin).toEqual({ id: "MyPlugin", version: "1.2.3" });
		expect(report.dwcVersion).toBe("3.7.0");
		expect(report.firmware).toEqual({ name: "RepRapFirmware", version: "3.7.0-beta" });
		expect(reportToJson(report)).toContain("\"myVar\": 7");
	});

	it("falls back to unknown when data is missing", () => {
		const report = buildReport({ pluginId: "X" });
		expect(report.plugin.version).toBe("unknown");
		expect(report.firmware.version).toBe("unknown");
	});
});
