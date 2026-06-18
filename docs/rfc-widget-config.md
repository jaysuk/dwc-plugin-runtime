# RFC: Plugin Widget Config Framework

**Status:** Draft · **Created:** 2026-06-18 · **Owner:** jaysuk

A shared contract (in `dwc-plugin-runtime`) that lets a DWC plugin contribute a **configurable,
editable widget** to a host layout — primarily [Flexible Layouts](https://github.com/jaysuk/Flexible-Layouts),
but any host can adopt it. A plugin declares a **config schema**; the host renders an editor and
stores **per-instance** config; the plugin's component receives that config. The same schema also
drives the plugin's own standalone settings, so there's one source of truth.

This is the userland version of the "stable props/config contract for embeddable components" gap (no
DWC change needed); a native DWC contract can follow later, with this as the reference.

---

## 1. Motivation

Today a plugin reaches FL only through DWC's `registerEmbeddableComponent`, which carries **just a
component** — no config, no schema, no editor:

- FL's `EmbeddableWidget.vue` renders it as `<component :is="comp" />` with **no props**.
- FL's `PropertiesDialog.vue` has a hand-written editor block per *built-in* widget type; for
  `embeddable` it shows only a title — **nothing to edit**.
- A plugin that self-sources from one global settings blob (e.g. duet-tool-align) can't be configured
  **per instance** — two widgets on a page share state.

So the missing primitive is a **host↔plugin widget-config contract**: declare editable config → host
renders an editor + persists per-instance config → component receives it.

### Precedent

This mirrors the existing **update hub** (`updateHub.ts`): shared types in the runtime + a
`window`-global coordination layer that works even though every plugin bundles its own copy of this
package. The widget-config framework follows the same shape.

---

## 2. Goals / Non-goals

**Goals**
- A plugin declares an editable config **schema** once; gets a per-instance, FL-editable widget for free.
- One schema drives **both** the host's properties editor **and** the plugin's standalone settings.
- Stay **store-agnostic and zero-dep** (no `@/…` imports; Vue is a peer/external), like the rest of the runtime.
- **No DWC change required**; host adoption is small and additive; backward-compatible (prop-ignoring components still render).

**Non-goals**
- Replacing FL's bespoke editors for its *own* built-in widgets.
- A general form-builder for arbitrary app UI — this is scoped to widget config.
- Layout/placement concerns (that stays the host's job).

---

## 3. Actors

1. **Provider plugin** — declares a schema + (optionally) a custom editor; its component reads `config`.
2. **Host** (FL, or any layout shell) — discovers schemas, renders the editor, persists per-instance config, passes it to the component.
3. **Runtime** (`dwc-plugin-runtime`) — owns the **types**, the **registry** (window-global), and a **schema-driven form** + helpers shared by both sides.

---

## 4. Config schema

A declarative description of a widget's config — a generalisation of the per-field metadata plugins
already hand-write (label, default, range, tooltip).

```ts
export type WidgetFieldType =
  | "number" | "text" | "textarea" | "toggle" | "select" | "color"
  | string; // host-provided types, e.g. "omPath", "gcode", "icon" (see §7)

export interface WidgetField {
  key: string;                       // config object key
  type: WidgetFieldType;
  label: string;                     // already-localised (provider localises)
  description?: string;              // tooltip body; the form appends "(default: …)"
  default: unknown;                  // authoritative default
  group?: string;                    // section heading in the editor/settings
  // numeric
  min?: number; max?: number; step?: number;
  // select
  options?: Array<{ title: string; value: unknown }>;
  // conditional visibility, evaluated against the live config
  visibleWhen?: (config: Record<string, unknown>) => boolean;
}

export interface WidgetConfigSchema {
  /** Stable id, namespaced — matches the embeddable id, e.g. "DuetToolAlign.AutoAlign". */
  id: string;
  /** Schema version for migrations. */
  version: number;
  fields: ReadonlyArray<WidgetField>;
  /** Optional: upgrade a stored config from an older schema version. */
  migrate?: (config: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;
}
```

`applyDefaults(schema, config)` returns a config with every missing key backfilled from `default`
(the same "backfill" duet-tool-align's `useConfig()` already does, generalised).

---

## 5. Registry (window-global, like the update hub)

```ts
export interface RegisteredWidgetConfig {
  schema: WidgetConfigSchema;
  /** Optional custom editor (escape hatch); receives { config, setConfig, host }. */
  editor?: unknown; // Vue Component
}

export function registerWidgetConfig(entry: RegisteredWidgetConfig): void;
export function unregisterWidgetConfig(id: string): void;
export function getWidgetConfig(id: string): RegisteredWidgetConfig | undefined;
export function getWidgetConfigs(): ReadonlyArray<RegisteredWidgetConfig>;
export function subscribeToWidgetConfigs(cb: () => void): () => void; // CustomEvent-backed
```

Lives on a `globalThis.__dwcPluginWidgetConfigs` key + a DOM `CustomEvent`, exactly like
`updateHub.ts`, so a host reads schemas registered by plugins that each bundle their own runtime copy.
A plugin registers in its `index.ts` (and `unregister` on `dwcPluginUnloaded`).

---

## 6. Component prop contract

The host passes the rendered component a documented prop bag (and the runtime exports its type):

```ts
export interface WidgetHostContext {
  /** True while the host is in edit mode (component can show edit affordances / suppress motion). */
  isEditing: boolean;
  /** The placed-instance id, for per-instance scratch/state if needed. */
  instanceId?: string;
}

export interface PluginWidgetProps<C = Record<string, unknown>> {
  config: C;                         // per-instance, reactive, defaults applied
  setConfig: (patch: Partial<C>) => void; // persist back to the host
  host: WidgetHostContext;
}
```

Backward-compat: components that take no props keep working (FL renders them as today). duet-tool-align
already uses `props.widget ?? useConfig()`, so adopting `config` is a rename.

---

## 7. The schema-driven form (store-agnostic)

The runtime ships a renderer the host mounts in its editor, and the plugin can reuse in its own
settings:

```ts
// Render-function component (NOT an SFC) so the runtime keeps its tsc-only build + zero deps; Vue is
// imported as a peer/external.
export const PluginWidgetConfigForm; // props: { schema, modelValue, "onUpdate:modelValue", fieldRenderers? }
```

**The store-agnostic boundary (key design point).** The runtime can render *primitive* fields
(number/text/toggle/select/color-as-text). But rich fields like an **object-model path picker** or a
**G-code editor** need the host's live object model / internals, which the runtime must not import.
Resolution: **host-injectable field renderers**.

```ts
export type FieldRenderer = unknown; // Vue Component, props: { field, modelValue, "onUpdate:modelValue" }
export interface FieldRendererMap { [type: string]: FieldRenderer; }
```

- The runtime form handles primitive types out of the box.
- A field with a host-specific `type` (e.g. `"omPath"`) renders via a `FieldRenderer` the **host**
  supplies (FL passes its `OmPathField`, `ColorSelect`, `IconPicker`). Unknown types fall back to a
  text input with a note, so a schema never hard-fails.

This keeps the runtime clean while letting FL contribute its rich pickers, and lets other hosts supply
their own.

The form renders labels, **tooltips with the default appended** (the pattern duet-tool-align already
ships), ranges/min/max/step, `group` headings, and `visibleWhen`.

---

## 8. Per-instance config, persistence, migration

- The **host** owns persistence: it stores each placed widget's config in its layout document (FL adds
  a `config` field to its `embeddable` widget model) and passes it down via `config` / `setConfig`.
- **Standalone vs instance:** the plugin's own page uses a single "default" config (its existing
  global settings); FL instances each carry their own, seeded from `applyDefaults(schema)`. The
  component resolves `props.config ?? <global default>` — the pattern already in duet-tool-align.
- **Migration:** on load, host calls `applyDefaults` then `schema.migrate?` when the stored
  `version` is behind. Keeps old layouts working as schemas evolve.

---

## 9. Constraints (inherited from the runtime)

- **No `@/…` imports**, no DWC store access — store-specific behaviour is injected (field renderers, host context).
- **Zero runtime deps**; **Vue is a peer/external**.
- **tsc-only build** → the form is a **render-function component**, not a `.vue` SFC.
- Window-global registry so it survives each plugin bundling its own runtime copy.

---

## 10. Adoption plan

1. **Runtime** — add `widgetConfig.ts` (types + registry + `applyDefaults`) and `PluginWidgetConfigForm`
   (render-function). Export from `index.ts`. New tests mirror `updateHub`/`updates` coverage.
2. **FL (host)** — `EmbeddableWidget` passes persisted `config` + host context into the component;
   `PropertiesDialog` renders `PluginWidgetConfigForm` (or a custom editor) for `embeddable` widgets
   that registered a schema, injecting FL's field renderers (`omPath`, `color`, `icon`, `gcode`); add a
   `config` field to the `embeddable` widget model.
3. **duet-tool-align (reference consumer)** — `registerWidgetConfig` with a schema derived from the
   metadata it already has; accept the `config` prop; render its standalone settings from the same
   schema via `PluginWidgetConfigForm`.
4. **Docs** — a short "make your plugin's widget FL-editable" guide.
5. **Later** — propose a native DWC embeddable config contract to Duet3D, with this as the reference.

---

## 11. Worked example (duet-tool-align)

```ts
registerWidgetConfig({
  schema: {
    id: "DuetToolAlign.AutoAlign",
    version: 1,
    fields: [
      { key: "bridgeUrl", type: "text", label: "Camera bridge URL", default: "",
        description: "Base URL of the duet-webcam-bridge, e.g. http://192.168.1.50:8081" },
      { key: "referenceMode", type: "select", label: "Reference", default: "tool", group: "Alignment",
        options: [{ title: "Reference tool", value: "tool" }, { title: "Carriage datum", value: "point" }] },
      { key: "houghParam2", type: "number", label: "Sensitivity", default: 30, min: 1, max: 300, group: "Detection",
        description: "Hough accumulator threshold. Lower finds more circles.",
        visibleWhen: (c) => c.detector === "hough" },
      // …the rest of the existing alignFields / detectFields metadata, verbatim.
    ],
  },
});
```

The same `fields` array already exists in `AutoAlignWidget.vue` (`alignFields`/`detectFields`) — this
RFC just promotes it to a shared, host-readable schema.

---

## 12. Decisions

1. **Field-renderer discovery** — **the host passes a `FieldRendererMap` per editor mount.** Simplest,
   keeps the host in control of its own object-model-aware pickers, and avoids a second global
   registry. The runtime ships primitive renderers; the host adds `omPath`/`color`/`gcode`/`icon`.
2. **Reactivity of `config`** — **immutable read + `setConfig(patch)`.** The component reads a reactive
   `config` and persists via `setConfig`, so the host owns when/how config is written to its layout
   document (no surprise deep mutations). Internally a host may pass a reactive copy for read.
3. **Validation** — **min/max/step for v1**, with unknown/out-of-range values clamped on apply.
   Pluggable validators (and inline error display) are a v2 addition; the `WidgetField` shape leaves
   room (`validate?`) without committing to it now.
4. **Packaging** — **extend `dwc-plugin-runtime`**, exported under `dwc-plugin-runtime/widget-config`
   (matches the update hub; one dependency for plugins to track).
5. **Schema home vs DWC** — keep the schema in the runtime registry **now** (no DWC change). A
   **native DWC contract** is proposed separately in [`dwc-native-proposal.md`](./dwc-native-proposal.md);
   if/when DWC adopts it, this framework becomes the compatibility shim / reference.

### Still genuinely open (revisit during implementation)
- Exact `host` capability surface (`isEditing`, `instanceId`, …) — start minimal, grow as consumers need.
- Whether `PluginWidgetConfigForm` lives at `dwc-plugin-runtime/widget-config` or its own subpath export.
