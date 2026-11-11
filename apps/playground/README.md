# GodotJS browser playground

A static Monaco workbench, TypeScript compiler worker and real single-thread GodotJS Web runner. Godot 4.6.1's normal Web module set supplies engine capabilities. React supplies scene composition through the generic native renderer.

## Project modes

| Runtime | Entry and execution |
| --- | --- |
| `godot` | A native script or existing main scene, packed into a project PCK. |
| `react` | A React component rendered into native Godot Nodes using `EngineNode`. |

There is no legacy React runtime mode, opaque-origin showcase runner, alternative legacy build or per-demo NativePort. Every Run starts a fresh Godot preview on a separate origin.

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

The build exports the pinned upstream resources once, then produces `demo-resources.pck`, `demo-runtime.js`, `demo-api.d.ts` and their hash descriptors in `demo-release.json`. Helper declarations are excluded from the engine type snapshots: changing the helper API can refresh the shell and demo assets without changing the engine release or recapturing its API. The compiler verifies these assets when a project imports `@playground/api`. Resource data is mounted without the old showcase scripts or renderer. Exported example projects in `dist/examples` are the eight Schema 2 React projects. Historical capability probes now live under `tests/react/showcase/projects` with their own test service fixture. They are not published as runnable Playground examples.

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
GODOT_WEB_TEMPLATE=/absolute/path/full-engine.zip \
pnpm --filter @godot-js/playground build
pnpm --filter @godot-js/playground dev
```

For an already prepared resource tree, `node apps/playground/scripts/build.mjs --skip-assets` reuses the imported sources. `build:frontend` refreshes an existing release's shell and demo runtime without rebuilding the engine, provided its declaration inputs still match.

The release captures snake and camel declarations from the actual exported Web engine. Types, SDK modules, engine JavaScript/WASM and audio worklets are bound to that release. Local and CI engine builders share the checked patch set for GLES3 Alpha Hash, small CanvasGroup backbuffers, private native tooltips, optional PWA discovery and audio shutdown.

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

Full engine capability is bounded by the Web target: browser restrictions, WebGL 2 and single-thread operation still apply. Editor-imported resource formats require their import metadata and generated cache; the browser does not run the Godot editor importer. General npm installation, complex dynamic-import expressions and local `require` interactions remain outside this framework pass.

## Upstream attribution

The eight demos retain pinned Godot, Kenney, Jummit and BSP algorithm/resource inputs. Checksums, licenses and sources are recorded in `third-party/sources.json`; the in-app Credits dialog and exported license files remain available. The sky-islands character uses the existing static model pose, and the dungeon renders rectangles rather than TileMapLayer terrain painting.
