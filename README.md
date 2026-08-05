# dwc-plugin-runtime

Shared **runtime** utilities for DuetWebControl (Vue 3) plugins — the bits several plugins re-implement:
user-initiated **diagnostics capture**, **clipboard** (works on plain-HTTP Duets), and **file download**.

Unlike [`dwc-plugin-test-kit`](https://github.com/jaysuk/dwc-plugin-test-kit) (a dev-only test harness,
externalised), this ships **inside the plugin bundle**. So it's a regular `dependency`, has **no runtime
deps**, and is **store-agnostic** — you pass the object model in; it never imports `@/stores/*`. That's
what lets it bundle into any plugin and survive DWC version changes.

## Install

[Published on npm](https://www.npmjs.com/package/dwc-plugin-runtime) - a plain install needs no git
access:

```bash
npm install dwc-plugin-runtime
```

```jsonc
// plugin package.json
"dependencies": {
  "dwc-plugin-runtime": "^0.8.7"
}
```

A `github:jaysuk/dwc-plugin-runtime#vX.Y.Z` reference still works if you'd rather pin to a specific
commit/tag directly - installing from GitHub runs the package's `prepare` step, which builds `dist/`
(compiled JS + types) the same way the published tarball already does.

## Diagnostics

```ts
import { installErrorCapture, recordError, buildReport, downloadReport, copyReport } from "dwc-plugin-runtime";

// On plugin load (app-lifetime), buffer uncaught errors; uninstall on unload.
const stop = installErrorCapture();
// In an error boundary / catch site, record context-rich errors:
recordError("widget", err);

// Build a report (versions from model.plugins[id], firmware from boards[0]); the model is scrubbed.
const report = buildReport({ pluginId: "MyPlugin", model: machineStore.model, state: { widget } });
downloadReport(report);        // → MyPlugin-diagnostics-….json
await copyReport(report);      // → clipboard (execCommand-first)
```

`sanitizeModel` (used by `buildReport`) redacts privacy-sensitive values before sharing — network
IP/SSID/MAC/hostname, board `uniqueId`, and G-code file names — while keeping the structure intact.

### The payoff loop

A captured report's `model` + `state` replay straight into a `dwc-plugin-test-kit` mount test:

```ts
setModel(loadObjectModel(report.model));
mountInDwc(WidgetView, { props: { widget: (report.state as any).widget } });
// assert it no longer throws
```

So a user's bug report becomes a one-paste reproduction → a failing test → a fix → a permanent test.

## Other helpers

```ts
import { copyText } from "dwc-plugin-runtime";            // Promise<boolean>, execCommand fallback
import { downloadBlob, downloadJson } from "dwc-plugin-runtime";
downloadJson("model.json", obj, mapReplacer);            // replacer is optional (e.g. for Maps)
```

## Develop

```bash
npm install      # also builds dist via prepare
npm run build    # tsc → dist
npm test         # vitest self-tests
```
