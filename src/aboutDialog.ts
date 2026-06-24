/**
 * Standard "About" dialog shared by every DWC plugin in this family. A render-function component (NOT a
 * .vue SFC) so the package keeps its tsc-only build and zero runtime deps — Vuetify components are
 * resolved by tag name (globally registered in DWC), the same approach as {@link HelpTip} and
 * {@link PluginWidgetConfigForm}.
 *
 * It renders a consistent panel: identity (name/version/DWC/firmware), an Updates section (status +
 * check-now + one-click apply + auto-check toggle), Diagnostics (a built-in diagnostic-report download
 * plus any plugin-specific `extraActions`), a cross-link list of the other plugins in the family
 * ({@link PLUGIN_FAMILY}, marking which are installed), and Links. Update state/actions are passed in so
 * the dialog stays decoupled from each plugin's own update module.
 *
 * Usage (template):
 *   <AboutDialog v-model="open" plugin-id="ClosedLoopTuning" title="Closed Loop Tuning"
 *     :description="desc" :model="machineStore.model" repo="https://github.com/jaysuk/…"
 *     :docs-url="DOCS.tuning" docs-label="Tuning guide"
 *     :update-available="s?.updateAvailable" :latest-version="s?.latestVersion"
 *     :checking="checking" :applying="applying" :pending-reload="pendingReload" :auto-check="autoOn"
 *     :extra-actions="extraActions"
 *     @check-update="check" @apply-update="apply" @toggle-auto-check="setAuto" />
 */
import { computed, defineComponent, h, type PropType, type VNode } from "vue";

import { buildReport, downloadReport } from "./diagnostics.js";
import { getInstalledPlugin, isPluginInstalled, otherFamilyPlugins } from "./pluginFamily.js";

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

