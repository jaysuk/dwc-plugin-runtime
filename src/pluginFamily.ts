/**
 * Registry of the DWC plugin family that shares this runtime, used by {@link AboutDialog} to cross-link
 * the plugins ("More plugins by this author") and to flag which are already installed. Pure data + a
 * couple of model lookups — no Vue/DWC imports — so it stays bundleable and store-agnostic.
 *
 * `id` is the plugin.json manifest id (the key DWC stores installed plugins under), so installed
 * detection and the About header's version lookup both key off it.
 */
export interface FamilyPlugin {
	/** plugin.json manifest id. */
	id: string;
	/** Display name. */
	name: string;
	/** One-line description. */
	description: string;
	/** GitHub repository URL (source + issues + releases). */
	repo: string;
}

/** The published jaysuk DWC plugin family (alphabetical by name). */
export const PLUGIN_FAMILY: ReadonlyArray<FamilyPlugin> = [
	{ id: "BdPressurePA", name: "bd_pressure PA Calibration", description: "Pressure-advance calibration for the bd_pressure sensor.", repo: "https://github.com/jaysuk/bd_pressure_dwc_plugin" },
	{ id: "ClosedLoopTuning", name: "Closed Loop Tuning", description: "Tune Duet 3 closed-loop drivers (1HCL / M23CL) with automatic analysis.", repo: "https://github.com/jaysuk/ClosedLoopTuningPlugin" },
	{ id: "DuetToolAlign", name: "Duet Tool Align", description: "Align multiple toolheads / nozzles to each other.", repo: "https://github.com/jaysuk/duet-tool-align" },
	{ id: "DuetTmcTuner", name: "Duet TMC Tuner", description: "Auto-tune TMC stepper drivers (stealthChop / spreadCycle).", repo: "https://github.com/jaysuk/duet-tmc-tuner" },
	{ id: "FlexibleLayouts", name: "Flexible Layouts", description: "Drag-and-drop dashboard layouts you can build, share and upload.", repo: "https://github.com/jaysuk/Flexible-Layouts" },
	{ id: "GlobalsManager", name: "Globals Editor", description: "View and edit RRF global variables live.", repo: "https://github.com/jaysuk/RRF-Globals-Editor" },
	{ id: "NeopixelControl", name: "Neopixel Control", description: "Drive and preview NeoPixel / addressable LED strips.", repo: "https://github.com/jaysuk/RRF-Neopixel-Control" },
	{ id: "OmBrowser", name: "Object Model Browser", description: "Browse and watch the RRF object model in real time.", repo: "https://github.com/jaysuk/RRF-Alternative-Object-Model-Browser" },
	{ id: "ReleaseMgr", name: "Release Manager", description: "Highlights the RRF release notes that matter for your config and hardware.", repo: "https://github.com/jaysuk/ReleaseMgr" },
	{ id: "ResonanceLab", name: "Resonance Lab", description: "Input-shaping resonance measurement and tuning (Shake&Tune-style).", repo: "https://github.com/jaysuk/resonance-lab" },
	{ id: "ThermalFrameExpansion", name: "Thermal Frame Expansion", description: "Measure your frame's thermal-expansion coefficient.", repo: "https://github.com/jaysuk/thermal-frame-expansion-dwc-plugin" },
];

/** The installed-plugin record for `id` from the object model (handles Map or plain-object `plugins`). */
export function getInstalledPlugin(model: unknown, id: string): { version?: string; dwcVersion?: string } | null {
	const plugins = (model as { plugins?: unknown } | undefined)?.plugins;
	if (!plugins) { return null; }
	if (typeof (plugins as { get?: unknown }).get === "function") {
		return (plugins as { get: (k: string) => { version?: string; dwcVersion?: string } | undefined }).get(id) ?? null;
	}
	return (plugins as Record<string, { version?: string; dwcVersion?: string }>)[id] ?? null;
}

/** Whether a plugin id is currently installed on the connected machine. */
export function isPluginInstalled(model: unknown, id: string): boolean {
	return !!getInstalledPlugin(model, id);
}

/** The family minus the current plugin (for the "more plugins" list). */
export function otherFamilyPlugins(currentId: string): ReadonlyArray<FamilyPlugin> {
	return PLUGIN_FAMILY.filter((p) => p.id !== currentId);
}
