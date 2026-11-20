# Repository architecture

GodotJS combines a native Godot module with embedded JavaScript support code and reusable ecosystem packages in one pnpm workspace. Native module directories and embedded-script output paths stay in their existing locations to preserve SCons and upstream integration.

The [engine goals and platform boundaries](engine-goals.zh-CN.md) define the long-term direction: a reusable project, build, runtime and verification foundation for AI game creation platforms, with conversation and AI orchestration owned by each platform. Target capabilities in that document are distinct from the currently implemented scope described here.

## Layout and responsibilities

| Location | Responsibility |
| --- | --- |
| `bridge/` | Native bindings, module resolution, JavaScript environments, NativeWorld claims/observation, host operations, resource scopes and early ArtifactSet admission |
| `weaver/`, `weaver-editor/` | Godot script-language and editor integration |
| `internal/`, `compat/` | Native support code and engine compatibility |
| `impl/` | V8, QuickJS, JavaScriptCore, and browser backends |
| `scripts/jsb.runtime/` | Private runtime support embedded in the engine |
| `scripts/jsb.editor/` | Private editor support and type generation |
| `impl/web/bridge/` | Private TypeScript bridge compiled into Emscripten glue |
| `packages/engine/` | Neutral API/declarations, runtime host and entry scopes, execution/exit facts, browser backends and whole-session ownership |
| `packages/engine/src/browser/dedicated/` | Default Dedicated Worker runtime, runner, host, browser/audio/presentation bridges and worklet |
| `packages/project-tools/` | Shared compiler policy and incremental type environment, revisioned workspaces, owned build bytes, launch/build plans, bounded build/resource caches, UID/source maps, binary resource producers, PCK/ArtifactSet and a separate Node CLI adapter |
| `scripts/jsb.react/`, `scripts/jsb.react-build/` | React renderer and React startup/build adapters; compatibility core reexports |
| `packages/` | Reusable libraries with their own build and package entry points |
| `apps/playground/` | Static Monaco workbench, native/React project compiler worker, separate-origin preview and native React demos |
| `scripts/jsb.react-browser/` | Browser compiler and release adapters; compatibility reexports for neutral engine/session code |
| `scripts/jsb.web-engine/` | Versioned engine, SDK, compiler and declaration release assets |
| `configs/tsconfig/` | Shared checks for new TypeScript packages |
| `tests/project/` | Independent GodotJS consumer used by engine integration tests |

The active workspace contains the root orchestration package, the three embedded-script packages, the React renderer, Node and browser build tools, the Web engine release package, `packages/tsx`, and the Playground application.

## Build boundaries

Install dependencies explicitly from the GodotJS module root, using the Node.js and pnpm versions declared by the repository:

```sh
pnpm install --frozen-lockfile
```

| Command | Responsibility |
| --- | --- |
| `pnpm build:engine-js` | Build only `@godot-js/jsb-runtime`, `@godot-js/jsb-editor`, and `@godot-js/web-bridge` |
| `pnpm build:packages` | Build packages selected by their `packages/` location, React renderer, Node compiler and browser compiler |
| `pnpm build:playground` | Build the full-engine default Playground, exact API/type release and retained legacy showcase using a matching editor and full-module Web template |
| `pnpm typecheck:packages` | Check ecosystem package types without emitting files |
| `pnpm build` | Build embedded scripts followed by ecosystem packages |
| `pnpm test` | Run the existing engine runtime matrix |
| `pnpm test:react` | Run React renderer contracts and build-tool tests |
| `pnpm test:engine` | Run neutral engine and project-tool tests |
| `pnpm browser:engine:worker` | Build an explicitly selected `proxy-pthread` candidate in its own namespace |
| `pnpm test:browser:worker` | Run the real TLS/two-origin full-engine Worker probe |

SCons invokes `build:engine-js` before generating embedded sources when `skip_js_runtime` is disabled. It checks for pnpm and the embedded packages' local TypeScript installations and reports the explicit preparation command when dependencies are missing. It does not invoke `pnpm install` or the aggregate build.

The embedded output contracts remain:

```text
scripts/out/jsb.runtime.bundle.*
scripts/out/jsb.editor.bundle.*
impl/web/js/jsbb.impl.js
impl/web/js/library_godotjs_jsbi.js
```

