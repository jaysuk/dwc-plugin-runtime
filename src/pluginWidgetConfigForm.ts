/**
 * Schema-driven config form for {@link WidgetConfigSchema}. A render-function component (NOT a .vue
 * SFC) so this package keeps its tsc-only build and zero runtime deps — Vue is a peer/external,
 * resolved from `window.DWC.Vue` once the plugin bundle is loaded by DWC.
 *
 * Renders primitive field types (number/text/textarea/toggle/select/color) using Vuetify components by
 * tag name (globally registered in DWC). Host-specific field types (e.g. "omPath", "gcode", "icon")
 * are rendered by a host-injected {@link FieldRenderer} via the `fieldRenderers` prop — that keeps this
 * package store-agnostic (it never imports the object model). Unknown types fall back to a text input.
 *
 * Usage (host or plugin):
 *   h(PluginWidgetConfigForm, {
 *     schema, modelValue: config,
 *     "onUpdate:modelValue": (next) => save(next),
 *     fieldRenderers: { omPath: MyOmPathField },   // optional, host-provided
 *   })
 */
import { computed, defineComponent, h, resolveComponent, type PropType, type VNode } from "vue";

import { clampFieldValue, type FieldRendererMap, type WidgetConfigSchema, type WidgetField } from "./widgetConfig.js";

/**
 * Resolve a globally-registered Vuetify component by tag name for use in h(). A hand-written render
 * function (unlike the SFC template compiler) does not do this automatically - h("v-switch", ...)
 * with a bare string tag creates an inert custom HTML element instead of invoking the real Vuetify
 * component, so nothing visible/interactive renders (see dwc-plugin-runtime's aboutDialog.ts for the
 * full story).
 */
function vc(name: string) {
	return resolveComponent(name);
}

function fieldHint(f: WidgetField): string {
	const base = f.description ? `${f.description} ` : "";
	return `${base}(default: ${String(f.default)})`;
}

export const PluginWidgetConfigForm = defineComponent({
	name: "PluginWidgetConfigForm",
	props: {
		schema: { type: Object as PropType<WidgetConfigSchema>, required: true },
		modelValue: { type: Object as PropType<Record<string, unknown>>, required: true },
		/** Host-provided renderers for non-primitive field types (keyed by `field.type`). */
		fieldRenderers: { type: Object as PropType<FieldRendererMap>, default: () => ({}) },
	},
	emits: ["update:modelValue"],
	setup(props, { emit }) {
		function update(field: WidgetField, raw: unknown): void {
			emit("update:modelValue", { ...props.modelValue, [field.key]: clampFieldValue(field, raw) });
		}

		// Visible fields, grouped by `group` in first-seen order.
		const groups = computed(() => {
			const visible = props.schema.fields.filter((f) => !f.visibleWhen || f.visibleWhen(props.modelValue));
			const order: Array<string> = [];
			const map = new Map<string, Array<WidgetField>>();
			for (const f of visible) {
				const g = f.group ?? "";
				if (!map.has(g)) {
					map.set(g, []);
					order.push(g);
				}
				map.get(g)!.push(f);
			}
			return order.map((name) => ({ name, fields: map.get(name)! }));
		});

		function renderField(f: WidgetField): VNode {
			const val = props.modelValue[f.key];
			const onUpdate = (v: unknown): void => update(f, v);

			const custom = props.fieldRenderers[f.type];
			if (custom) {
				return h(custom, { field: f, modelValue: val, "onUpdate:modelValue": onUpdate });
			}

			const common: Record<string, unknown> = {
				label: f.label,
				hint: fieldHint(f),
				persistentHint: true,
				density: "compact",
				variant: "outlined",
				class: "mb-2",
			};

			switch (f.type) {
				case "toggle":
					return h(vc("v-switch"), {
						label: f.label,
						title: fieldHint(f),
						modelValue: !!val,
						color: "primary",
						density: "compact",
						hideDetails: true,
						class: "mb-1",
						"onUpdate:modelValue": onUpdate,
					});
				case "select":
					return h(vc("v-select"), {
						...common,
						items: f.options ?? [],
						itemTitle: "title",
						itemValue: "value",
						modelValue: val,
						"onUpdate:modelValue": onUpdate,
					});
				case "textarea":
					return h(vc("v-textarea"), { ...common, modelValue: val, placeholder: f.placeholder, "onUpdate:modelValue": onUpdate });
				case "number":
					return h(vc("v-text-field"), {
						...common,
						type: "number",
						min: f.min,
						max: f.max,
						step: f.step ?? 1,
						modelValue: val,
						"onUpdate:modelValue": onUpdate,
					});
				default: // text, color, or an unknown type with no injected renderer
					return h(vc("v-text-field"), { ...common, modelValue: val, placeholder: f.placeholder, "onUpdate:modelValue": onUpdate });
			}
		}

		return () =>
			h(
				"div",
				{ class: "dwc-widget-config-form" },
				groups.value.map((group) =>
					h("div", { key: group.name || "_", class: "mb-1" }, [
						group.name ? h("div", { class: "text-caption text-medium-emphasis mb-1" }, group.name) : null,
						...group.fields.map((f) => renderField(f)),
					]),
				),
			);
	},
});
