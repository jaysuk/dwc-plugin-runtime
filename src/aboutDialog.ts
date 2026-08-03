/**
 * Standard "About" content shared by every DWC plugin in this family, in two shapes:
 *   - {@link AboutPanel}  — the inline content (drop into an "About" tab / section).
 *   - {@link AboutDialog} — the same content wrapped in a v-dialog (open from an ⓘ button).
 *
 * Render-function components (NOT .vue SFCs) so the package keeps its tsc-only build and zero runtime
 * deps — Vuetify components are resolved by tag name (globally registered in DWC), the same approach as
 * {@link HelpTip} / {@link PluginWidgetConfigForm}.
 *
 * Content: identity table (version/DWC/firmware, read from the object model), an Updates section
 * (status + check-now + one-click apply + auto-check toggle), Diagnostics (built-in diagnostic-report
 * download + copy-to-clipboard, both carrying an optional plugin-specific `diagnosticState`, plus
 * plugin-specific `extraActions`), a cross-link list of the other family plugins
 * ({@link PLUGIN_FAMILY}, marking which are installed), and Links. Update state/actions are passed in so
 * the component stays decoupled from each plugin's own update module.
 *
 * Usage (dialog, from an ⓘ button):
 *   <AboutDialog v-model="open" plugin-id="ClosedLoopTuning" title="Closed Loop Tuning"
 *     :description="desc" :model="machineStore.model" repo="https://github.com/jaysuk/…"
 *     :diagnostic-state="{ tuningConfig }"
 *     :update-available="s?.updateAvailable" :latest-version="s?.latestVersion"
 *     :checking="checking" :applying="applying" :pending-reload="pendingReload" :auto-check="autoOn"
 *     :extra-actions="extraActions"
 *     @check-update="check" @apply-update="apply" @toggle-auto-check="setAuto" />
 *
 * Usage (inline, inside an existing About tab): identical props minus v-model — use <AboutPanel … />.
 */
import { defineComponent, h, ref, resolveComponent, type ExtractPropTypes, type PropType, type Ref, type VNode } from "vue";

import { buildReport, copyReport, downloadReport } from "./diagnostics.js";
import { getInstalledPlugin, isPluginInstalled, otherFamilyPlugins } from "./pluginFamily.js";

/**
 * Resolve a globally-registered Vuetify component by tag name for use in h(). Unlike the SFC
 * template compiler (which inserts a resolveComponent() call for any non-native tag automatically),
 * a hand-written render function does NOT do this: h("v-btn", ...) with a bare string tag creates an
 * inert custom HTML element, not the real component - Vuetify's actual VBtn is never invoked, so the
 * result is invisible/non-functional (this is exactly the bug that made the About dialog and its
 * contents fail to render at all).
 */
function vc(name: string) {
	return resolveComponent(name);
}

const STYLE_ID = "dwc-plugin-runtime-about-style";

function ensureStyle(): void {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) { return; }
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent =
		".dpr-about-link{font-size:.85rem}" +
		".dpr-about-famlist{max-height:208px;overflow-y:auto;margin-top:2px}" +
		".dpr-about-fam{padding:5px 0;border-bottom:1px solid rgba(127,127,127,.18)}" +
		".dpr-about-fam:last-child{border-bottom:none}";
	document.head.appendChild(el);
}

/** A plugin-specific extra button shown in the Diagnostics section (e.g. "Download tuning report"). */
export interface AboutExtraAction {
	label: string;
	icon?: string;
	color?: string;
	disabled?: boolean;
	onClick: () => void;
}

/** Props shared by AboutPanel and AboutDialog. */
const panelProps = {
	/** plugin.json manifest id (used for version lookup, installed detection, family exclusion). */
	pluginId: { type: String, required: true as const },
	title: { type: String, required: true as const },
	description: { type: String, default: "" },
	/** The object model — for version / DWC / firmware / installed-plugin detection. */
	model: { type: Object as PropType<unknown>, required: false },
	/** Arbitrary plugin-specific data attached to the diagnostic report's `state` field (e.g. FL's
	 *  live layout document, or a tuning plugin's active config) - opaque to this component, passed
	 *  straight through to buildReport(). Not rendered here. */
	diagnosticState: { type: null as unknown as PropType<unknown>, default: undefined },
	/** Override the displayed version (else read from the installed plugin record). */
	version: { type: String as PropType<string | undefined>, default: undefined },
	repo: { type: String as PropType<string | undefined>, default: undefined },
	docsUrl: { type: String as PropType<string | undefined>, default: undefined },
	docsLabel: { type: String, default: "Documentation" },
	supportUrl: { type: String as PropType<string | undefined>, default: undefined },
	updateAvailable: { type: Boolean, default: false },
	latestVersion: { type: String as PropType<string | null | undefined>, default: undefined },
	checking: { type: Boolean, default: false },
	applying: { type: Boolean, default: false },
	pendingReload: { type: Boolean, default: false },
	autoCheck: { type: Boolean, default: true },
	extraActions: { type: Array as PropType<Array<AboutExtraAction>>, default: () => [] },
	showFamily: { type: Boolean, default: true },
};

