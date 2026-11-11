# Repository architecture

GodotJS combines a native Godot module with embedded JavaScript support code and reusable ecosystem packages in one pnpm workspace. Native module directories and embedded-script output paths stay in their existing locations to preserve SCons, CI, and upstream integration.

## Layout and responsibilities

| Location | Responsibility |
| --- | --- |
| `bridge/` | Native bindings, module resolution, and the JavaScript environment |
| `weaver/`, `weaver-editor/` | Godot script-language and editor integration |
| `internal/`, `compat/` | Native support code and engine compatibility |
| `impl/` | V8, QuickJS, JavaScriptCore, and browser backends |
| `scripts/jsb.runtime/` | Private runtime support embedded in the engine |
| `scripts/jsb.editor/` | Private editor support and type generation |
| `impl/web/bridge/` | Private TypeScript bridge compiled into Emscripten glue |
| `scripts/jsb.react/`, `scripts/jsb.react-build/` | Existing React renderer and scene toolchain; retained in their current locations |
| `packages/` | Reusable libraries with their own build and package entry points |
| `apps/playground/` | Static Monaco workbench, native/React project compiler worker, separate-origin preview and native React demos |
| `scripts/jsb.react-browser/` | Browser compiler core, fixed built-ins, verified asset loading and isolated runner |
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

SCons invokes `build:engine-js` before generating embedded sources when `skip_js_runtime` is disabled. It checks for pnpm and the embedded packages' local TypeScript installations and reports the explicit preparation command when dependencies are missing. It does not invoke `pnpm install` or the aggregate build.

The embedded output contracts remain:

```text
scripts/out/jsb.runtime.bundle.*
scripts/out/jsb.editor.bundle.*
impl/web/js/jsbb.impl.js
impl/web/js/library_godotjs_jsbi.js
```

The runtime and editor bundles retain AMD output. SCons embeds them into generated native source; the browser bridge is supplied to Emscripten as pre-JS and a JS library. Changes to these internal sources still require rebuilding the corresponding engine artifacts.

`skip_js_runtime=yes` continues to consume previously built or downloaded files. The CI environment job builds only the embedded-script packages and uploads the same directories before native engine compilation; runtime-matrix setup also builds only these scripts. A separate ecosystem job builds reusable packages, checks new package types, and runs the existing React tests in parallel. The final `builds-done` gate requires both the runtime matrix and ecosystem checks, so package failures block the final checks and releases without blocking engine artifact production or native build execution.

There is no engine-only dependency installation profile at present. A full explicit workspace install prepares all active packages. If applications later add substantial dependencies, validate a dedicated preparation profile before promising filtered installation; a filtered build alone does not isolate installation.

## Package and dependency boundaries

Keep the embedded-script packages private. Their package names identify workspace build units, not separately installable engine runtimes.

New reusable libraries belong in `packages/`, and applications consume those libraries. The existing `@godot-js/react`, `@godot-js/react-build`, and browser-specific `@godot-js/react-browser` packages stay under `scripts/` and are explicitly included in the ecosystem build. Libraries do not depend on application code. Declare package dependencies with `workspace:*` and use package entry points rather than imports into another package's source directory.

GodotJS provides modules such as `godot`, `godot-jsb`, `godot.lib.api`, and `godot.annotations` inside the engine. Future ecosystem code must use the intended host API and preserve required host modules as external references when bundling. It must not install the private embedded packages as substitute runtimes.

Do not create empty renderer, reactivity, compiler, resolver, or type packages solely to reserve names. Extract an additional package when it has a concrete responsibility and consumer. See [package conventions](../packages/README.md).

## TypeScript and declarations

The shared base config contains only common checks. Each package chooses its module format, resolution, target, libraries, ambient types, and output directory. Existing internal configs remain unchanged.

The current TSX foundation emits CommonJS and declarations to `packages/tsx/dist/`. It has no JSX runtime or scene API yet and does not replace the implemented React renderer. Additional entry points and formats should be introduced with their implementations and consumer verification, rather than exposed as empty compatibility promises.

Keep Node tools, browser applications, and Godot user programs in distinct type environments. In particular, do not inherit the internal runtime's Node ambient types into every ecosystem package.

`scripts/typings/godot.generated.d.ts` remains an in-repository compilation placeholder and is not the default Playground's engine API contract. The production Web engine exposes `godot-jsb.internal.get_engine_api()`; the release pipeline captures both snake and camel API IR from the same JS/WASM and worklet bytes, generates declarations, and requires strict declaration and consumer checks before assembly. The descriptor records canonical API, binding/naming, codegen, SDK and declaration identities. The worker uses the naming snapshot selected by the project's GodotJS setting; changing only the runtime naming proxy does not establish type compatibility.

Generated declarations describe native classes/inheritance, builtin constructors, properties, method arguments/defaults/returns, signals, utility functions and native nullability. Dynamic Variant values and opaque engine handles keep explicit dynamic boundaries. These engine snapshots remain separate from project-specific scripts, autoloads, scene types and editor-import outputs. The pure `@godot-js/react-build/resource-uids` subpath shares native UID-cache resolution with the project model without pulling TypeScript or browser runtime dependencies into that model.

## Validation and release boundaries

`tests/project` remains outside the workspace and retains its own lockfile. The existing runtime matrix installs it with `--ignore-workspace`; this preserves its role as an independent consumer.

The current foundation is verified through embedded-script builds, the ecosystem build and type check, and package-entry checks. Before public package releases, add isolated tarball consumers to verify declarations, exports, dependencies, and supported hosts. Workspace source resolution alone is not publication verification.

