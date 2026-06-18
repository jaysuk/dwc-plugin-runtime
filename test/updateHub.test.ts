import { beforeEach, describe, expect, it } from "vitest";

import {
	announceUpdate,
	claimUpdateHost,
	clearAnnouncedUpdate,
	getAnnouncedUpdates,
	isUpdateHostActive,
	registerUpdateChecker,
	runAllUpdateChecks,
	subscribeToUpdates,
} from "../src/updateHub.js";
import type { UpdateResult } from "../src/updates.js";

function result(latest: string): UpdateResult {
	return {
		scenario: "pluginUpdate", updateAvailable: true, currentVersion: "1.0.0",
		latestVersion: latest, releaseUrl: null, assetUrl: null, assetName: null,
		requiredDwc: null, runningDwc: null, dwcCompatible: true, notes: null,
	};
}

beforeEach(() => {
	for (const u of getAnnouncedUpdates()) clearAnnouncedUpdate(u.pluginId);
});

describe("update hub registry", () => {
	it("announces, replaces by plugin id, and clears", () => {
		announceUpdate("A", "Plugin A", result("1.1.0"));
		announceUpdate("B", "Plugin B", result("2.0.0"));
		expect(getAnnouncedUpdates().map((u) => u.pluginId).sort()).toEqual(["A", "B"]);

		// Re-announcing the same id replaces rather than duplicates.
		announceUpdate("A", "Plugin A", result("1.2.0"));
		expect(getAnnouncedUpdates().filter((u) => u.pluginId === "A")).toHaveLength(1);
		expect(getAnnouncedUpdates().find((u) => u.pluginId === "A")?.latestVersion).toBe("1.2.0");

		clearAnnouncedUpdate("A");
		expect(getAnnouncedUpdates().map((u) => u.pluginId)).toEqual(["B"]);
	});

	it("notifies subscribers on announce and clear", () => {
		let hits = 0;
		const off = subscribeToUpdates(() => { hits++; });
		announceUpdate("A", "Plugin A", result("1.1.0"));
		clearAnnouncedUpdate("A");
		off();
		announceUpdate("B", "Plugin B", result("1.1.0")); // after unsubscribe — not counted
		expect(hits).toBe(2);
	});
});

describe("update checkers", () => {
	it("runs every registered checker, isolates failures, and unregisters", async () => {
		const calls: Array<string> = [];
		const offA = registerUpdateChecker("A", () => { calls.push("A"); });
		registerUpdateChecker("B", async () => { calls.push("B"); });
		registerUpdateChecker("C", () => { throw new Error("boom"); }); // must not break the others

		await runAllUpdateChecks();
		expect(calls.sort()).toEqual(["A", "B"]);

		// Re-registering the same id replaces; unregister removes.
		calls.length = 0;
		offA();
		registerUpdateChecker("B", () => { calls.push("B2"); });
		await runAllUpdateChecks();
		expect(calls).toEqual(["B2"]);
	});
});

describe("host claim", () => {
	it("tracks active hosts with reference counting", () => {
		expect(isUpdateHostActive()).toBe(false);
		const release1 = claimUpdateHost();
		const release2 = claimUpdateHost();
		expect(isUpdateHostActive()).toBe(true);
		release1();
		expect(isUpdateHostActive()).toBe(true); // still one host
		release2();
		expect(isUpdateHostActive()).toBe(false);
	});
});