const panelEmits = ["check-update", "apply-update", "toggle-auto-check"] as const;

type PanelProps = Readonly<ExtractPropTypes<typeof panelProps>>;
type Emit = (event: string, ...args: Array<unknown>) => void;

/** Transient copy-button feedback: "idle" -> "copied"/"failed" -> back to "idle" after a beat. Lives
 *  in each component instance's own setup() (see AboutPanel/AboutDialog below), not module scope -
 *  module-level state would leak between every mounted instance. */
function useCopyStatus(): { status: Ref<"idle" | "copied" | "failed">; settle: (ok: boolean) => void } {
	const status = ref<"idle" | "copied" | "failed">("idle");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const settle = (ok: boolean): void => {
		status.value = ok ? "copied" : "failed";
		if (timer !== undefined) { clearTimeout(timer); }
		timer = setTimeout(() => { status.value = "idle"; }, 1800);
	};
	return { status, settle };
}

/** Render the shared About content as a single <div> (used by both the panel and the dialog body).
 *  `copy` is this instance's own copy-button feedback state (see {@link useCopyStatus}) - threaded in
 *  from setup() rather than created here, since renderContent() itself re-runs on every render. */
function renderContent(props: PanelProps, emit: Emit, copy: { status: Ref<"idle" | "copied" | "failed">; settle: (ok: boolean) => void }): VNode {
	ensureStyle();
	const installed = getInstalledPlugin(props.model, props.pluginId);
	const version = props.version || installed?.version || "unknown";
	const dwcVersion = installed?.dwcVersion || "—";
	const board = (props.model as { boards?: Array<{ firmwareName?: string; firmwareVersion?: string }> } | undefined)?.boards?.[0];
	const firmware = board ? `${board.firmwareName ?? "?"} ${board.firmwareVersion ?? ""}`.trim() : "—";
	const others = otherFamilyPlugins(props.pluginId);

	const diagnosticReport = () => buildReport({
		pluginId: props.pluginId, pluginVersion: version, model: props.model,
		state: props.diagnosticState, note: `${props.title} diagnostic report`,
	});
	const downloadDiagnostics = (): void => downloadReport(diagnosticReport());
	const copyDiagnostics = (): void => { void copyReport(diagnosticReport()).then(copy.settle); };
	const reload = (): void => { if (typeof window !== "undefined") { window.location.reload(); } };
	const sectionTitle = (t: string): VNode => h("div", { class: "text-subtitle-2 mt-4 mb-1" }, t);
	const link = (href: string, label: string): VNode => h("a", { href, target: "_blank", rel: "noopener", class: "dpr-about-link" }, label);

	const identity = h(vc("v-table"), { density: "compact" }, () => h("tbody", {}, [
		h("tr", {}, [h("td", {}, "Version"), h("td", {}, version)]),
		h("tr", {}, [h("td", {}, "DWC"), h("td", {}, dwcVersion)]),
		h("tr", {}, [h("td", {}, "Firmware"), h("td", {}, firmware)]),
	]));

	const updateBanner = props.updateAvailable
		? h(vc("v-alert"), { type: "info", variant: "tonal", density: "compact", class: "mb-2" }, {
			default: () => `Version ${props.latestVersion ?? ""} is available.`,
			append: () => props.pendingReload
				? h(vc("v-btn"), { size: "small", variant: "text", onClick: reload }, () => "Reload")
				: h(vc("v-btn"), { size: "small", variant: "text", loading: props.applying, onClick: () => emit("apply-update") }, () => "Update"),
		})
		: h(vc("v-alert"), { type: "success", variant: "tonal", density: "compact", class: "mb-2" }, () => "You're on the latest version.");
	const updateControls = h("div", { class: "d-flex align-center flex-wrap ga-3" }, [
		h(vc("v-btn"), { size: "small", variant: "tonal", prependIcon: "mdi-refresh", loading: props.checking, onClick: () => emit("check-update") }, () => "Check now"),
		h(vc("v-switch"), { label: "Check automatically", modelValue: props.autoCheck, color: "primary", density: "compact", hideDetails: true, "onUpdate:modelValue": (v: unknown) => emit("toggle-auto-check", !!v) }),
	]);

	const copyLabel = copy.status.value === "copied" ? "Copied!" : copy.status.value === "failed" ? "Copy failed - try Download instead" : "Copy diagnostic report";
	const copyIcon = copy.status.value === "copied" ? "mdi-check" : copy.status.value === "failed" ? "mdi-alert" : "mdi-content-copy";
	const diagButtons: Array<VNode> = [
		h(vc("v-btn"), { size: "small", variant: "tonal", prependIcon: "mdi-bug-outline", block: true, class: "mb-2", onClick: downloadDiagnostics }, () => "Download diagnostic report"),
		h(vc("v-btn"), { size: "small", variant: "tonal", color: copy.status.value === "failed" ? "error" : undefined, prependIcon: copyIcon, block: true, class: "mb-2", onClick: copyDiagnostics }, () => copyLabel),
		...props.extraActions.map((a) => h(vc("v-btn"), { size: "small", variant: "tonal", color: a.color, prependIcon: a.icon, disabled: a.disabled, block: true, class: "mb-2", onClick: a.onClick }, () => a.label)),
	];

	const family: Array<VNode> = (props.showFamily && others.length > 0)
		? [sectionTitle("More plugins by jaysuk"), h("div", { class: "dpr-about-famlist" }, others.map((p) => h("div", { key: p.id, class: "dpr-about-fam" }, [
			h("div", { class: "d-flex align-center" }, [
				h("span", { class: "text-body-2 font-weight-medium" }, p.name),
				isPluginInstalled(props.model, p.id) ? h(vc("v-chip"), { size: "x-small", color: "success", variant: "flat", class: "ml-2" }, () => "installed") : null,
				h(vc("v-spacer")),
				link(p.repo, "GitHub"),
			]),
			h("div", { class: "text-caption text-medium-emphasis" }, p.description),
		])))]
		: [];

	const linkItems: Array<VNode> = [];
	if (props.docsUrl) { linkItems.push(link(props.docsUrl, props.docsLabel)); }
	if (props.repo) { linkItems.push(link(props.repo, "Source & issues on GitHub")); }
	if (props.supportUrl) { linkItems.push(link(props.supportUrl, "Support this plugin")); }
	const links: Array<VNode> = linkItems.length ? [sectionTitle("Links"), h("div", { class: "d-flex flex-column ga-1" }, linkItems)] : [];

	return h("div", { class: "dpr-about" }, [
		props.description ? h("div", { class: "text-body-2 mb-2" }, props.description) : null,
		identity,
		sectionTitle("Updates"), updateBanner, updateControls,
		sectionTitle("Diagnostics & support"), ...diagButtons,
		...family,
		...links,
	]);
}

