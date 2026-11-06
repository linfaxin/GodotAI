# GodotJS browser playground

A static browser application with a TSX editor, a TypeScript compiler worker and a real, single-thread GodotJS Web runner. Switching examples shuts down the previous React Root before creating another.

The IDE layout is restored from `ff8da42`: the original 42 px top bar, file explorer, Monaco editor with tabs, adjustable editor/preview split, Problems/Console dock and 24 px status bar. `web/style.css` retains the original workbench stylesheet; `web/workbench-additions.css` contains only the demo picker and demo-specific controls. The top example menu keeps the expanded card picker for all eight demos.

| Demo | Interaction | Source |
| --- | --- | --- |
| Shader laboratory | Three independent canvas shaders; intensity, speed, palette and mouse interaction | `src/demos/ShaderLab.tsx` |
| Light room | Move a light, drag occluders, adjust energy and toggle shadows | `src/demos/LightRoom.tsx` |
| Kenney sky islands | WASD, Space for double jump, R to respawn; six coins and falling platforms | `src/demos/SkyIslands.tsx` |
| City builder | Place and rotate six building types, pan/orbit, demolish, undo/redo, import/export JSON | `src/demos/CityBuilder.tsx` |
| Destruction lab | Click individual cubes or explode all; 24 convex rigid-body shards, impulses, gravity and reset | `src/demos/DestructionLab.tsx` |
| Mini racing | WASD/arrows, Space brake, R reset; sphere-based physics, ground ray, animated wheels and lap checkpoints | `src/demos/Racing.tsx` |
| Match-3 | Drag adjacent tiles, invalid-swap rollback, cascades, refill, hints and seeded boards | `src/demos/Match3.tsx` |
| BSP dungeon | Seeded partitioning, connected rooms/corridors and progressive generation | `src/demos/Dungeon.tsx` |

Scene trees and behavior are authored in React/TypeScript. Upstream PackedScenes are not instantiated at runtime. Models become static meshes offline; the car retains separate body/wheel meshes, and pre-fractured pieces receive baked convex collision shapes. Frame hooks implement gameplay and procedural animation. The platformer uses a static character pose rather than upstream skeletal animation; BSP uses rectangles instead of TileMapLayer terrain painting.

## Build and run

Use the repository's Node and pnpm versions and run `pnpm install --frozen-lockfile`.

The build requires:

- `GODOT`: a GodotJS **4.6.1 editor built from this checkout**, with regex, GDScript, SVG, fallback text, Ogg/Vorbis and Godot Physics 3D enabled.
- `GODOT_IMPORTER`: a normal Godot 4.6 editor with glTF support; defaults to `godot`. It converts the pinned GLB assets with `scripts/extract-assets.gd`.
- `GODOT_WEB_TEMPLATE`: an absolute path to the matching single-thread `template_debug` ZIP with this checkout's browser backend, physics, Ogg/Vorbis, regex, SVG and text modules.

To build the Web template, activate Emscripten **4.0.11**, install SCons, and place this checkout at `GODOT_SOURCE/modules/GodotJS`:

```sh
GODOT_SOURCE=/path/to/godot-4.6.1 bash apps/playground/scripts/build-web-engine.sh

GODOT=/path/to/godotjs-editor \
GODOT_IMPORTER=/path/to/godot-editor \
GODOT_WEB_TEMPLATE=/path/to/godot.web.template_debug.wasm32.nothreads.zip \
pnpm build:playground

pnpm dev:playground
```

Open `http://localhost:4173`; `PORT` changes the development port. Build output is `apps/playground/dist`. Engine artifacts and Godot import caches are ignored. After the initial build, skip unchanged model conversion with `pnpm --filter @godot-js/playground build --skip-assets`.

Use **切换项目 (当前：…)** in the top bar to open the demo picker; the label follows the selected project and restored session. Escape or an outside click closes it, and arrow keys plus Enter select a project. The explorer supports file search, creation, rename, delete and binary attachments. Monaco provides syntax highlighting, completion, hover types and diagnostics with source navigation. Local TypeScript/JavaScript modules (including directory index.js/index.jsx files) and JSON imports compile together in the worker; its declarations come from the same SDK build.

