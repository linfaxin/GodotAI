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
| `@godot-js/engine/release-assets` | Stored-byte integrity, bounded explicit decoding and host-injected raw asset readers |
| `@godot-js/engine/browser` | Browser session, verified loader, preview runner and protocol |
| `@godot-js/engine/browser/engine-session` | Whole-session ownership, progress, cooperative stop and forced pool teardown |
| `@godot-js/engine/browser/verified-loader` | Hash-checked JS/WASM, worklets and auxiliary Worker assets |
| `@godot-js/engine/browser/release-adapter` | Captured native/site descriptors to a paired Dedicated Worker release and release facts |
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

Dedicated Worker infrastructure lives under `src/browser/dedicated/`; its concrete module subpaths are also exported for the existing browser bridges and worklet build. The corresponding `@godot-js/react-browser/worker-*` modules are compatibility reexports, not separate implementations. The product compiler policy, type environment and artifact pipeline live in `project-tools`; the retained browser SDK resolver and conformance compiler remain in `react-browser`.

`prepareWorkerRelease()` takes the original descriptor and site JSON bytes, a preview mirror root, allowed origins, presenter and cache policy. It validates their pairing and prepares asset URLs; the loader verifies executable bytes when consumed. A product host's additional release context remains its adapter's responsibility. `WorkerRunnerEvent` and `WorkerRunnerExit` retain all seven run fields; observed exits include native/host facts, while local fallback exits leave unobserved facts absent. The shared legacy runner types keep their existing contract.

Existing `@godot-js/react-browser/engine-api`, identity, loader and session wrappers remain compatibility paths to this implementation. New neutral consumers use the engine package directly. See the [Worker engine guide](../../docs/browser-worker-engine.zh-CN.md) for build provenance, deployment requirements and current activation gates.

## Live exported properties

Dedicated Worker runners expose `describeRuntimeProperties`, `readRuntimeProperties` and `writeRuntimeProperty` when the release advertises and negotiates `runtimeProperties: 1`. Public value types and validators are exported through `@godot-js/engine/browser/dedicated/worker-runtime-properties`.

On a Full Engine debug Worker Direct release with `runtimeCall: 1`, `WorkerPreviewRunner.describeRuntimeMethods` discovers the explicitly annotated methods on an exact GodotJS node instance. Pass the returned `methodToken` and typed arguments to `callRuntimeMethod`. The token binds the registration to the instance, run and release. Both methods and their input and result types are available from `@godot-js/engine/browser/dedicated/worker-runner`. Invoke results include the entry frame and indicate whether the method returned, threw, returned a value that could not be encoded, or has an unconfirmed outcome. An unconfirmed result can follow cancellation or loss of the transport. Read the live state before retrying an effect.

The first version supports registered GodotJS scalar exports (`bool`, safe `int`, finite `float`, bounded `string`) and the existing native `Node2D.position` Vector2 path. Describe returns static metadata without evaluating getters. Script access is explicitly live and can execute user getters or setters; a descriptor marked `candidate` means access can be attempted, not that writing is guaranteed. Script Vector2 and other object/container values are not supported.

Requests bind `runId`, absolute `path` and the string `expectedInstanceId` obtained from the actual runtime tree. Reads also specify each declared type; writes carry a tagged value. Replies retain a complete `receipt` with run/release/request identity. A confirmed write includes the native before/after/comparison values and frame counters. `not_written` confirms the write path was not entered but may follow a getter with side effects. `unconfirmed` does not establish whether access occurred, so consumers must not automatically retry it.

The new capability is independent of the old observation and position-write ABIs. Older templates keep their original methods and result shapes and report the new property capability as unsupported. New templates require matching source-bound exports, SDK and release proof; a frontend refresh cannot provide them. See the [implementation contract and validation flow](../../docs/design/runtime-properties-and-summer-api-v2.zh-CN.md).

## Project runtime host

`createRuntimeBinding()` supplies the shared implementation for both browser backends. `RuntimeHost` exposes `apiVersion: 1`, `sessionId`, `role`, `reportDiagnostic()`, `emitProjectEvent()` and `bindProjectCommand()`. A `true` result acknowledges local admission, not remote delivery. Command handlers can return a Promise, but the transport receipt acknowledges synchronous dispatch; later rejection is reported against the originating entry. Project data is copied to an owned bounded JSON snapshot before it is queued or sent. Role assignment, native progress and logging are internal binding hooks.

One realm has one installed owner. A binding's `openEntry()` returns an internal scope with a public host view; generated `start(ctx)` programs receive that view as `ctx.host`. React root options accept the same host, made available through `useRuntimeHost()`. Entry close revokes that view and its command binding, while a native epoch end seals the environment's observation without uninstalling the realm host. Old entry callbacks cannot activate a replacement entry. Native/standalone scripts may run without a browser host.

