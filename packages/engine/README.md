# GodotJS engine SDK

Private workspace package for engine API descriptions, execution contracts and browser runtime integration. It has no React dependency. Package publication and compatibility outside this workspace are separate release work.

| Entry point | Responsibility |
| --- | --- |
| `@godot-js/engine/api` | API IR, native naming and declaration generation |
| `@godot-js/engine/runtime-types` | Engine API TypeScript contracts |
| `@godot-js/engine/runtime` | Pure host contract, realm binding and entry-scoped diagnostics/project services |
| `@godot-js/engine/session-facts` | Pure versioned runtime summaries, cleanup facts and exit-reason projection |
| `@godot-js/engine/execution` | Browser-safe execution schema and legacy descriptor reader |
| `@godot-js/engine/identities` | Canonical, domain-separated engine, extension, build and artifact identities |
| `@godot-js/engine/browser` | Browser session, verified loader, preview runner and protocol |
| `@godot-js/engine/browser/engine-session` | Whole-session ownership, progress, cooperative stop and forced pool teardown |
| `@godot-js/engine/browser/verified-loader` | Hash-checked JS/WASM, worklets and auxiliary Worker assets |
| `@godot-js/engine/browser/protocol` | Versioned preview protocol |
| `@godot-js/engine/browser/runner` | Separate-origin iframe runner |
| `@godot-js/engine/browser/capabilities` | Fixed Wasm shared-memory-growth startup probe, with bounded Worker/Blob cleanup |
| `@godot-js/engine/browser/dedicated/worker-runtime` | Dedicated Worker runtime and installed project host |
| `@godot-js/engine/browser/dedicated/worker-host` | Separate-origin host, browser/audio/presentation bridges and cleanup |
| `@godot-js/engine/browser/dedicated/worker-runner` | Dedicated Worker preview runner |

The pure API, runtime, session-facts, execution and identity entries do not load the browser runtime or React. Runtime and fact declarations require only ES2022 libraries. Browser entries intentionally require browser APIs. The engine's `godot` and `godot-jsb` modules remain engine externals; this package does not emulate a running Godot instance.

```sh
pnpm --filter @godot-js/engine build
pnpm --filter @godot-js/engine test
```

Dedicated Worker infrastructure lives under `src/browser/dedicated/`; its concrete module subpaths are also exported for the existing browser bridges and worklet build. The corresponding `@godot-js/react-browser/worker-*` modules are compatibility reexports, not separate implementations. Browser compiler and resolution code remains in `react-browser`.

Existing `@godot-js/react-browser/engine-api`, identity, loader and session wrappers remain compatibility paths to this implementation. New neutral consumers use the engine package directly. See the [Worker engine guide](../../docs/browser-worker-engine.zh-CN.md) for build provenance, deployment requirements and current activation gates.

## Project runtime host

`createRuntimeBinding()` supplies the shared implementation for both browser backends. `RuntimeHost` exposes `apiVersion: 1`, `sessionId`, `role`, `reportDiagnostic()`, `emitProjectEvent()` and `bindProjectCommand()`. A `true` result acknowledges local admission, not remote delivery. Command handlers can return a Promise, but the transport receipt acknowledges synchronous dispatch; later rejection is reported against the originating entry. Project data is copied to an owned bounded JSON snapshot before it is queued or sent. Role assignment, native progress and logging are internal binding hooks.

One realm has one installed owner. A binding's `openEntry()` returns an internal scope with a public host view; generated `start(ctx)` programs receive that view as `ctx.host`. React root options accept the same host, made available through `useRuntimeHost()`. Entry close revokes that view and its command binding, while a native epoch end seals the environment's observation without uninstalling the realm host. Old entry callbacks cannot activate a replacement entry. Native/standalone scripts may run without a browser host.

The public contract has no signal or `ctx.signal`. Internal session cancellation and entry closure remain distinct. Startup may be asynchronous; cleanup is a synchronous function invoked at most once. Pending startup, asynchronous cleanup and late results after native epoch seal remain unconfirmed. The binding does not claim to cancel arbitrary project work or await all application Promises.

## Exit facts and engine matching

`@godot-js/engine/session-facts` exports `SessionFacts`, `createSessionFacts()`, wire validators, runtime-summary aggregation and `sessionExitReason()`. Facts retain the first fatal, actual native exit, application force-stop, runtime summary and cleanup observations independently. Missing summaries, pending entry work and cleanup timeout never become complete merely because native exit code is zero.

The default Dedicated Worker sends its summary through its existing control channel. Pthread uses runtime packet version 2, preserving outer preview protocol 1 and Dedicated Worker protocol 2. The pthread owner waits for registered native epoch summaries before pool disposal, with a bounded deadline and an unconfirmed result if observations are missing. These packets do not replace native Variant routing or audio/presentation channels.

Native epoch hooks span native interop and `impl/web/bridge` pre-JS glue. Logical environment disposal seals the epoch and prevents late entry cleanup from entering disposed native state; physical bridge release remains separate and keeps an idempotent seal fallback. A sealed summary does not prove that all native objects were destroyed or asynchronous entry cleanup completed. Hook changes require a matching Web engine/template rebuild; rebuilding this package or refreshing the frontend alone cannot add them to an existing template. Factory serialization tests and Node fixtures check JavaScript behavior, not acceptance of a complete rebuilt browser engine.

Threaded loading tests actual retained-instance shared-memory growth before fetching engine assets. `E_BROWSER_SHARED_MEMORY_GROWTH` rejects an unsupported browser without changing the full native template or using a UA blacklist. Current Linux WebKit 26 is blocked by WK-01; a passing rejection/cleanup check is not engine runtime acceptance.

The identity entry validates complete native descriptors, SDK v2 runtime/type/module identities, site descriptor seals and schema 2 artifact receipts against actual pack bytes. Historical native schema 2 descriptors retain their original complete IDs; missing old optional identity fields do not admit arbitrary labels or partial asset references. Legacy artifact receipts require explicit runner compatibility, and a release advertising `artifactReceiptVersion: 2` always rejects downgrade.

Product SDK source/build proofs include this package and `project-tools`, their actual exported outputs, build scripts, shared TypeScript configuration and runtime declaration inputs. Moving a source file changes the sealed source-map/provenance paths even when runtime behavior is unchanged.
