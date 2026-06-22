/**
 * Inline help affordance shared by all DWC plugins: a low-emphasis "?" icon that shows an explanatory
 * tooltip on hover/focus, and optionally links to documentation. A render-function component (NOT a
 * .vue SFC) so this package keeps its tsc-only build and zero runtime deps — Vuetify's v-tooltip /
 * v-icon are resolved by tag name (globally registered in DWC), the same approach as
 * {@link PluginWidgetConfigForm}.
 *
 * Usage (render function):
 *   h(HelpTip, { text: "Explanation", href: "https://docs.duet3d.com/...", size: "x-small" })
 *
 * Usage (template) — register it locally first, e.g. in <script setup>:
 *   import { HelpTip } from "dwc-plugin-runtime";
 *   <HelpTip text="Explanation" :href="docUrl" />
 */
import { computed, defineComponent, h, type PropType } from "vue";

const STYLE_ID = "dwc-plugin-runtime-helptip-style";

/** Inject the hover/link styles once (a render-function component can't carry scoped <style>). */
function ensureStyle(): void {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) {
		return;
	}
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent =
		".dpr-help-tip{opacity:.55;cursor:help;vertical-align:middle}" +
		".dpr-help-tip:hover,.dpr-help-tip:focus-visible{opacity:1}" +
		".dpr-help-link{text-decoration:none}";
	document.head.appendChild(el);
}

export const HelpTip = defineComponent({
	name: "HelpTip",
	props: {
		/** Explanation shown in the tooltip box. */
		text: { type: String, required: true },
		/** Optional documentation URL; makes the icon a link and notes it in the tooltip. */
		href: { type: String as PropType<string | undefined>, default: undefined },
		/** Icon size; defaults to a compact "x-small" so it sits unobtrusively beside labels/fields. */
		size: { type: [String, Number] as PropType<string | number>, default: "x-small" },
	},
	setup(props) {
		ensureStyle();
		const tooltipText = computed(() => (props.href ? `${props.text} (click for docs)` : props.text));

		const renderIcon = (activatorProps: Record<string, unknown>) => {
			const icon = h("v-icon", {
				...activatorProps,
				size: props.size,
				class: "dpr-help-tip",
				tabindex: props.href ? undefined : "0",
				"aria-label": props.text,
			}, { default: () => "mdi-help-circle-outline" });
			return props.href
				? h("a", { href: props.href, target: "_blank", rel: "noopener", class: "dpr-help-link", onClick: (e: Event) => e.stopPropagation() }, [icon])
				: icon;
		};

		return () => h("v-tooltip", {
			text: tooltipText.value,
			location: "top",
			maxWidth: 360,
			openDelay: 150,
		}, {
			activator: (scope: { props: Record<string, unknown> }) => renderIcon(scope.props),
		});
	},
});

export default HelpTip;
