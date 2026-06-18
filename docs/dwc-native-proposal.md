# DWC 3.7 plugin-API: suggestions for native support

Notes for the DWC maintainer (Christian), distilled from building two external DWC 3.7 plugins
([Flexible Layouts](https://github.com/jaysuk/Flexible-Layouts) and
[duet-tool-align](https://github.com/jaysuk/duet-tool-align)) plus the shared
[`dwc-plugin-runtime`](https://github.com/jaysuk/dwc-plugin-runtime). Each item is something we had to
work around in userland and would be cleaner as a first-class DWC capability. Ordered by impact.

Everything here works *today* via the runtime; these are about making the common cases native so every
plugin author doesn't re-solve them.

> **Status update (DWC `v3.7-dev` @ b9b93bb, "Improved plugin subsystem").** Several of these are now
> addressed natively — thanks! Summary:
>
> | # | Item | Status |
> |---|------|--------|
> | 1 | Embeddable widget config/props contract | ❌ Outstanding (we ship a runtime framework for it) |
> | 2 | Plugin assets (WASM/worker) + `pluginAssetUrl` | ✅ Done |
> | 3 | Awaitable motion primitive | ❌ Outstanding |
> | 4 | Standalone type-checking | ✅ Done (build-time check vs DWC's real types) |
> | 5 | Dev-mode / HMR plugin loading | ❌ Outstanding |
> | 6 | CSP / cross-origin / mixed-content | ✅ Done (documented; no CSP shipped) |
> | 7 | `registerRoute` idempotency | ✅ Done |
> | 8 | Native plugin-update popup | ❌ Outstanding |
> | — | `installPlugin` documented; composables externalised | ✅ Done |
>
> The four ❌ are the remaining asks; the ✅ items below are kept for context (struck where done).

---

## 1. A widget config/props contract for embeddable components  ⭐ highest impact

**Today:** `registerEmbeddableComponent` carries only a component. Hosts (FL) render it as
`<component :is="comp" />` with **no props**, and there's no way to declare or edit per-instance
config. So an embedded plugin widget is a static black box — it can't be configured when placed on a
page, and FL's properties editor has nothing to show for it.

**Suggestion:** extend the embeddable registration so a plugin can ship a **declarative config
schema** and DWC defines the **prop contract** the component receives:

```ts
registerEmbeddableComponent({
  id, pluginId, caption, component,
  configSchema?: WidgetConfigSchema,   // declarative fields (type/label/default/range/options/group)
  editor?: Component,                  // optional custom editor (escape hatch)
});
// DWC renders the component with a documented prop bag:
//   { config, setConfig(patch), host: { isEditing, instanceId } }
```

DWC would also supply a **schema-driven form** (so hosts render a consistent editor) and let the host
inject field renderers for object-model-aware types (path picker, etc.). We've specified exactly this
in [`rfc-widget-config.md`](./rfc-widget-config.md) as a runtime-side shim; if DWC owned the contract,
every layout host (not just FL) would interoperate and plugins wouldn't depend on a third-party
runtime for it. **This is the single change that most improves the plugin-composition story.**

---

## 2. First-class plugin assets (WASM / Web Worker / data files) + a URL resolver

**Today:** an external plugin is a single IIFE JS + CSS injected from the `dwcFiles` manifest. There's
no supported way to ship and resolve *additional* binary assets (a `.wasm`, a worker bundle, an ML
model). For duet-tool-align (OpenCV.js, ~10 MB JS + ~7.5 MB WASM) we had to:
- serve OpenCV.js from a *separate* device (the camera bridge) to avoid bundling it, and
- run it in a **Web Worker created from an inline Blob** (the only way to get off the main thread
  without an emittable worker file), `importScripts()`-ing the cross-origin URL.

**Suggestion:**
- Let a plugin declare extra asset files in its manifest; serve them alongside the bundle.
- Expose `DWC.pluginAssetUrl(pluginId, relPath)` (resolved against `BASE_URL` + the plugin dir) so code
  can locate them at runtime.
- Document/support `new Worker(new URL("./worker.js", import.meta.url))` through `build-plugin-pkg`, so
  heavy CPU work has a sanctioned off-main-thread path. (Main-thread WASM froze the whole DWC tab until
  we moved to a worker — worth making easy.)

---

## 3. Awaitable motion / code-completion primitive

**Today:** `machineStore.sendCode` resolves on the immediate reply, not when motion finishes. Any
plugin that coordinates motion (tool-align's calibration/centring loop) must either append `M400` and
hope, or poll `move.axes[].machinePosition` / `state.status`.

**Suggestion:** a documented helper to await completion — e.g. an `M400`-backed `awaitMotionComplete()`
or an object-model "idle" promise — so vision/automation plugins can sequence reliably.

---

## 4. Published plugin-API type definitions

**Today:** external plugins import `@/…` aliases that only resolve inside the DWC source tree, so
type-checking means copying `src/` into a throwaway folder under `<DWC>/src/plugins/` and running
`vue-tsc` (the `dwc-plugin-test-kit` does this; it leaves `_typecheck_*` dirs around). The runtime
surface is already generated (`virtual:dwc-plugin-api` / `global-api.ts`).

**Suggestion:** emit/publish `@duet3d/dwc-plugin-api` `.d.ts` (and/or a thin package) from that
generated surface, so plugins type-check standalone in CI without a DWC checkout. Incremental — the
data already exists at build time.

---

## 5. Dev-mode loading / HMR for external plugins

**Today:** `loadDwcPlugin` skips external plugins in dev (`import.meta.env.DEV`), so iterating means
build-zip → install-on-board → reload for every change.

**Suggestion:** a dev affordance to load a local plugin bundle/dir (env var or settings field), ideally
with HMR. Biggest day-to-day DX win for plugin authors.

---

## 6. CSP / cross-origin declaration + mixed-content guidance

**Today:** plugins that talk to another origin (tool-align → the camera bridge for frames + OpenCV)
must reason about CORS and canvas tainting themselves, and HTTPS-DWC→HTTP-device is silently blocked.

**Suggestion:** let a plugin declare `externalHosts` in its manifest (reflected into CSP `connect-src`),
and document the mixed-content constraint + a recommended pattern (same-origin proxy / device TLS).

---

## 7. Make `registerRoute` idempotent (dedupe by path)

**Today:** `registerRoute` pushes a nav item + route on every call. Re-evaluating a plugin's entry
module (e.g. installing a new build over a running one without a full reload) leaves a **duplicate nav
entry**; we work around it by calling `unregisterRoute(path)` before `registerRoute`.

**Suggestion:** dedupe by `path` inside `registerRoute` (like `registerSettingTab`/
`registerEmbeddableComponent` already dedupe by key/id), so a re-register is a no-op rather than a
duplicate.

---

## 8. Native plugin-update mechanism + unified popup

**Today:** each plugin re-implements "check GitHub Releases → offer one-click update", and to avoid
several popups we built a cross-plugin **update hub** in the runtime (a window-global registry; the
active layout shell shows one aggregated popup). It works, but it's userland glue every plugin must
adopt, and the apply path depends on `machineStore.installPlugin`'s (currently informal) signature.

**Suggestion:** DWC could host this natively — read an `updateUrl`/GitHub repo from the manifest, check
for newer compatible releases, and show **one** built-in "updates available" surface across all
plugins, with a stable `installPlugin(filename, blob, start)` contract. Plugins then get
auto-update for free. (Our runtime hub + the `<!-- dwc-plugin-update … -->` release-note marker can
serve as a reference for the data shape.)

---

## Smaller things

- **`installPlugin` signature + JSZip:** keep `installPlugin(filename, blob, start)` stable and the
  JSZip reconstruction optional (3.7 dd57f65+ already does this) — it lets the update path bundle zero
  deps. Just worth documenting as a supported API.
- **`dwcVersion: "auto" / "auto-major"`** resolution is great; documenting how it's compared at install
  (and exposing the resolved requirement) helps update checkers match DWC's own gate.
- **Externalised composables:** `@/composables/useConfirmDialog` etc. being on the global surface
  (3.7.0-alpha.5+) was a real improvement — more of the common UI composables (input dialog, snackbar)
  being part of the documented surface would help.

---

*Context: these came up building real plugins against `v3.7-dev`. Happy to discuss any of them, open
issues/PRs, or share the runtime/FL/tool-align code as concrete references.*