Generated ordinary entries also receive `ctx.lifetime`: a cooperative, DOM-independent `EntryLifetime` with `cancelled`, `onCancel(callback)` and `defer(cleanup)`. Startup and registered cleanup may return Promises. Closing revokes business services, broadcasts cancellation and executes registered cleanup in reverse order, waiting for each asynchronous result before advancing that entry. The binding tracks unresolved startup and cleanup separately; native sealing makes unfinished work unconfirmed and prevents late callbacks from entering the released epoch. There is no `ctx.signal`, and cancellation does not stop arbitrary application Promises.

React roots created with the captured `runtimeHost` automatically join its entry through the internal `attachEntryCleanup()` hook. `root.shutdown()` retains its request-only API; `root.close()` returns an idempotent Promise whose result distinguishes complete, failed and unconfirmed cleanup. Logical root disposal and `queue_free()` admission do not prove that native destruction completed. `getCloseProgress()` retains the release ledger until actual native identities are gone; sealing a still-pending root makes its result unconfirmed without reading native objects.

For matching Web builds, lifecycle ABI 1 installs an owner-realm native pre-exit gate. Stop and project `quit()` close entries before native cleanup. A cleanup-only loop advances registered participants and consumes the native deletion queue after callbacks return, then a later tick observes release completion. It does not run process/physics subscriptions or flush the general deferred business queue. The existing host deadline still owns forced termination. The ABI must be backed by the applied Web/SceneTree patch chain and matching engine assets; adding descriptor metadata or refreshing the frontend cannot provide it.

Dedicated Worker drain keeps bounded DOM release credits separate from ordinary host commands. Saturated business commands cannot prevent mirrored element removal, pointer/fullscreen release, speech cancellation or drop-credit release. Only matching run/sequence receipts return transport credits; duplicate or stale receipts do not. The main-thread privileged request queue also reserves a separate bounded drain lane, so unresolved ordinary requests cannot block pointer/fullscreen release.

## Exit facts and engine matching

`@godot-js/engine/session-facts` exports `SessionFacts`, `createSessionFacts()`, wire validators, runtime-summary aggregation and `sessionExitReason()`. Facts retain the first fatal, actual native exit, application force-stop, runtime summary and cleanup observations independently. Missing summaries, pending entry work and cleanup timeout never become complete merely because native exit code is zero.

The default Dedicated Worker sends its summary through its existing control channel. Pthread uses runtime packet version 2, preserving outer preview protocol 1 and Dedicated Worker protocol 2. The pthread owner waits for registered native epoch summaries before pool disposal, with a bounded deadline and an unconfirmed result if observations are missing. These packets do not replace native Variant routing or audio/presentation channels.

Native epoch hooks span native interop and `impl/web/bridge` pre-JS glue. Logical environment disposal seals the epoch and prevents late entry cleanup from entering disposed native state; physical bridge release remains separate and keeps an idempotent seal fallback. A sealed summary does not prove that all native objects were destroyed or asynchronous entry cleanup completed. Hook changes require a matching Web engine/template rebuild; rebuilding this package or refreshing the frontend alone cannot add them to an existing template. Factory serialization tests and Node fixtures check JavaScript behavior, not acceptance of a complete rebuilt browser engine.

Threaded loading tests actual retained-instance shared-memory growth before fetching engine assets. `E_BROWSER_SHARED_MEMORY_GROWTH` rejects an unsupported browser without changing the full native template or using a UA blacklist. Current Linux WebKit 26 is blocked by WK-01; a passing rejection/cleanup check is not engine runtime acceptance.

The identity entry validates complete native descriptors, SDK v2 runtime/type/module identities, site descriptor seals and schema 2 artifact receipts against actual pack bytes. Historical native schema 2 descriptors retain their original complete IDs; missing old optional identity fields do not admit arbitrary labels or partial asset references. Legacy artifact receipts require explicit runner compatibility, and a release advertising `artifactReceiptVersion: 2` always rejects downgrade.

Product SDK source/build proofs include this package and `project-tools`, their actual exported outputs, build scripts, shared TypeScript configuration and runtime declaration inputs. Moving a source file changes the sealed source-map/provenance paths even when runtime behavior is unchanged.

See the [engine evolution implementation guide](../../docs/engine-evolution-implementation.zh-CN.md) for the current APIs, validation commands and prototype boundaries. Default execution remains Dedicated Worker; the pthread route remains an explicitly selected candidate.
