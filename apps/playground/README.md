# GodotJS browser playground

A static Monaco workbench with a TypeScript compiler Worker and an ordinary Dedicated Worker running Godot, GodotJS and React together. Godot 4.6.1's normal Web module set supplies engine capabilities. The main thread provides DOM/input, presentation and AudioContext/AudioWorklet hosts; transport uses transferable ArrayBuffers without SharedArrayBuffer or cross-origin isolation.

Ordinary build/dev commands and demos use Worker execution; the legacy entry has been removed. This framework is in its initial construction phase and will continue to undergo broad refactoring. Follow the [framework development and review principles](../../CONTRIBUTING.md#framework-development-stage-and-reviews): prioritize working core flows, clear module responsibilities and efficient iteration. The [Worker runtime and delivery contract](../../docs/browser-worker-runtime.zh-CN.md) describes runtime behavior and later release validation.

## Engine profiles

The default `full-engine-v1` builds all eight demos. `engine-2d-v1` uses the same native GodotJS/React runtime with 3D scenes, physics, navigation and XR disabled, and publishes Shader, Lights, Match3 and Dungeon. SDK inputs are built once; engine, resource, export and output directories are isolated per profile and target. New project documents use Schema 3 and carry their engine profile.

New 2D Web builds also omit ENet (native UDP is unavailable in the browser), UPnP (no browser implementation), the optional ObjectDB snapshot profiler and advanced text layout. They use `TextServerFallback`, retaining FreeType/MSDF fonts, GUI, 2D physics/navigation, audio, GDScript, texture formats and WebSocket/WebRTC multiplayer. Full builds retain advanced text. Fallback supports basic horizontal text; complex shaping, BiDi and advanced line/word breaking are outside this 2D template's text capabilities. Historical source-bound 2D archives with advanced text remain readable; fresh builds verify omitted modules are absent. Changed build arguments select a new artifact namespace, so rebuild the engine before using the default 2D product command.

For a historical standalone native text diagnostic, `node apps/playground/scripts/browser-basic-text-test.mjs --site apps/playground/dist-2d-debug --out work/basic-text-results --expect-fallback` verifies the actual primary text interface, CJK font coverage and pixels, rich text, mixed wrapping, and native LineEdit/TextEdit composition, selection and carets in snake/camel bindings. This diagnostic does not certify Worker execution. Worker candidates use the real Worker branch of `test:browser:2d:features` and the schema-3 acceptance matrix. The fixed subset test font is not a production Chinese font.

See [the 2D build and acceptance guide](../../docs/browser-2d-engine.zh-CN.md) for actual CLI commands, source/resource provenance, independent Gate 1, project/storage compatibility, size measurements, HTTP delivery and candidate verification.

## Project modes

| Runtime | Entry and execution |
| --- | --- |
| `godot` | A native script or existing main scene, packed into a project PCK. |
| `react` | A React component rendered into native Godot Nodes using `EngineNode`. |

All native scripts and scene React demos run together with Godot in an ordinary Worker. Every Run starts a fresh Worker in a separate-origin preview. Presentation defaults to `direct`; `bitmap` requires an explicit request. The legacy execution entry has been removed; `?executionBackend=legacy` and `--legacy-execution` fail explicitly.

## Eight native React demos

| Demo | Behavior preserved by the migration |
| --- | --- |
| Shader laboratory | Three real ShaderMaterials, pointer input and independent uniforms. |
| Light room | Three native lights, shadows and draggable occluders. |
| Kenney sky islands | CharacterBody3D movement, double jump, six coins and collapsing platforms. |
| City builder | Six model types, placement, rotation, demolition, undo/redo and JSON import/export. |
| Destruction lab | Native RigidBody3D shards, convex collision, impulses and reset. |
| Mini racing | Physics sphere, native ray queries, animated wheels, steering and lap checkpoints. |
| Match-3 | Deterministic boards, swap rollback, cascades, refill, hints and shuffle. |
| BSP dungeon | Seeded partitioning, connected corridors and incremental generation. |

Sources live in `src/demos`. They use `godot` constructors and methods, `EngineNode` and small constructor-independent React helpers from `@playground/api`. The `Native` helper applies initial uncontrolled values; it forwards controlled `native` properties and refs to `EngineNode`. Frame hooks receive real native objects and have no command or capability whitelist.

`withDemo` supplies input, live controls, model metadata, sounds, statistics and JSON export. Its input Node is an ordinary GodotJS script. UI commands and telemetry cross the existing preview MessagePort with run identity and bounded plain JSON. The input Node clears transient events after the bootstrap finishes each process/physics dispatch, including subscribers mounted later. The editor replays current controls when a new session starts, so edits during compilation or download are retained. Hooks, Nodes, callbacks, resources and the preview are disposed with the session.

The build exports the pinned upstream resources once, then produces `demo-resources.pck`, `demo-runtime.js`, `demo-api.d.ts` and their hash descriptors in `demo-release.json`. Helper declarations are excluded from the engine type snapshots: changing the helper API can refresh the shell and demo assets without changing the engine release or recapturing its API. The compiler verifies these assets when a project imports `@playground/api`. Resource data is mounted without the old showcase scripts or renderer. Exported example projects in the selected output's `examples` directory are the selected profile’s Schema 3 React projects. Historical capability probes now live under `tests/react/showcase/projects` with their own test service fixture. They are not published as runnable Playground examples.

## Editing and project data

The workbench retains its explorer, tabs, Monaco diagnostics, split panes, console, mobile layout, project controls, share URLs and JSON import/export. Project files preserve native scenes, resources, arbitrary binary attachments, UID mappings and project settings. Relative paths, root paths, `res://` imports and JSON resolve through the shared compiler module index. Helpers can use `.mjs`, `.mts`, `.cjs` and `.cts`; entries accept TS, JS, TSX and JSX.

Native projects follow Godot's last-assignment rule for project settings. React replaces the launch scene with its generated bootstrap while preserving the rest of the project configuration.

Old documents retain their exact original source and attachments in migration history. Built-in demo saves from the removed renderer open the migrated React demo; the original document remains available through **Export original project**. Arbitrary old source is preserved for manual adaptation. No old renderer is selected or executed. Autosave, recovery backups and per-project tab conflict checks remain active.

During framework development, rename supports ordinary scripts and text `.tscn` scenes while preserving extensions. Resource and declaration-file renames are disabled. Unsupported references and binary native resource graphs cause rejection before any project files change.

## Build and run

Install dependencies with the repository's Node/pnpm versions:

```sh
pnpm install --frozen-lockfile
pnpm build:engine-js
pnpm build:packages
```

The full build needs a GodotJS 4.6.1 editor built from this checkout and a matching full-module, single-thread Web template. Resource preparation also needs a Godot 4.6 importer with glTF support. Set `GODOT`, `GODOT_IMPORTER` and `GODOT_WEB_TEMPLATE` as appropriate.

```sh
GODOT_SOURCE=/path/to/godot-4.6.1 bash apps/playground/scripts/build-web-engine.sh
GODOT=/path/to/godotjs-editor \
GODOT_IMPORTER=/path/to/godot-editor \
pnpm --filter @godot-js/playground build
pnpm --filter @godot-js/playground dev
```

For an already prepared resource tree, `node apps/playground/scripts/build.mjs --skip-assets` reuses the imported sources. `build:frontend` refreshes an existing release's shell and demo runtime without rebuilding the engine, provided its declaration inputs and frozen SDK source/output proof still match. SDK drift is rejected before any site files or delivery variants are changed; rebuild the complete release to consume a new SDK.

Ordinary build/dev/test commands use Worker in `dist`, `dist-2d-debug`, `dist-2d-release` and `dist-full-release`. The `:worker` npm commands and `--worker-execution` remain aliases for the same path; no `-worker` output suffix is added. Explicit `--out`, `PLAYGROUND_DIRECTORY` and `PLAYGROUND_TEST_DIRECTORY` override locations. Frontend refresh requires an existing Worker release; rebuild an old legacy site with the ordinary build command. Shell-only test fixtures use `dist-shell`; SDK conformance retains `dist-conformance`.

The default product build reads the matching engine report produced by the Web wrapper. Artifact and build paths include profile, target, module mode, LTO and a configuration hash. Each successful engine build is retained in an immutable report-hash directory; the current report points to that archive. Use `--engine-report` for another certified build, or keep `engine-report.json` beside an explicit `GODOT_WEB_TEMPLATE`. Missing or invalid source evidence fails before resource export. An uncertified local template requires `--development` and cannot receive a site acceptance seal.

Explicit and adjacent reports both supply unspecified profile, target, LTO and module-mode defaults. Explicit CLI/environment choices remain constraints and must match the report. Published current reports can be repackaged after the original build tree is removed: compiler logs are located beside the report or its referenced immutable ZIP and verified against the recorded hash. Publication rejects output paths overlapping source reports, ZIPs, logs or immutable artifact files before creating any output.

CI includes a portable `browser-engine-artifact/` containing the exact ZIP, the original report, a portable report, compiler log and integrity manifest. After downloading it, run `node scripts/test/package-browser-engine-artifact.mjs --out /path/to/browser-engine-artifact --verify`, then `node scripts/test/measure-browser-engine.mjs --report /path/to/browser-engine-artifact/engine-report.json --out /path/to/measurement.json`. No original build-machine paths are needed.

CI defaults to both profiles and both native debug/release targets. Each exact candidate runs both Worker presenters without forced software GL or autoplay overrides. Optional performance can download one frozen historical site per profile/target from `performance_baseline_run_id`, measure its legacy entry with the current tool, then enforce fixed direct/bitmap regression budgets. The actual Native/SDK assets, API declarations, resource packs and executable demo inputs must match, along with target, browser, tool and hardware. Commit/report metadata may differ; each site keeps its real release and candidate identity. Baseline reports without the versioned material receipt must be measured again with the current tool. Without that input, only Worker measurements run and regression acceptance remains not-evaluated. A separate four-target rollout summary rechecks immutable evidence and stays blocked when capability probes, performance, browser support or targets are missing; it never publishes automatically. Selecting a single target in workflow dispatch is diagnostic and cannot satisfy the four-target rollout gate.

The release captures snake and camel declarations from the actual exported Web engine. Types, SDK modules, engine JavaScript/WASM and audio worklets are bound to that release. Local and CI engine builders share the checked native patch pipeline, including the established renderer/audio/presentation fixes and the versioned Worker startup, host, audio and browser bridges. Build and acceptance consume the same native patch-file registry. Worker releases require its complete built-source proof and a fresh frozen SDK; old templates cannot acquire the ABI by adding metadata.

The WebKit patch parks the default framebuffer between engine loops and restores Godot's separate READ/DRAW bindings before the next loop. It changes the JavaScript config wrapper; each rebuild still checks the actual WASM identity. Public JavaScriptBridge callbacks remain available: real asynchronous viewport readback, ImageTexture creation and Sprite updates have been checked with resulting pixels. Host code that directly mixes raw WebGL rendering must respect ownership of the engine context. Feature acceptance rejects actual browser console errors, including WebGL validation errors; successful native assertions alone are insufficient. Reports from an earlier wrapper or candidate cannot certify a rebuilt release, even when its WASM bytes are unchanged.

## Preview deployment

Serve the editor and preview from distinct HTTP(S) origins. Set `previewOrigin` in `web/preview-config.json`, or pass `?previewOrigin=https://preview.example.com`. Localhost development can use the localhost/127.0.0.1 alias pair. The single-thread build does not require COOP/COEP.

Each preview verifies its engine and worklet bytes, receives the compiled project over a private MessagePort and starts a fresh Godot instance. Startup, cancellation, stop, failure and telemetry are scoped to the current run. Source maps carry native React failures back to the editor.

## Validation

```sh
pnpm --filter @godot-js/playground typecheck
pnpm --filter @godot-js/playground test
pnpm --filter @godot-js/playground test:browser:react
pnpm --filter @godot-js/playground test:browser:projects
pnpm --filter @godot-js/playground test:browser
```

Browser suites cover control edits during startup, input for dynamically mounted components, native scripts importing demo helpers, the actual compiler, native and React startup, all eight demo interactions, controls and JSON export, persistence/migration, workbench layout and fresh-session stop/rerun. The older browser SDK conformance workbench remains an independent library fixture (`build:conformance`), rather than a selectable Playground runtime.

For the sealed Worker matrix, prepare delivery variants before starting the immutable batch:

```sh
pnpm --filter @godot-js/playground build:worker
node apps/playground/scripts/prepare-site-delivery.mjs apps/playground/dist
pnpm --filter @godot-js/playground test:browser:matrix --site dist --out ../../work/playground/worker-acceptance
```

The matrix records both explicit presenters and continues through unavailable browsers, then runs dedicated capability probes for usable runtime scopes and writes `worker-capabilities.json` for every batch. Failed prerequisites and capabilities without a dedicated producer remain explicit blocked cases across all 24 browser/presenter/SDK/naming combinations. It then reports all failures. Schema-3 receipts distinguish the acceptance batch from real run/document/Worker/config identities and cannot reuse schema-2 evidence. Performance regression budgets are generated before Worker measurement from an independently frozen legacy site with the same engine/SDK release; the fixed rules and capability rollout gate are documented in the Worker contract.

Full engine capability is bounded by the Web target: browser restrictions, WebGL 2 and single-thread operation still apply. Editor-imported resource formats require their import metadata and generated cache; the browser does not run the Godot editor importer. General npm installation, complex dynamic-import expressions and local `require` interactions remain outside this framework pass.

## Upstream attribution

The eight demos retain pinned Godot, Kenney, Jummit and BSP algorithm/resource inputs. Checksums, licenses and sources are recorded in `third-party/sources.json`; the in-app Credits dialog and exported license files remain available. The sky-islands character uses the existing static model pose, and the dungeon renders rectangles rather than TileMapLayer terrain painting.