Projects and per-demo edits save locally in IndexedDB. Writes merge only changed projects inside a transaction, so separate tabs editing different demos preserve each other. Concurrent edits to the same project show a conflict and retain the local buffer for export; oversized projects retain their last valid autosave without blocking other projects. The project menu imports/exports project JSON, restores the current example and hides the explorer. Share copies a compressed project link; larger projects should use JSON export. Imports validate file paths, the TSX entry and file contents before replacing the active project. Projects permit up to 64 files / 8 MB of decoded contents; binary attachments permit 1 MB per file. JSON documents may be up to 128 MB to accommodate the legacy pretty-printed byte arrays. The same decoded content limits apply after import and bounded share decompression. Attachments can be inspected and exported; creating arbitrary runtime resources remains outside this profile.

`package.json` is retained as project metadata for compilation and export, and hidden from the explorer, search, tabs and visible file count. Saved selections of that file return to the project entry. Ctrl/Cmd+S and Save As variants are suppressed in the workbench, Monaco and sandboxed preview; automatic saving remains enabled.

Ctrl/Cmd+Enter checks and runs the project. Ctrl/Cmd+B toggles the explorer; splitters support dragging, arrow keys and Home. The bottom dock supports Problems/Console tabs, output filters, copying, automatic scrolling and collapse. Focus Preview expands the scene; Escape returns to editing. Mobile uses the original file drawer and stacked editor/preview panes.

The left **运行设置** section contains the fixed `showcase-v1` profile, functional Production/Development modes, demo parameters and actions. Parameter changes update the running scene without recompilation. Stop disposes the Root.

City maps use `{version:1,cells:[{x,z,type,rotation}]}`. Imports allow at most 324 unique cells within ±9 coordinates, building types 0–5 and quarter-turn rotations 0–3; files are limited to 256 KB. Invalid imports preserve the current map. JSON files stay local to the browser.

## Runtime boundaries

- `showcase-v1` explicitly enables the required canvas, light, mesh, camera, 3D physics and audio hosts. Existing default profiles keep their capabilities and hashes.
- This application-specific preview uses `createGodotPort` and the SDK Root lifecycle with trusted, prebuilt assets. It does not expand the certified `godot-react` CLI's template/resource import profiles.
- External imports are limited to `react`, `@godot-js/react` and `@playground/api`; relative project modules and JSON are bundled locally. Arbitrary npm/CDN resolution is not implemented.
- The engine runs in an opaque-origin sandboxed iframe with source-and-token checked messages. The static host must permit CORS for runner assets (`Access-Control-Allow-Origin: *` for this public bundle) and serve `.wasm` as `application/wasm`. The supplied server does both. Threads and PWA are off; COOP/COEP are not required.
- A normal Stop releases frames, nodes and resources. User code shares the runner's JavaScript realm; this preview cannot guarantee interruption of synchronous infinite loops.
- Rendering uses Compatibility/WebGL 2. Compute, Forward+ effects, general skeletal animation and arbitrary dynamic resource construction are outside this profile.

`dist/manifest.json` records engine version, template checksum, profile hash, compiler/type payload checksums and upstream provenance. The debug template is intentionally used for diagnostics and is larger than a release build.

## Validation