The runtime and editor bundles retain AMD output. SCons embeds them into generated native source; the browser bridge is supplied to Emscripten as pre-JS and a JS library. Changes to these internal sources still require rebuilding the corresponding engine artifacts.

`skip_js_runtime=yes` consumes previously built or downloaded embedded scripts. Run `pnpm build:engine-js` to prepare those outputs before native compilation. Use `pnpm build:packages` and the relevant package tests for changes to reusable packages. [Local verification policy](../CONTRIBUTING.md#local-verification)

There is no engine-only dependency installation profile at present. A full explicit workspace install prepares all active packages. If applications later add substantial dependencies, validate a dedicated preparation profile before promising filtered installation; a filtered build alone does not isolate installation.

## Package and dependency boundaries

Keep the embedded-script packages private. Their package names identify workspace build units, not separately installable engine runtimes.

New reusable libraries belong in `packages/`, and applications consume those libraries. The existing `@godot-js/react`, `@godot-js/react-build`, and browser-specific `@godot-js/react-browser` packages stay under `scripts/` and are explicitly included in the ecosystem build. Libraries do not depend on application code. Declare package dependencies with `workspace:*` and use package entry points rather than imports into another package's source directory.

`@godot-js/engine/api`, `@godot-js/engine/runtime`, `@godot-js/engine/session-facts`, execution contracts and identity helpers do not load React, DOM or a compiler. The runtime and fact entry declarations can be consumed with only ES2022 libraries. `@godot-js/engine/browser` intentionally owns browser runtime behavior. `@godot-js/project-tools` owns the shared preparation implementation; old React build `core` paths delegate to it. React bootstrap is an adapter over that preparation. Native scripts do not fetch the React vendor merely to run the engine.

Dedicated Worker execution modules live under `packages/engine/src/browser/dedicated/` and are exported as `@godot-js/engine/browser/dedicated/worker-*`. Their old `@godot-js/react-browser/worker-*` paths only reexport the implementation. The product compiler policy, type environment and prepare/overlay/PCK facade live in `project-tools`, with browser loading and editor messages supplied by the Playground. The retained browser SDK resolver and conformance compiler remain in `react-browser`. Product entry points, worklet builds, source-map seals and SDK producer proofs follow this same dependency closure, including `engine`, `project-tools`, their build scripts and runtime declaration inputs.

GodotJS provides modules such as `godot`, `godot-jsb`, `godot.lib.api`, and `godot.annotations` inside the engine. Future ecosystem code must use the intended host API and preserve required host modules as external references when bundling. It must not install the private embedded packages as substitute runtimes.

Do not create empty renderer, reactivity, compiler, resolver, or type packages solely to reserve names. Extract an additional package when it has a concrete responsibility and consumer. See [package conventions](../packages/README.md).

## Native world and renderer ownership

A native `NativeWorld` records ObjectID identity, environment identity, claims and bounded structure/retirement observations. Its WorldAPI boundary is exposed internally as `godot-jsb.internal.native_runtime`; “WorldAPI” is an architectural name, not another public module. It contains no React tree, JS callbacks or raw object ownership pointers. `NativeWorld`, `ResourceScopes` and `EngineRunLease` use one native opaque capability-token mint. Native operations resolve the token in the expected registry and verify its world, environment, scope and live object claim; a JavaScript object with matching fields cannot mint authority.

A generic native claim governs object lifetime. Godot's `Node.owner` governs native scene ownership and serialization. A typed component's property writer governs which producer may change a property during a frame. These are three separate contracts. Raw Godot scripts continue to use the full engine API; React is an optional same-realm consumer. `enable_legacy_react=no` is the default SCons configuration, and the engine renderer uses the shared native claim registry directly. The old native React ownership pipeline is an explicit compatibility build and cannot share a world with the engine renderer.

Pinned Godot 4.6.1 Node mutation hooks publish structure records; the ObjectDB removal hook publishes actual identity retirement after releasing its lock. They do not call JavaScript. The renderer consumes dirty records on ordinary frames, so unchanged watched trees need no full record/child traversal. Initial validation, observer overflow, missing observation support and uncertain ancestry retain full-audit fallbacks. Notification admission or `queue_free()` is never proof that an object was destroyed.

Retirement validates a complete descriptor batch and its topmost deletion frontier at an owner checkpoint before changing claims. A rejected batch has no partial retirement or deletion effects. Native destruction is scheduled only for the accepted frontier; ObjectDB retirement tombstones settle every descendant's ledger. Closing a scope retains unresolved claims as retiring/quarantined records until their actual outcome is known.

`EngineHostOperations` supplies the direct renderer's property, command and signal adapters, including scoped audio registration, with native scope/claim validation. Signals translate engine objects into typed handles or explicit unmanaged-node descriptions instead of exposing unchecked raw native values. `ResourceScopes` clones `resource_local_to_scene` graphs for detached template roots, preserving aliases within an instance and native local-scene identity across supported Resource classes. Script resources require an explicit contract; physics callbacks cannot allocate these local resource scopes. Generated NativeInterface scripts keep native lifecycle and RPC metadata and route callbacks into the current engine-renderer handlers. ENet transport and editor export remain separate validation scopes. The full `tests/react_native_interfaces/run.mjs` fixture separately checks source/development and formally exported PCK server/client pairs, retaining native certificate and SDK identities.

Managed CLI bootstrap uses `EngineRunLease` for attachment and build-generation admission. Independent native siblings survive renderer-root closure; unknown children in a managed island retain the island in quarantine instead of being freed without a claim. Startup metrics count `publishedRecords` separately from the still-live retirement ledger, and template resources use the same asset service as other manifest assets.

## Runtime host and exit observations

Both browser backends install the pure `createRuntimeBinding()` implementation before loading project modules. Generated native bootstrap embeds that same transport-neutral binding and connects it to the matching native lifecycle hooks. Its public `RuntimeHost` surface contains `apiVersion`, `sessionId`, `role`, `reportDiagnostic()`, `emitProjectEvent()` and `bindProjectCommand()`. Event and diagnostic booleans mean local admission, not remote delivery or application success. Project commands use one current handler and a disposer that can remove only its own binding. Queued messages own validated JSON snapshots and are charged by their serialized UTF-8 size; command receipts acknowledge synchronous dispatch, not completion of returned Promises.

Queued commands retain their entry owner even when its handler is temporarily unbound. Switching entries cancels the previous entry's commands and returns their receipts; closing an older entry cannot discard a newer entry's queue. Commands received before the first entry are claimed when it opens. Both runners buffer bounded startup project events and deliver them through their normal subscriptions after entering `running`; stopping or replacing a run discards its pending events.

Project-data readers enforce the same dense JSON shape, traversal limits and actual serialized UTF-8 budget as the runtime binding. Array indices do not consume a second object-key budget. A Dedicated host that discards an identified project packet returns its consumption receipt, while a forwarded event retains its credit until the editor consumes it.

One engine realm has one binding owner. An internal native epoch identifies the current GodotJS environment, and `openEntry()` creates a revocable project entry scope within it. Generated script bootstrap opens that scope before requiring the user's entry and passes `ctx.host`, `ctx.lifetime` and the explicit `ctx.entry` capability. `createRoot(ctx.mount, {entry: ctx.entry})` binds the root to that captured entry; the capability validates its receiver and host in the originating runtime registry. It does not infer authority from whichever entry happens to be current. Closing one entry revokes its services and command binding without closing another entry or the session. Direct access to the global binding has session scope only.

`ctx.lifetime` supplies `cancelled`, `onCancel()` and `defer()` without DOM types. The captured entry tracks asynchronous startup and synchronous or asynchronous cleanup. Closing revokes business services, broadcasts cancellation and executes registered cleanup in reverse order, waiting for each returned Promise before advancing that entry. An unresolved start, unfinished cleanup or result arriving after native epoch seal remains unconfirmed; cancellation does not stop arbitrary application Promises. Cleanup errors use the captured entry's teardown reporter after business services have been revoked.

React's internal teardown reporter remains available while the captured root is still shutting down and its native epoch is alive, including shutdown deferred by a physics frame. A failed entry cleanup is permanent for that entry; a later readiness or completion assessment cannot overwrite it.

Session handling has active, draining and settled stages. The first valid fatal diagnostic is latched synchronously before unsafe exit work is deferred. Draining stops business messages while preserving bounded diagnostics, receipts and exit observations. The shared `session-facts` module validates versioned `sessionFacts`, retains fatal/native-exit/forced-stop/entry-cleanup/host-cleanup facts independently and projects the exit reason. Missing or overflowed summaries remain unconfirmed. A late exit zero cannot erase a fatal or an application force-stop, and pool reclamation after a confirmed exit is not itself an application force-stop.

An already retained session failure takes precedence over errors observed during shutdown. Host cleanup includes the verified loader's resources as well as workers, audio and ports; loader disposal errors make the final cleanup fail without replacing an existing timeout result.

For pthread script Workers, the native parent retains each child until that child disposes its own environment and descendants on its owner thread; joining occurs outside registry/ObjectDB/language locks. A browser summary deadline does not replace this native child-lifetime barrier. Uncooperative children remain a forced/unconfirmed session outcome.

The default runtime attaches its native epoch summary to the existing control-channel exit message. The pthread owner records each registered worker epoch and waits for its sealed summary, or a bounded observation deadline, before destroying the pool. Native bridge initialization starts the epoch; successful logical `Environment::dispose()` seals it and revokes its routing. Physical `FreeEngine()` retains an idempotent seal fallback and performs the actual bridge release. Sealing records data without running user cleanup or uninstalling the realm host, and does not certify that every native object was destroyed. These native interop and pre-JS bridge changes require matching rebuilt Web engine/template assets. A frontend-only refresh cannot add the hooks to an old template.

React roots supplied with `ctx.entry` register cleanup on that exact entry capability. The entry-scoped `runtimeHost` hook remains a compatibility adapter. `shutdown()` requests shutdown; `close()` additionally waits for the release ledger, including native objects accepted by `queue_free()` but still alive. `getStats().state === 'disposed'` is logical renderer disposal, while `getCloseProgress()` and the close result retain actual release completion. Native seal stops further native reads and makes pending cleanup unconfirmed.

Matching Web engines advertise lifecycle ABI 1 from the actual applied execution-specific Web/SceneTree patch chain. Matching native QJS and V8 builds use the pinned `Main::iteration()` and SceneTree integration; JavaScriptCore reports native lifecycle/checkpoint ABI 0 because it has no certified public bounded job-pump API. The engine realm installs a pre-exit gate for host Stop and project `quit()`. Its cleanup-only loop schedules registered cleanup and flushes only the native deletion queue after callbacks return. A later tick confirms completion before releasing native exit. The managed-shutdown queue integration suppresses business deferred/callable work during final cleanup. Process/physics callbacks and the general deferred business queue do not run during this phase. Existing host deadlines bound uncooperative startup or cleanup and retain forced/unconfirmed results. This native hook requires matching rebuilt engine assets; a descriptor flag or frontend-only refresh cannot supply it. Logical environment seal and physical bridge destruction remain separate observations.

React automatic maintenance is coalesced by session epoch/frame counters and pending-work/scheduler revisions. Each root still receives its own frame callbacks, while the session shares maintenance and work budgets. `processFrame()`/`physicsFrame()` are automatic-driver APIs; explicit `process()`, `physics()`, `pump()` and `flush()` keep manual semantics. Raw native mutations and new same-frame work invalidate reuse. Native observation drives dirty-record validation on matching builds; initial/overflow/unsupported observations still trigger full external-structure audits. Destruction requires an owner checkpoint ticket, which ends before a Promise continuation; nested native callbacks cannot inherit that ticket.

The outer preview protocol remains 1 and the Dedicated Worker protocol remains 2. Pthread runtime packets use the independent `__godotjsRuntime: 2` control format, and exit facts have `schemaVersion: 1`; native Variant routing, audio and presentation ABI versions remain separate. Reader, writer and validators change together for the sealed candidate. Legacy compatibility exits are not evidence of complete new epoch observation.

## TypeScript and declarations

The shared base config contains only common checks. Each package chooses its module format, resolution, target, libraries, ambient types, and output directory. Existing internal configs remain unchanged.

The current TSX foundation emits CommonJS and declarations to `packages/tsx/dist/`. It has no JSX runtime or scene API yet and does not replace the implemented React renderer. Additional entry points and formats should be introduced with their implementations and consumer verification, rather than exposed as empty compatibility promises.

Keep Node tools, browser applications, and Godot user programs in distinct type environments. In particular, do not inherit the internal runtime's Node ambient types into every ecosystem package.

`scripts/typings/godot.generated.d.ts` remains an in-repository compilation placeholder and is not the default Playground's engine API contract. The production Web engine exposes `godot-jsb.internal.get_engine_api()`; the release pipeline captures both snake and camel API IR from the same JS/WASM and worklet bytes, generates declarations, and requires strict declaration and consumer checks before assembly. The descriptor records canonical API, binding/naming, codegen, SDK and declaration identities. The worker uses the naming snapshot selected by the project's GodotJS setting; changing only the runtime naming proxy does not establish type compatibility.

Generated declarations describe native classes/inheritance, builtin constructors, properties, method arguments/defaults/returns, signals, utility functions and native nullability. Dynamic Variant values and opaque engine handles keep explicit dynamic boundaries. These engine snapshots remain separate from project-specific scripts, autoloads, scene types and editor-import outputs. The pure `@godot-js/react-build/resource-uids` subpath shares native UID-cache resolution with the project model without pulling TypeScript or browser runtime dependencies into that model.

## Validation and release boundaries

`tests/project` remains outside the workspace and retains its own lockfile. The existing runtime matrix installs it with `--ignore-workspace`; this preserves its role as an independent consumer.

Native platform workflows run `node modules/GodotJS/scripts/test/prepare-native-engine.mjs --godot-source . --out native-integration.json` before SCons when the requested version is exactly 4.6.1. The dependency-free Node.js 24 producer validates every pinned input before writing any source and emits observer, native lifecycle, early-mount and managed-shutdown-queue receipts. Source mismatch fails the preparation; other engine versions do not acquire these ABI claims. The local Godot build/cache actions in these workflows belong to the upstream engine checkout, while the preparation script belongs to the nested GodotJS module.

Local native source attestations bind included `.inc` implementations, nested SCons files, root headers, code templates and embedded preset inputs, plus final core patch leaves and the build recipe. Generated headers/sources are excluded as derived outputs; validation checks the source and actual binary identity around execution.

Local Linux QJS/V8 builds can run the cleanup, explicit Entry/no-legacy, template/local-resource, NativeInterface, host-operation and early ArtifactSet probes. JavaScriptCore has its ordinary runtime tests. Run browser checkpoint and exit probes against the exact `build-browser-engine.mjs` reports for Dedicated Worker or pthread Worker. [Native and Web probe commands](engine-evolution-implementation.zh-CN.md#本地构建与验证)

The current foundation is verified through embedded-script builds, the ecosystem build and type check, and package-entry checks. Before public package releases, add isolated tarball consumers to verify declarations, exports, dependencies, and supported hosts. Workspace source resolution alone is not publication verification.

The root package version drives the engine version header. Run `pnpm release:version` when preparing a manual release. Private foundations stay outside Changesets release planning.

The P0 blocker assessment uses Schema 2 evidence receipts: the candidate engine hashes, validation batch and frozen producer/source hashes must match fresh nonempty required cases. `blockers-cleared` with `engineeringStart: go` authorizes dependent engineering. It explicitly leaves `defaultReleaseReady: false`; production API/declaration certification, deployment and migration/recovery acceptance are separate release work. Building a full-engine descriptor and passing local browser checks does not by itself establish external deployment or public package publication.

The new Worker route has a separate `worker-g0-receipt` contract and actual-runtime normalizer in `scripts/release/collect-worker-g0.mjs`. It records each scoped blocker, source/build/producer/batch hashes and closed Worker assets. A passed child case can be consumed from a failed parent suite only with its exact parent hash and explicit passed status; it never promotes the suite. Node tests and build evidence remain separately labeled. G0 unlocks scoped integration, G1 accepts the new product, and G2 accepts deployment and whole-version rollback. Default activation remains held. See the [Worker guide](browser-worker-engine.zh-CN.md).

## Browser application

The [Playground](../apps/playground/README.md) compiles user programs, checks target-specific types and builds PCK artifacts without a runtime Node.js service or WebContainers. `full-engine-v1` enables the normal Godot 4.6.1 Web module set, including advanced text, and GodotJS. It does not include the P0 instrumentation module. Capabilities are bounded by the actual compiled Web target and browser platform.

The default product uses the Dedicated Worker runtime introduced on main, with the full threadless Web binary and host/audio/presentation bridges. The historical native execution value `window` identifies that binary recipe; a schema-3 site and `runtimeAbi` select its Dedicated Worker host. The separately selected pthread candidate uses `proxy-pthread`, built with actual `threads=yes proxy_to_pthread=yes dlink_enabled=no`. The engine main loop, business JS and optional React execute in the engine Worker realm. The separate-origin iframe remains the browser host for DOM, input, audio and platform proxies. A user script Worker has an explicit different role. WebGL context ownership is measured; upstream host GL proxying must not be described as Worker-owned OffscreenCanvas rendering.

Run full-engine, editor, bridge failure/value, migration and legacy-demo
checks locally against the built default application.
A start receipt hashes the site before testing, and the final receipt binds those
same bytes to the reports. The older conformance workbench has a separate artifact;
it cannot stand in for the default application's acceptance.

The execution pipeline is:

```text
Project document + engine-matched declarations/runtime bytes
  -> browser or Node environment adapter
  -> project-tools compiler policy/type environment
  -> BuildPlan -> shared preparation/overlay/PCK facade
  -> engine-release.json + matching preview runner
  -> separate-origin preview host
  -> fresh Dedicated Worker (or explicitly selected proxy-pthread candidate)
```

`@godot-js/project-tools` owns native project preparation for Node and browser consumers. The Playground adapter packs its result using the shared PCK writer. It preserves native scene/resource bytes and original project settings; TypeScript/JavaScript scripts are emitted as GodotJS modules with source maps. Native UID caches are retained/merged using the Godot binary format. Formats requiring Godot editor import still require their metadata and imported files; browser compilation does not provide an editor importer. Native modules remain engine externals. Optional React/SDK runtime modules are hash-verified release assets; project-relative modules, `res://` imports and JSON are resolved locally. Generic npm installation remains outside this application path.

Schema 2 supports two project modes:

| Runtime | Contract |
| --- | --- |
| `godot` | Native script or configured main scene, with full compiled GodotJS APIs; default project includes `main.tscn` and its attached script |
| `react` | React component bootstrap in the same engine, using `@godot-js/react/engine` and native constructors from `godot` |

The generic engine renderer supplies `EngineNode`, native refs, property/signal bridging and React ownership/lifecycle. Adding React sugar normally changes JavaScript packages and their release assets. GodotJS ABI changes and native engine fixes still require matching native builds. The older NativePort API remains an independently tested library interface; it is not a Playground runtime mode.

The project-tools Schema 4 reader/writer describes a mutually exclusive scene/script launch over a read-only source snapshot. The new React project action selects an ordinary Schema 4 `start(ctx)` entry; the editor keeps a Schema 4 view and writes the original format. Existing native/component templates and demos remain Schema 3, and legacy reads do not trigger bulk migration. Compatibility readers preserve old React entry semantics even if a document also contains a main scene. BuildPlan and OutputOverlay separate original files from generated bootstrap and outputs.

Internal source and overlay storage owns `Uint8Array` bytes, with copied public reads and trusted package-internal borrowing. `ProjectWorkspace` pins immutable revisions and captures changed/removed source deltas; stale builds cannot publish over the current revision. Reusable language services retain unchanged script snapshots. Bounded LRU emit/pack caches and owned-byte hash caches avoid repeated work without changing build identity. Resource execution caches verify producer, target, dependency and output identities before reuse; browser IndexedDB and Node directory adapters share that contract.

PCK layout/budgets are checked before final allocation, and directory MD5 covers each exact byte view rather than unrelated backing-buffer bytes. The ordinary PCK reader validates actual directories, ranges and entry digests. `ArtifactSet` is a separate versioned input containing a bootstrap PCK, content-addressed resource PCKs and a union index. External admission captures and verifies the complete closure, rejects overlap/case collisions and resource packs containing global metadata, and mounts resources in `Main::setup()` before UID, autoload and main-scene resolution. A staged manifest alone is not native mount evidence. Single-PCK callers remain supported.

The default PNG/JPEG producers write Godot 4.6.1 CTEX v1 and load as `CompressedTexture2D`; the PCM WAV producer writes binary `AudioStreamWAV` resource v6. PNG retains validated compressed PNG data. JPEG uses the same pinned `jpeg-js` software decode and fixed `fflate` PNG compression in Node and browser consumers, rather than canvas-dependent default pixels. Producer/output format identities are recorded in receipts. Explicit legacy `image-rgba`/Base64 text recipes preserve `ImageTexture` compatibility. Source bytes and UID/remap remain available; decoded/output/PCK budgets and editor input limits still apply. These producers use existing Godot resource loaders and do not replace the editor importer or certify editor reimport/export.

The implementation/API and command-level validation scopes are documented in [Engine evolution implementation](engine-evolution-implementation.zh-CN.md).

The editor model keeps entry, selection, files, controls and runtime mode. It accepts native JS/TS entries or a main scene, and preserves arbitrary native files within the existing 64-file, 8 MB decoded and 1 MB binary-file limits. `mainSceneSource: project` marks a value derived from the latest `project.godot`; it is for UI/validation and never overrides that file's authoritative main-scene UID. Explicit overrides are separately marked. Scene headers, sidecars and existing UID caches resolve scene paths without rewriting original configuration.

Schema 1 and documents naming the removed renderer are imported as React projects with their complete original document retained in migration history. Built-in demo documents are upgraded to the native React examples; their old source and attachments remain available through the original export. Arbitrary old source is preserved for manual migration instead of executing the removed renderer. IndexedDB writes retain per-project conflict detection, atomic recovery backups and versioned restore. The separate blob-storage namespace stores file bytes by content hash; projects and recovery records reference them internally. Legacy databases are copied with a migration journal and remain readable for late writers. Cross-tab/build/export pins protect live blobs during collection, and recovery export produces self-contained bytes rather than persistent database references.

For deployment, serve the same complete release at distinct editor and preview origins and set the editor's `preview-config.json` to `{"previewOrigin":"https://preview.example.com"}`. The URL query `previewOrigin` can override it for checks. Localhost automatically pairs `localhost` and `127.0.0.1`; outside local development, missing or same-origin configuration is rejected. The preview site serves the fixed `preview.html`, matching engine/worklets and relative release assets, with WASM MIME/CORS and frame/CSP policy suitable for the chosen pair. It must not share editor credentials or private application data.

The native/React iframe retains its own origin with `allow-scripts allow-same-origin allow-pointer-lock`; a parent/source/origin/protocol/run-identity handshake transfers a private MessagePort. `PreviewRunner` tracks run/revision identities and delegates runtime ownership to `BrowserEngineSession`. A session tracks the engine and script Worker pool, runtime progress, timers, ports, audio, Blob URLs and Canvas. Stop distinguishes cooperative exit from timeout/forced cleanup; removing an iframe alone is not proof of native/GPU collection.

The old `window` deployment does not require COOP/COEP. `proxy-pthread` requires actual trusted HTTPS, SAB and cross-origin isolation in the editor, preview and engine Worker. Its top/preview headers, Permissions-Policy delegation, iframe allow policy, CSP and cross-origin asset responses form a deployment contract, tested with `serveIsolatedBrowserPair`. Runtime reports retain actual origins/headers/isolation and browser environment. Production deployment and physical Safari/XR/IME acceptance remain separate from local fixtures.

The verified loader also runs a fixed 126-byte Wasm shared-memory-growth capability probe before any pthread engine fetch. Retained main/Worker instances must agree after growth and perform reads, copies and fills in the grown region. This is a real capability check, with bounded cleanup on all outcomes, rather than a UA blacklist. Linux WebKit 26 currently fails this standard behavior (WK-01); passing the startup-rejection test does not certify engine execution. The formal native template is unchanged: diagnostic lowering and reduced-memory/capability workarounds are not shipped. Default Worker activation stays held until the browser blocker and required G1/G2 acceptance are resolved; see the [Worker guide](browser-worker-engine.zh-CN.md).

`pnpm build:playground` assembles the default application (`apps/playground/src`, `web`, and `scripts`) and `engine-release.json`, plus a verified native demo resource pack and the small demo service module. There is no alternative legacy build or runner. `build:frontend` can refresh an existing full-engine shell only if its declaration inputs still match the release hashes. The original browser SDK workbench remains a conformance fixture, built separately by `pnpm --filter @godot-js/playground build:conformance` into `dist-conformance/`; it is not the default application. Browser assets and engine release files remain outside the embedded-script build boundary. See the [Playground guide](../apps/playground/README.md) for current operation; the [browser SDK guide](browser-playground.zh-CN.md) describes the retained conformance/library workflows. None of these build paths claims an externally published deployment.