export const AboutDialog = defineComponent({
	name: "AboutDialog",
	props: {
		modelValue: { type: Boolean, default: false },
		/** plugin.json manifest id (used for version lookup, installed detection, family exclusion). */
		pluginId: { type: String, required: true },
		title: { type: String, required: true },
		description: { type: String, default: "" },
		/** The object model — for version / DWC / firmware / installed-plugin detection. */
		model: { type: Object as PropType<unknown>, default: undefined },
		/** Override the displayed version (else read from the installed plugin record). */
		version: { type: String as PropType<string | undefined>, default: undefined },
		repo: { type: String as PropType<string | undefined>, default: undefined },
		docsUrl: { type: String as PropType<string | undefined>, default: undefined },
		docsLabel: { type: String, default: "Documentation" },
		supportUrl: { type: String as PropType<string | undefined>, default: undefined },
		updateAvailable: { type: Boolean, default: false },
		latestVersion: { type: String as PropType<string | undefined>, default: undefined },
		checking: { type: Boolean, default: false },
		applying: { type: Boolean, default: false },
		pendingReload: { type: Boolean, default: false },
		autoCheck: { type: Boolean, default: true },
		extraActions: { type: Array as PropType<Array<AboutExtraAction>>, default: () => [] },
		showFamily: { type: Boolean, default: true },
	},
	emits: ["update:modelValue", "check-update", "apply-update", "toggle-auto-check"],
	setup(props, { emit }) {
		ensureStyle();
		const installed = computed(() => getInstalledPlugin(props.model, props.pluginId));
		const version = computed(() => props.version || installed.value?.version || "unknown");
		const dwcVersion = computed(() => installed.value?.dwcVersion || "—");
		const firmware = computed(() => {
			const b = (props.model as { boards?: Array<{ firmwareName?: string; firmwareVersion?: string }> } | undefined)?.boards?.[0];
			return b ? `${b.firmwareName ?? "?"} ${b.firmwareVersion ?? ""}`.trim() : "—";
		});
		const others = computed(() => otherFamilyPlugins(props.pluginId));

		const close = (): void => emit("update:modelValue", false);
		const reload = (): void => { if (typeof window !== "undefined") { window.location.reload(); } };
		function downloadDiagnostics(): void {
			const report = buildReport({ pluginId: props.pluginId, pluginVersion: version.value, model: props.model, note: `${props.title} diagnostic report` });
			downloadReport(report);
		}

		const sectionTitle = (t: string): VNode => h("div", { class: "text-subtitle-2 mt-4 mb-1" }, t);
		const link = (href: string, label: string): VNode => h("a", { href, target: "_blank", rel: "noopener", class: "dpr-about-link" }, label);

		function renderUpdates(): Array<VNode> {
			const banner = props.updateAvailable
				? h("v-alert", { type: "info", variant: "tonal", density: "compact", class: "mb-2" }, {
					default: () => `Version ${props.latestVersion ?? ""} is available.`,
					append: () => props.pendingReload
						? h("v-btn", { size: "small", variant: "text", onClick: reload }, () => "Reload")
						: h("v-btn", { size: "small", variant: "text", loading: props.applying, onClick: () => emit("apply-update") }, () => "Update"),
				})
				: h("v-alert", { type: "success", variant: "tonal", density: "compact", class: "mb-2" }, () => "You're on the latest version.");
			const controls = h("div", { class: "d-flex align-center flex-wrap ga-3" }, [
				h("v-btn", { size: "small", variant: "tonal", prependIcon: "mdi-refresh", loading: props.checking, onClick: () => emit("check-update") }, () => "Check now"),
				h("v-switch", { label: "Check automatically", modelValue: props.autoCheck, color: "primary", density: "compact", hideDetails: true, "onUpdate:modelValue": (v: unknown) => emit("toggle-auto-check", !!v) }),
			]);
			return [sectionTitle("Updates"), banner, controls];
		}

		function renderDiagnostics(): Array<VNode> {
			const actions: Array<VNode> = [
				h("v-btn", { size: "small", variant: "tonal", prependIcon: "mdi-bug-outline", block: true, class: "mb-2", onClick: downloadDiagnostics }, () => "Download diagnostic report"),
				...props.extraActions.map((a) => h("v-btn", { size: "small", variant: "tonal", color: a.color, prependIcon: a.icon, disabled: a.disabled, block: true, class: "mb-2", onClick: a.onClick }, () => a.label)),
			];
			return [sectionTitle("Diagnostics & support"), ...actions];
		}

		function renderFamily(): Array<VNode> {
			if (!props.showFamily || others.value.length === 0) { return []; }
			const rows = others.value.map((p) => h("div", { key: p.id, class: "dpr-about-fam" }, [
				h("div", { class: "d-flex align-center" }, [
					h("span", { class: "text-body-2 font-weight-medium" }, p.name),
					isPluginInstalled(props.model, p.id) ? h("v-chip", { size: "x-small", color: "success", variant: "flat", class: "ml-2" }, () => "installed") : null,
					h("v-spacer"),
					link(p.repo, "GitHub"),
				]),
				h("div", { class: "text-caption text-medium-emphasis" }, p.description),
			]));
			return [sectionTitle("More plugins by jaysuk"), h("div", { class: "dpr-about-famlist" }, rows)];
		}

		function renderLinks(): Array<VNode> {
			const items: Array<VNode> = [];
			if (props.docsUrl) { items.push(link(props.docsUrl, props.docsLabel)); }
			if (props.repo) { items.push(link(props.repo, "Source & issues on GitHub")); }
			if (props.supportUrl) { items.push(link(props.supportUrl, "Support this plugin")); }
			if (items.length === 0) { return []; }
			return [sectionTitle("Links"), h("div", { class: "d-flex flex-column ga-1" }, items)];
		}

		return () => h("v-dialog", {
			modelValue: props.modelValue,
			maxWidth: 580,
			scrollable: true,
			"onUpdate:modelValue": (v: unknown) => emit("update:modelValue", !!v),
		}, {
			default: () => h("v-card", {}, {
				default: () => [
					h("v-card-title", { class: "d-flex align-center" }, [
						h("v-icon", { class: "mr-2" }, () => "mdi-information-outline"),
						h("span", {}, `About ${props.title}`),
						h("v-spacer"),
						h("v-btn", { icon: "mdi-close", variant: "text", size: "small", onClick: close }),
					]),
					h("v-card-text", {}, [
						props.description ? h("div", { class: "text-body-2 mb-2" }, props.description) : null,
						h("v-table", { density: "compact" }, () => h("tbody", {}, [
							h("tr", {}, [h("td", {}, "Version"), h("td", {}, version.value)]),
							h("tr", {}, [h("td", {}, "DWC"), h("td", {}, dwcVersion.value)]),
							h("tr", {}, [h("td", {}, "Firmware"), h("td", {}, firmware.value)]),
						])),
						...renderUpdates(),
						...renderDiagnostics(),
						...renderFamily(),
						...renderLinks(),
					]),
				],
			}),
		});
	},
});

export default AboutDialog;