```sh
pnpm test:react
pnpm test:playground
pnpm --filter @godot-js/playground exec playwright install chromium
pnpm --filter @godot-js/playground test:browser
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium. Browser tests cover the original workbench geometry, Monaco/explorer/tabs, multi-file compilation, diagnostic navigation, autosave/export, splitters, dock, preview focus, mobile drawer and both runtime modes. They also run all eight demos and check gameplay, repeated scene disposal and runtime error recovery. Pure model tests cover board playability, BSP connectivity, city maps and project import validation. Screenshots default to `work/playground/restored`; `PLAYGROUND_SCREENSHOTS` overrides the destination. `PLAYGROUND_TEST_DIRECTORY` tests an alternative built static directory, including the private Sites snapshot.

`node apps/playground/scripts/browser-shell-test.mjs` runs focused checks for hidden manifests, restored selections, Save shortcut suppression in both realms, project export and automatic saving. It accepts the same Chromium and static-directory environment variables.

`pnpm --filter @godot-js/playground test:browser:projects` covers unchanged renames, shared-link reloads, atomic resource imports, original exported documents, recovery of damaged local snapshots, oversized edits, independent-project saves, cross-tab conflicts, large binary export/import round-trips, repeated file selection, JavaScript directory imports and JSON compiler consistency. Project limits (64 files, 8 MB total, 1 MB per binary attachment) apply before imports and autosaves. Rejected batches leave the project unchanged; oversized editor changes remain in the editor and can be exported, while the previous valid autosave is retained. On partial local recovery, the project menu offers an export of the complete original snapshot and valid projects still restore. Successful shared imports consume the URL fragment after saving, so reloading preserves later edits. The compiler checks and bundles JSON dependencies; unrelated JSON files do not affect builds.

## Upstream attribution

Downloaded inputs are vendored with exact commits and SHA-256 checksums in [`third-party/sources.json`](third-party/sources.json). Builds verify these before conversion.

The editor uses Monaco Editor 0.55.1; its MIT license and third-party notices are copied to `dist/assets/monaco-LICENSE.txt` and `dist/assets/monaco-ThirdPartyNotices.txt`.

- [Godot demo projects](https://github.com/godotengine/godot-demo-projects), commit `b761b4cd5718a7118f2c95eb55f181d0a5f004f1`: textures, sprite image and shader reference code. MIT notice retained in [`third-party/godot/LICENSE.md`](third-party/godot/LICENSE.md).
- [Kenney 3D Platformer](https://github.com/KenneyNL/Starter-Kit-3D-Platformer), commit `3fa8a04b1c01ab23db43123d4ce814a34c3fc7f0`: CC0 models and sounds; controller behavior adapted from MIT code. Complete upstream notice retained in [`third-party/kenney/README.md`](third-party/kenney/README.md).
- [Kenney City Builder](https://github.com/KenneyNL/Starter-Kit-City-Builder), commit `4535092b740b378b700efd9df9e27a631815b84a`: MIT placement/camera/save behavior, CC0 models; [notice](third-party/city/README.md) and [license](third-party/city/LICENSE.md).
- [Kenney Racing](https://github.com/KenneyNL/Starter-Kit-Racing), commit `2f2e5f2646dda89cb21d4e8539bab60c6e955dc8`: MIT sphere-controller architecture, CC0 models; [notice](third-party/racing/README.md) and [license](third-party/racing/LICENSE).
- [Kenney Match-3](https://github.com/KenneyNL/Starter-Kit-Match-3), commit `4ddb3d2a50cbf247c79cafe9e7884d7d8f99c012`: MIT gameplay reference, CC0 tile sprites; [notice](third-party/match3/README.md) and [license](third-party/match3/LICENSE).
- [Jummit Godot Destruction Plugin](https://github.com/Jummit/godot-destruction-plugin), commit `eb7ccb7148245f14211b3d4ccd9ec32bfbc49ca2`: MIT destruction pattern and CC0 pre-fractured cube with eight pieces; [notice](third-party/destruction/README.md), [MIT](third-party/destruction/LICENSE) and [CC0](third-party/destruction/LICENSES/CC0-1.0.txt).
- [BSP Dungeon Demo](https://github.com/Vincenzopaolo/BSP-Dungeon-Demo-Godot), commit `669eb02d0048ab6f7fe102d8da8f04c981025cf3`: MIT partition/room/corridor algorithm; [license](third-party/bsp/LICENSE).

Builds include upstream notices under `dist/third-party/`, linked from the credits dialog. SimpleDungeons remains deferred: its scenes, navigation and dungeon gameplay require a separate integration beyond the small BSP example.

GDQuest's NC-SA art and compute-based water demos are not included.

## Browser SDK conformance workbench

The root-level `main.ts`, `compiler-worker.ts`, `preview.ts`, `build.mjs`, `examples/` and `test/` remain the browser SDK conformance fixture used by the existing release, isolation, source-map and stress gates. They are not the default eight-demo application. `pnpm --filter @godot-js/playground build:conformance` builds that fixture into `dist-conformance/`; `scripts/test/prepare-browser-playground.mjs` continues to prepare release-bound fixtures into its explicit output directory. The browser SDK and its existing tests remain supported. See [the browser SDK guide](../../docs/browser-playground.zh-CN.md).

The contracts CI also builds the frontend without an engine (`build:frontend`) and runs `test:browser:projects` with `PLAYGROUND_TEST_SHELL=1`. This isolates real IndexedDB, Monaco and compiler checks from the full Godot gameplay regression gate.