/** Inline About content — drop into an existing "About" tab or settings section. */
export const AboutPanel = defineComponent({
	name: "AboutPanel",
	props: panelProps,
	emits: panelEmits as unknown as Array<string>,
	setup(props, { emit }) {
		const copy = useCopyStatus();
		return () => renderContent(props, emit as Emit, copy);
	},
});

/** About content wrapped in a v-dialog — open from an ⓘ button via v-model. */
export const AboutDialog = defineComponent({
	name: "AboutDialog",
	props: { modelValue: { type: Boolean, default: false }, ...panelProps },
	emits: ["update:modelValue", ...panelEmits] as unknown as Array<string>,
	setup(props, { emit }) {
		const copy = useCopyStatus();
		const close = (): void => emit("update:modelValue", false);
		return () => h(vc("v-dialog"), {
			modelValue: props.modelValue,
			maxWidth: 580,
			scrollable: true,
			"onUpdate:modelValue": (v: unknown) => emit("update:modelValue", !!v),
		}, {
			default: () => h(vc("v-card"), {}, {
				default: () => [
					h(vc("v-card-title"), { class: "d-flex align-center" }, () => [
						h(vc("v-icon"), { class: "mr-2" }, () => "mdi-information-outline"),
						h("span", {}, `About ${props.title}`),
						h(vc("v-spacer")),
						h(vc("v-btn"), { icon: "mdi-close", variant: "text", size: "small", onClick: close }),
					]),
					h(vc("v-card-text"), {}, () => [renderContent(props, emit as Emit, copy)]),
				],
			}),
		});
	},
});

export default AboutDialog;