The root package version continues to drive the existing engine version header and GitHub release flow. Private foundations are excluded from Changesets release planning. Public ecosystem packages will need independent semver and npm publication checks when enabled; do not repurpose the engine release predicate for them.

The P0 blocker assessment uses Schema 2 evidence receipts: the candidate engine hashes, validation batch and frozen producer/source hashes must match fresh nonempty required cases. `blockers-cleared` with `engineeringStart: go` authorizes dependent engineering. It explicitly leaves `defaultReleaseReady: false`; production API/declaration certification, deployment and migration/recovery acceptance are separate release work. Building a full-engine descriptor and passing local browser checks does not by itself establish external deployment or public package publication.

## Browser application

The [Playground](../apps/playground/README.md) compiles user programs, checks target-specific types, builds PCK artifacts and runs a single-threaded Godot Web engine without a runtime Node.js service or WebContainers. The default `full-engine-v1` build enables the normal Godot 4.6.1 Web module set, GodotJS and fallback text. It does not include the P0 instrumentation module. Full-engine capability is bounded by the compiled Web target, including WebGL 2 and single-thread restrictions, rather than a React host whitelist.

The product CI builds this default application and runs its full-engine, editor,
bridge failure/value, migration and legacy-demo acceptance against one directory.
A start receipt hashes the site before testing, and the final receipt binds those
same bytes to the reports. The older conformance workbench has a separate artifact;
it cannot stand in for the default application's acceptance.

The execution pipeline is:

```text
Schema 2 project + engine-matched declaration snapshot
  -> compiler.worker.ts (diagnostics, module resolution, JS/source maps)
  -> @godot-js/react-build/core (shared native project preparation)
  -> @godot-js/react-browser/pck (project PCK)
  -> engine-release.json + PreviewRunner (verified engine/worklets)
  -> separate-origin preview.html (fresh Godot instance)
```

`@godot-js/react-build/core` owns native project preparation for Node and browser consumers. The Playground adapter packs its result using the existing PCK writer. It preserves native scene/resource bytes and original project settings; TypeScript/JavaScript scripts are emitted as GodotJS modules with source maps. Native UID caches are retained/merged using the Godot binary format. Formats requiring Godot editor import still require their metadata and imported files; browser compilation does not provide an editor importer. Native modules remain engine externals. Fixed React/SDK runtime modules are hash-verified release assets; project-relative modules, `res://` imports and JSON are resolved locally. Generic npm installation remains outside this application path.

Schema 2 supports two project modes:

| Runtime | Contract |
| --- | --- |
| `godot` | Native script or configured main scene, with full compiled GodotJS APIs; default project includes `main.tscn` and its attached script |
| `react` | React component bootstrap in the same engine, using `@godot-js/react/engine` and native constructors from `godot` |

The generic engine renderer supplies `EngineNode`, native refs, property/signal bridging and React ownership/lifecycle. Adding React sugar normally changes JavaScript packages and their release assets. GodotJS ABI changes and native engine fixes still require matching native builds. The older NativePort API remains an independently tested library interface; it is not a Playground runtime mode.

The editor model keeps entry, selection, files, controls and runtime mode. It accepts native JS/TS entries or a main scene, and preserves arbitrary native files within the existing 64-file, 8 MB decoded and 1 MB binary-file limits. `mainSceneSource: project` marks a value derived from the latest `project.godot`; it is for UI/validation and never overrides that file's authoritative main-scene UID. Explicit overrides are separately marked. Scene headers, sidecars and existing UID caches resolve scene paths without rewriting original configuration.

Schema 1 and documents naming the removed renderer are imported as React projects with their complete original document retained in migration history. Built-in demo documents are upgraded to the native React examples; their old source and attachments remain available through the original export. Arbitrary old source is preserved for manual migration instead of executing the removed renderer. IndexedDB writes retain per-project conflict detection, atomic recovery backups and versioned restore.

For deployment, serve the same complete release at distinct editor and preview origins and set the editor's `preview-config.json` to `{"previewOrigin":"https://preview.example.com"}`. The URL query `previewOrigin` can override it for checks. Localhost automatically pairs `localhost` and `127.0.0.1`; outside local development, missing or same-origin configuration is rejected. The preview site serves the fixed `preview.html`, matching engine/worklets and relative release assets, with WASM MIME/CORS and frame/CSP policy suitable for the chosen pair. It must not share editor credentials or private application data.

The native/React iframe retains its own origin with `allow-scripts allow-same-origin allow-pointer-lock`; a parent/source/origin/protocol/run-identity handshake transfers a private MessagePort. `PreviewRunner` tracks run/revision identities, startup deadlines, quit/cancellation and forced frame disposal; stale sessions cannot become active. Frame disposal is not proof of process isolation or immediate native/GPU collection. The single-thread deployment does not require COOP/COEP.

`pnpm build:playground` assembles the default application (`apps/playground/src`, `web`, and `scripts`) and `engine-release.json`, plus a verified native demo resource pack and the small demo service module. There is no alternative legacy build or runner. `build:frontend` can refresh an existing full-engine shell only if its declaration inputs still match the release hashes. The original browser SDK workbench remains a conformance fixture, built separately by `pnpm --filter @godot-js/playground build:conformance` into `dist-conformance/`; it is not the default application. Browser assets and engine release files remain outside the embedded-script build boundary. See the [Playground guide](../apps/playground/README.md) for current operation; the [browser SDK guide](browser-playground.zh-CN.md) describes the retained conformance/library workflows. None of these build paths claims an externally published deployment.
