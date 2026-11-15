# GodotJS engine SDK

Private workspace package for engine API descriptions, execution contracts and browser runtime integration. It has no React dependency. Package publication and compatibility outside this workspace are separate release work.

| Entry point | Responsibility |
| --- | --- |
| `@godot-js/engine/api` | API IR, native naming and declaration generation |
| `@godot-js/engine/runtime-types` | Engine API TypeScript contracts |
| `@godot-js/engine/runtime` | Session-local runtime host, diagnostics and project events |
| `@godot-js/engine/execution` | Browser-safe execution schema and legacy descriptor reader |
| `@godot-js/engine/identities` | Canonical, domain-separated engine, extension, build and artifact identities |
| `@godot-js/engine/browser` | Browser session, verified loader, preview runner and protocol |
| `@godot-js/engine/browser/engine-session` | Whole-session ownership, progress, cooperative stop and forced pool teardown |
| `@godot-js/engine/browser/verified-loader` | Hash-checked JS/WASM, worklets and auxiliary Worker assets |
| `@godot-js/engine/browser/protocol` | Versioned preview protocol |
| `@godot-js/engine/browser/runner` | Separate-origin iframe runner |
| `@godot-js/engine/browser/capabilities` | Fixed Wasm shared-memory-growth startup probe, with bounded Worker/Blob cleanup |

The pure API, execution and identity entries do not load the browser runtime or React. Browser entries intentionally require browser APIs. The engine's `godot` and `godot-jsb` modules remain engine externals; this package does not emulate a running Godot instance.

```sh
pnpm --filter @godot-js/engine build
pnpm --filter @godot-js/engine test
```

Existing `@godot-js/react-browser/engine-api`, identity, loader and session wrappers remain compatibility paths to this implementation. New neutral consumers use the engine package directly. See the [Worker engine guide](../../docs/browser-worker-engine.zh-CN.md) for build provenance, deployment requirements and current activation gates.

Threaded loading tests actual retained-instance shared-memory growth before fetching engine assets. `E_BROWSER_SHARED_MEMORY_GROWTH` rejects an unsupported browser without changing the full native template or using a UA blacklist. Current Linux WebKit 26 is blocked by WK-01; a passing rejection/cleanup check is not engine runtime acceptance.

The identity entry validates complete native descriptors, SDK v2 runtime/type/module identities, site descriptor seals and schema 2 artifact receipts against actual pack bytes. Historical native schema 2 descriptors retain their original complete IDs; missing old optional identity fields do not admit arbitrary labels or partial asset references. Legacy artifact receipts require explicit runner compatibility, and a release advertising `artifactReceiptVersion: 2` always rejects downgrade.
