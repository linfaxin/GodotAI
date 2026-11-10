# GodotJS browser playground

A static browser application with a Monaco editor, a TypeScript compiler worker and a real, single-thread GodotJS Web runner. New sessions start with a native Godot project; React is an optional scene-authoring layer over the same engine. Each native/React Run produces a project PCK and starts a fresh preview session.

The default build uses `full-engine-v1`: the normal Godot 4.6.1 Web module set, GodotJS, and the fallback text server. Native constructors, methods, signals, resources and scenes come from the actual engine rather than the historical React host schema. “Full engine” means the capabilities compiled for this Web target; browser, WebGL 2, single-thread and editor-import restrictions still apply. Future React features normally belong in the JavaScript bridge. Changes to the native GodotJS ABI or engine fixes still require an engine rebuild.

## Project modes

| Schema 2 runtime | Execution | Starting point |
| --- | --- | --- |
| `godot` | Native Godot scripts/scenes/resources packed into a PCK | `src/Main.ts`, `main.tscn` and `project.godot` with `run/main_scene` |
| `react` | React component mounted into a native Godot scene with the generic engine renderer | `src/App.tsx` using `EngineNode` and constructors from `godot` |
| `legacy-react` | Explicit compatibility runner for existing showcase profiles and resource plans | The eight historical demos and migrated Schema 1 documents |

Projects retain `demoId`, `entry`, `selected`, `files`, `controls` and Production/Development `mode`. New-mode script entries accept TS, JS, TSX or JSX. A native scene-only project can leave `entry` empty. `project.godot` is authoritative for its main scene unless an explicit `mainScene` override is supplied. The model exposes the resolved path with `mainSceneSource: "project"`; this display value is re-derived after edits and is not passed back as an override. Native UID text remains unchanged. UID resolution uses scene headers, `.uid` files and existing `.godot/uid_cache.bin`, including binary `.scn` scenes.

Project settings use Godot's last-assignment rule across duplicate keys and repeated sections. Explicit main-scene overrides and the React bootstrap update every matching assignment. During framework development, native/React projects expose renames only for ordinary TS/JS/TSX/JSX scripts and text `.tscn` scenes, preserving the extension. Resource and declaration-file renames are disabled. Known unsupported path references and projects containing binary `.scn`, `.res` or `project.binary` are rejected before committing; the original files remain intact.

The compiler worker prepares supported TS/JS module reference edits for a rename, including incoming imports/re-exports and outgoing paths when a script moves. The editor commits these with scene references and UID sidecars only while the project snapshot is still current. Unhandled `reference path` directives and ambiguous code path literals cause refusal rather than partial updates. This is a bounded operation, not a complete semantic rename facility. Configuration supplied as UTF-8 bytes selects the same native naming/type profile as text.

Statically resolved native `godot` imports share a JavaScript namespace adapter inside each generated PCK. It supplies module metadata and lazy export names while returning the actual engine constructors, objects and functions. Dynamic-import expressions and interactions with local `require` bindings remain experimental and are deferred during framework development. No engine rebuild is needed for this adapter.

Project module checking, emitting and rename planning share one source-path resolver. Relative paths, root paths and `res://` source URIs map to the actual JS/JSON output under `.godot/GodotJS`; supported helper sources include `.mjs`, `.mts`, `.cjs` and `.cts`. The native worker performs type checking, and the shared core owns the single CommonJS emit pass and source maps.

Both local and CI Web engine builders apply `scripts/release/patch-web-engine.mjs`. Its checked patch set covers GLES3 Alpha Hash, small CanvasGroup backbuffers, private native tooltips, optional PWA discovery and audio shutdown. The CI build recipe records each patched file's original/result hashes and patch implementation hash. Source patch validation finishes before any files are written.

```tsx
import React from 'react';
import {EngineNode} from '@godot-js/react/engine';
import {Label} from 'godot';

export default function App() {
  return <EngineNode ctor={Label} native={{text: 'Hello React + Godot'}} />;
}
```

`EngineNode`, `createNativeComponent`, native refs and frame hooks provide generic React ownership and lifecycle handling without adding each ClassDB type to a host whitelist. Native scripts can directly import `godot`, `godot-jsb` and `godot.annotations`. In new-mode projects, `@godot-js/react` also resolves to the engine renderer; `@godot-js/react/engine` makes the choice explicit. Legacy imports and bounded resource contracts remain available through the compatibility mode.

## Legacy showcase

The IDE layout is restored from `ff8da42`: the original 42 px top bar, file explorer, Monaco editor with tabs, adjustable editor/preview split, Problems/Console dock and 24 px status bar. `web/style.css` retains the original workbench stylesheet; `web/workbench-additions.css` contains the project picker and demo controls. The top menu offers native/React starting projects and all eight legacy demos.

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

The eight legacy demos author scene trees and behavior in React/TypeScript. Their bounded imports and resource plans are documented in the capability sections below; those limits describe `legacy-react`, not the default native project path. Models become static meshes offline; the car retains separate body/wheel meshes, and pre-fractured pieces receive baked convex collision shapes. The platformer uses a static character pose rather than upstream skeletal animation; BSP uses rectangles instead of TileMapLayer terrain painting.

## Build and run

Use the repository's Node and pnpm versions and run `pnpm install --frozen-lockfile`.

The build requires:

- `GODOT`: a GodotJS **4.6.1 editor built from this checkout**, used for the retained showcase asset export.
- `GODOT_IMPORTER`: a normal Godot 4.6 editor with glTF support; defaults to `godot`. It converts the pinned GLB assets with `scripts/extract-assets.gd`.
- `GODOT_WEB_TEMPLATE`: an absolute path to the matching full-module single-thread `template_debug` ZIP. The default is `work/playground/engine-template/full-engine.zip` from the build script below. Production API capture rejects the P0 instrumentation module.

To build the Web template, activate Emscripten **4.0.11**, install SCons, and place this checkout at `GODOT_SOURCE/modules/GodotJS`:

```sh
GODOT_SOURCE=/path/to/godot-4.6.1 bash apps/playground/scripts/build-web-engine.sh

GODOT=/path/to/godotjs-editor \
GODOT_IMPORTER=/path/to/godot-editor \
GODOT_WEB_TEMPLATE=/path/to/godot.web.template_debug.wasm32.nothreads.zip \
pnpm build:playground

pnpm dev:playground
```

Open `http://localhost:4173`; `PORT` changes the development port. Build output is `apps/playground/dist`. For local native/React preview, the editor automatically uses `http://127.0.0.1:4173` as the separate origin; both names reach the supplied server. Engine artifacts and Godot import caches are ignored. After the initial build, skip unchanged model conversion with `pnpm --filter @godot-js/playground build --skip-assets`. `--legacy-only` is an explicit compatibility build and does not produce the full-engine default release.

Use **切换项目 (当前：…)** in the top bar to open the demo picker; the label follows the selected project and restored session. Escape or an outside click closes it, and arrow keys plus Enter select a project. The explorer supports file search, creation, rename, delete and binary attachments. Monaco provides syntax highlighting, completion, hover types and diagnostics with source navigation. Local TypeScript/JavaScript modules (including directory index.js/index.jsx files) and JSON imports compile together in the worker; its declarations come from the same SDK build.

Projects and per-demo edits save locally in IndexedDB. Writes merge only changed projects inside a transaction, so separate tabs editing different projects preserve each other. Concurrent edits to the same project show a conflict and retain the local buffer for export; oversized projects retain their last valid autosave without blocking other projects. The project menu imports/exports JSON, restores examples and offers original-document and recovery exports. Share copies a compressed project link; larger projects should use JSON export. Imports validate paths, the selected runtime's script/scene entry and file contents before replacing the active project. Projects permit up to 64 files / 8 MB of decoded contents; binary attachments permit 1 MB per file. JSON documents may be up to 128 MB to accommodate legacy byte arrays and migration history. The same decoded limits apply after import and bounded share decompression.

Schema 1 and unversioned exports migrate to Schema 2 with `runtime: "legacy-react"`. They retain an exact `migration.originalDocument` copy, including attachments and original configuration; migration never silently starts them as a new native or React project. The first replacement of an old stored record backs up the entire original IndexedDB snapshot in the same write transaction. Recovery restores create new version numbers, preserve the pre-restore snapshot and reject stale-tab conflicts. The menu can export both the active migrated document and its original input, export the recovery snapshot, or restore the available valid backup. Invalid data and failed transactions leave the stored original recoverable.

`package.json` is retained as project metadata for compilation and export, and hidden from the explorer, search, tabs and visible file count. Saved selections of that file return to the project entry. Ctrl/Cmd+S and Save As variants are suppressed in the workbench, Monaco and sandboxed preview; automatic saving remains enabled.

Ctrl/Cmd+Enter checks and runs the project. Ctrl/Cmd+B toggles the explorer; splitters support dragging, arrow keys and Home. The bottom dock supports Problems/Console tabs, output filters, copying, automatic scrolling and collapse. Focus Preview expands the scene; Escape returns to editing. Mobile uses the original file drawer and stacked editor/preview panes.

The left **运行设置** section shows the selected runtime and Production/Development mode. The `showcase-v1` profile, live demo parameters and actions belong to compatibility projects. Stop requests engine shutdown for native/React projects and disposes the preview session; the compatibility runner shuts down its React Root.

City maps use `{version:1,cells:[{x,z,type,rotation}]}`. Imports allow at most 324 unique cells within ±9 coordinates, building types 0–5 and quarter-turn rotations 0–3; files are limited to 256 KB. Invalid imports preserve the current map. JSON files stay local to the browser.

## Engine, resources and exact types

The shared `@godot-js/react-build/core` project compiler preserves native files and emits GodotJS CommonJS code/source maps under `.godot/GodotJS`. The browser adapter packs the prepared project into a PCK; it does not translate `.tscn`, `.tres`, `.scn` or `.res` into the legacy custom resource schema. Engine scripts, scene startup, native `ResourceLoader`, native values and utility APIs use the actual GodotJS bindings. Raw imported-format files are preserved too, but formats requiring editor import need their `.import` metadata and `.godot/imported` outputs. The browser does not run Godot editor importers. Compiler diagnostics report missing imports, unsupported external modules and resource identity conflicts.

`engine-release.json` binds the served JS/WASM and both audio worklets to production-native API captures from `godot-jsb.internal.get_engine_api()`. It includes engine/module/binding/naming identities, canonical API hashes, declaration/codegen identities, SDK modules and asset hashes. Both snake and camel declarations are generated from those same engine bytes and pass strict declaration/consumer checks before assembly. The worker chooses the matching snapshot from `project.godot`'s camel-binding setting. A stale capture, P0 inspection module, missing naming mode or mismatched declaration snapshot fails the build; `build:frontend` cannot silently replace an existing full-engine snapshot with unrelated types.

Declarations cover native classes, inheritance, builtins, properties, methods, signals and utility functions, including nullable native values and integer `number | bigint` contracts. Unknown native handles remain explicit opaque types and Variant values retain their dynamic boundary; engine reflection is not a proof that every runtime value is statically knowable. Project-specific scripts/autoloads and editor import results remain separate from the engine API snapshot.

The fixed SDK dependency set is bundled locally, and project-relative modules, `res://` imports and JSON are supported. Arbitrary npm/CDN installation is not implemented. Native construction is not restricted to the legacy host list. Compatibility/WebGL 2, browser-supported APIs, disabled threads and optional PWA remain target constraints; desktop-only features and Forward+/compute rendering are not supplied by this Web build.

## Separate-origin preview deployment

The SDK's runtime exports and Worker declaration paths share the versioned
`@godot-js/react/engine-modules` contract. It marks native renderer, shared,
legacy and testing entry points; compatibility helpers remain available for
explicit legacy roots. All shipped subpaths must have declarations before a
release can be assembled. The full-engine build also rejects templates missing
the normal Web runtime module baseline; the debug-only object profiler is optional.

Deploy the same complete `dist` release on the editor and preview sites, then configure the editor's `preview-config.json`:

```json
{"previewOrigin":"https://preview.example.com"}
```

For an editor at `https://editor.example.com`, the preview URL is `https://preview.example.com/preview.html`. A path prefix can be supplied when both copies preserve the release's relative asset layout. `?previewOrigin=...` overrides the config for local/deployment checks. Outside localhost, a missing configuration fails with an actionable error; same-origin preview is rejected.

Native/React sessions use a cross-origin iframe with `allow-scripts allow-same-origin allow-pointer-lock` and autoplay permission. The fixed preview page validates parent origin, source, protocol and run identity before accepting a MessagePort. The parent checks engine/worklet hashes and session/revision identities, requests quit on Stop, applies phase deadlines and removes the frame on completion, cancellation or forced disposal. Late messages cannot become the active run. The legacy opaque-origin `runner.html` remains a separate compatibility path.

Serve WASM as `application/wasm`, allow public asset CORS (the local server uses `Access-Control-Allow-Origin: *`), and configure both sites' CSP/frame policy for the intended editor/preview pair. The preview origin must not carry editor authentication or private application data. This single-thread build does not require COOP/COEP. Iframe disposal is a lifecycle boundary, not proof of immediate GPU/process memory collection or guaranteed interruption of a browser process blocked by synchronous code.

Builds write `manifest.json` for the full release and `legacy-manifest.json` for compatibility provenance. The debug template is intentionally used for diagnostics and is larger than a release build. Repository implementation and local verification do not mean these origins have been externally deployed or the release published.

## Validation

The Browser Playground workflow builds the actual default application from
`src/main.ts` and `src/compiler.worker.ts` into `default-playground-site`, using
the source-built Web template and a headless GodotJS editor for legacy asset
export. It runs native/React, editor, bridge failures/values, migration, eight-demo
and usability/refinement rendering/tooltip checks against that same directory. The compatibility conformance application
is built and archived separately. `--out <directory>` selects a dedicated output;
`--engine-report <report.json>` verifies the exact template and module set and
preserves source-build provenance.

`seal-site-acceptance.mjs <site> <reports> --begin` records all site bytes before
testing; sealing after all seven reports rejects any intervening change. `--verify`
checks that receipt again before archiving. The receipts also check the actual
default entry point source maps, so a conformance build cannot satisfy this gate.

```sh
pnpm test:react
pnpm test:playground
node --test apps/playground/scripts/project-model.test.mjs apps/playground/scripts/project-storage.test.mjs apps/playground/scripts/engine-project.test.mjs apps/playground/scripts/full-engine-release.test.mjs
pnpm --filter @godot-js/playground exec playwright install chromium
pnpm --filter @godot-js/playground test:browser
PLAYGROUND_FULL_ENGINE_LOOPS=50 pnpm --filter @godot-js/playground test:browser:full
```

The full-engine browser suite runs the built release on two local origins. It checks native and React startup, UID scenes, relative TypeScript/JSON imports, camel diagnostics, real audio output, verified worklet bytes and fresh-frame shutdown. `test:browser:editor` checks every native class's completion, hover types and typed React properties in both naming modes. `test:browser:bridge` checks all SDK subpaths, render/commit/frame diagnostics, ErrorBoundary recovery and packed array updates/reset in both naming modes. `test:browser:legacy` runs the retained eight-demo UI regression separately; `test:browser:projects` covers persistence, original exports and recovery.

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium. Browser tests cover the original workbench geometry, Monaco/explorer/tabs, multi-file compilation, diagnostic navigation, autosave/export, splitters, dock, preview focus, mobile drawer and both runtime modes. They also run all eight demos and check gameplay, repeated scene disposal and runtime error recovery. Pure model tests cover board playability, BSP connectivity, city maps and project import validation. Screenshots default to `work/playground/restored`; `PLAYGROUND_SCREENSHOTS` overrides the destination. `PLAYGROUND_TEST_DIRECTORY` tests an alternative built static directory, including the private Sites snapshot.

The focused project/release tests additionally cover native scene/entry packaging, Schema 1 recovery and abort behavior, cross-tab conflicts, main-scene edits/UID-cache resolution, exact declaration identity and snake/camel release assembly. Production builds capture the real target API and run strict declaration/consumer checks; an earlier P0 probe report is not substituted for that capture. Local P0 lifecycle regressions and deployment acceptance remain separate gates. These commands document verification entry points, not evidence that a public site has been deployed.

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

The root-level `main.ts`, `compiler-worker.ts`, `preview.ts`, `build.mjs`, `examples/` and `test/` remain the browser SDK conformance fixture used by the existing release, isolation, source-map and stress gates. They are separate from the default full-engine application. The default application reuses `preview.ts` as its fixed verified preview document. `pnpm --filter @godot-js/playground build:conformance` builds the conformance fixture into `dist-conformance/`; `scripts/test/prepare-browser-playground.mjs` continues to prepare release-bound fixtures into its explicit output directory. The browser SDK and its existing tests remain supported. See [the browser SDK guide](../../docs/browser-playground.zh-CN.md).

The contracts CI also builds the frontend without an engine (`build:frontend`) and runs `test:browser:projects` with `PLAYGROUND_TEST_SHELL=1`. This isolates real IndexedDB, Monaco and compiler checks from the full Godot gameplay regression gate.

## Legacy profile capability reference

The remaining sections document `legacy-react` showcase hosts, resource schemas and their historical integration tests. Their node counts, resource budgets, profile names and unsupported import lists are compatibility contracts. Native/React full-engine projects use the engine/project path described above, and native resources are not filtered through these legacy schemas.

## Extended Godot capabilities

The `showcase-v1` profile now exposes 112 node types (3235 schema properties, including 112 construction-only names,
and 326 signals). The native all-host gate verifies the 3123 mutable properties.
Its descriptor/hash includes
all existing UI/media and 2D character/static-body contracts, plus these extensions:

| Area | Available TSX hosts and operations |
| --- | --- |
| Physics | `Area2D/3D` body/area entry and exit signals and overlap queries; `RigidBody2D`, contact monitoring on both rigid bodies, central/off-center impulses and forces; `RayCast2D/3D` hit point, normal and collider queries |
| Characters | 3D collision layers/masks, normalized up direction, slope/snap/slide settings; floor/wall/ceiling queries in both dimensions |
| Cameras | `Camera2D` zoom, offset, limits and smoothing; `Camera3D` near/far planes |
| Audio | `AudioStreamPlayer2D/3D`, pitch, pause, autoplay, bus selection, stop/seek/playback queries and finished signals |
| Rendering | `OmniLight3D`, `SpotLight3D`, mesh ShaderMaterial references and `CPUParticles2D/3D` properties, restart and finished signals |
| Skeletons and animation graphs | `Skeleton3D`, `BoneAttachment3D`, `AnimationTree`, quaternion/transform DTOs, blend graphs and state machine commands |
| Native scenes | `NativeScene`/`NativeScene2D`, validated `PackedScene` assets, atomic replacement, bounded animation/bone query and command facades |
| UI and timing | `Timer`, `LineEdit`, `HSlider`, `CheckBox`, `OptionButton`, `SpinBox`, `GridContainer`, `TabContainer`; font/color/size and panel style overrides |
| Motion and batches | Node2D/3D Tween sequences, Curve/Path/PathFollow2D/3D, MultiMeshInstance2D/3D with isolated instance buffers |
| Physics queries and joints | ShapeCast2D/3D, bounded space ray/shape queries, PinJoint2D/3D, DampedSpringJoint2D, HingeJoint3D and SliderJoint3D |

Import the hosts from `@godot-js/react` directly. They use registered `useAsset` resources, including runtime project assets compiled from supported attachments and resource documents. This extension requires rebuilding the native
bridge/Web template and the playground together, so an older engine bundle must
not be used with the new SDK.

```tsx
import * as React from 'react';
import { Area3D, CollisionShape3D, Timer, useAsset, asset } from '@godot-js/react';

export default function Checkpoint() {
  const shape = useAsset(asset('player-shape', 'CapsuleShape3D'));
  return <>
    <Area3D collisionMask={1} onBodyEntered={body => console.log('Entered', body)}>
      <CollisionShape3D shape={shape}/>
    </Area3D>
    <Timer waitTime={1} autostart onTimeout={() => console.log('Tick')}/>
  </>;
}
```

`player-shape` is already registered by the sky-islands assets. For rigid body
contact events, set `contactMonitor` and a positive `maxContactsReported`.
Managed event bodies/colliders resolve to read handles; foreign bodies expose
identity DTOs, and a managed body retired before event delivery can retain only
its identity DTO. Ray queries can return null. No raw Godot node is exposed.

Use `usePhysicsProcess` for physics commands and `useProcess` for audio, timer,
particle and camera-smoothing commands. Off-center forces/impulses reserve
`linearVelocity`, `angularVelocity` and `sleeping`; particle restart reserves
`emitting` and `simulation`; timer start/stop reserves `timer`. An engine-owned
property is initialized with `initial`, rather than also being a controlled prop.
`LineEdit.text` and `HSlider.value` restore the latest React-controlled value after
native input. HSlider/SpinBox and showcase ProgressBar accept bounded explicit
steps and validate `minValue <= value <= maxValue`. Audio buses may be prebuilt
or installed from a Root-scoped AudioBusLayout resource document.

Run `pnpm test:showcase:native` after `pnpm build` with `GODOT` pointing to an
editor rebuilt from this checkout. The probe verifies every declared property,
signal and command signature against the real engine, timer commands, and React
mount/unmount for every host. Headless conformance verifies native contracts and lifecycle;
contact simulation, audible output and WebGL effects need the corresponding
integration checks. The full Web gameplay gate remains `test:browser` with the matching Web template.

The resource pipeline supplies SpriteFrames, value-track animations, skeletons, animation graphs, bounded native scenes, TileSet, MeshLibrary and pre-baked navigation. Resource graphs and node types remain explicitly allowlisted. The Web renderer remains Compatibility/WebGL 2.

The host also forwards native input snapshots to SDK `useInput` subscriptions,
including keyboard, mouse, touch and gamepad scalar/vector data, while retaining
the existing demo input service. Native event objects never cross that boundary.

## Project resources, animation, maps and navigation

The compiler now sends a validated resource plan with each run. The trusted host
revalidates it, emits generated `.tres` files in a unique per-run directory, and
registers them with `useAsset`. Stop, re-run and startup failure release the Root
before removing those files. Installation globalizes resource paths before writing
to the actual filesystem, so packed Web resource directories remain readable
while generated files live in the writable memory filesystem. Stop reports
verified file/directory removal counts for the browser lifecycle gate. Built-in asset ids cannot be overwritten. Asset
plans contain structured data; arbitrary author resource text never reaches the
native loader.

- PNG/JPEG attachments become `Texture2D` assets whose ids are their project paths,
  e.g. `useResource('/assets/hero.png', 'Texture2D')`. Browser decoding checks
  dimensions and pixels; at most 8 MB of decoded media and 32 MB of generated
  resource text are accepted per run.
- WAV attachments become `AudioStream` assets. Supported WAV inputs are RIFF PCM,
  mono/stereo, 8/16 bit, 8–192 kHz. Existing prebuilt Ogg audio remains available.
- Any `*.resources.json` file can define named resource assets. Schema version 1
  uses `{ "version": 1, "assets": { "id": { "type": "BoxMesh",
  "properties": { "size": { "x": 1, "y": 1, "z": 1 } } } } }`.
  References use the referenced asset id. Supported simple resource types are
  Box/Sphere/Cylinder/PlaneMesh, Box/Sphere/CapsuleShape3D,
  Circle/Rectangle/CapsuleShape2D, StandardMaterial3D and CanvasItemMaterial.
  `ShaderMaterial` uses `{type, code, parameters}` with canvas_item/spatial shader
  source and typed scalar/vector/color/texture parameters. Other shader stages
  require a separate renderer capability.
  Property names in resource documents use Godot's snake_case names and a closed
  allowlist. Mesh/material/texture dependencies are checked for type and cycles.
- `SpriteFrames` definitions use `animations: {walk: {fps: 8, loop: true,
  frames: [{texture: '/assets/hero.png', region: [0,0,16,16]}]}}`.
  Regions are optional atlas rectangles. Import `AnimatedSprite2D/3D` from the
  SDK, pass the SpriteFrames asset, and invoke `play(name, speed, fromEnd)` from
  `useProcess`. Reserve `animation`, `frame`, and `frameProgress` as engine-owned.
- `AnimationLibrary` definitions use `animations: {move: {length: 1, loop: true,
  tracks: [{path: 'Mover:position', keys: [[0,{x:0,y:0}], [1,{x:100,y:0}]]}]}}`.
  Supported value tracks target position, rotation, scale, modulate or visible
  beneath the player's root (`rootNode` is `.` or `..`). Methods/scripts and arbitrary NodePaths are rejected.
  Target fields must be engine-owned on their TSX hosts. `AnimationPlayer`
  provides `addLibrary`, `removeLibrary`, `play`, `pause`, `stop`, `seek`, `advance`,
  playback queries and start/finish signals. Library arguments use registered
  AssetRefs. Bind each library once; reserve `animationLibraries` and `playback`.
- `TileSet` definitions contain `texture`, `tileSize: {x,y}`, and `tiles:
  [{x,y,collision?:[{x,y},...],terrain?:number,peering?:{right_side:0,...}}]`.
  Optional `terrains: ['grass', ...]` names one corner-and-side terrain set.
  Atlas source id is 0. `TileMapLayer` supports `setCell`, `eraseCell`, `clear`,
  `setCellsTerrainConnect`, cell queries and local/map conversion. Coordinates
  use integer `{x,y}` values; mutating commands reserve `cells`.
- `MeshLibrary` definitions contain `items: [{name, mesh: 'meshId',
  shape?: 'shapeId'}]`. Item ids are their zero-based array indices. `GridMap`
  supports integer `{x,y,z}` cell writes, reads, clearing and local/map conversion.
- `NavigationPolygon` and `NavigationMesh` definitions contain `vertices` as 2D
  or 3D vectors and `polygons` as arrays of vertex indices. Supply valid pre-baked
  convex polygons. `NavigationRegion2D/3D` owns the corresponding resource;
  `NavigationAgent2D/3D` attaches under an actor and exposes physics-frame path,
  reachability, target and avoidance operations/signals. Reserve `targetPosition`
  for imperative target changes and `avoidanceVelocity` for velocity submission.
  Wait for the navigation map's physics synchronization before reading paths.

`*.scene.json` files describe `{type, props, children}` trees. A property reference
`{asset: 'meshId'}` resolves to a typed AssetRef. Use
`<ProjectScene name="/assets/box.scene.json"/>` from `@playground/api`.
`overrides` maps paths such as `Root/Child` to TSX props/handlers; construction
changes follow the same Root rules as ordinary TSX.

Godot format-3 `.tscn` and simple `.tres` files also import through a strict text
parser. This subset supports declared hosts and properties, Vector2/Vector3/Color,
external project resources, inline supported simple resources and nested scene
instances. Use `<ProjectScene name="/assets/box.tscn"/>`. The importer converts
these scenes to React-owned trees; it does not call native PackedScene.instantiate.
Scripts, connection sections, inherited-node overrides, opaque native transforms,
unsupported resource constructors and cyclic/deep references fail explicitly.
Images/WAV and JSON resource documents can be combined with imported scenes.
Native scene UID lookups and external project filesystem/network paths are not
resolved. This text subset remains intentionally narrow; embedded skinned GLB imports use the separate native importer described below.

The Web template now includes GridMap, Navigation2D and Navigation3D modules.
`pnpm test:showcase:native -- --resources` additionally checks actual resource
loading, native animation advancement, SpriteFrames playback, TileMap/GridMap
round trips, 2D/3D navigation and runtime resource cleanup. Its editor must also
include those modules and real navigation servers. `--fixed-fps 60` gives that
probe deterministic physics synchronization.

A complete importable example is available at
[`examples/engine-features.project.json`](examples/engine-features.project.json)
and is copied to the same path in the static build. It combines the resource
document, image attachment, imported TSCN and editable TSX. Run
`pnpm --filter @godot-js/playground test:browser:resources` against a fully built
playground to exercise those features in the real Web runner in both runtime
modes, including repeated Stop and resource cleanup.


## Skeletons, AnimationTree and native scenes

[`examples/advanced-engine.project.json`](examples/advanced-engine.project.json)
is a self-contained importable example. It contains a locally authored skinned
GLB with a bone animation, a procedural rig, a native rig, a blend graph, a state
machine and native scene replacement. The static build copies it to the same URL.

- Embedded glTF 2 `.glb` attachments become `PackedScene` assets. The native
  `GLTFDocument` importer retains meshes, skins, bones and animation clips, then
  saves a bundled scene under the run's generated directory. Inputs are validated
  before import. External buffers/images, sparse accessors and compressed mesh
  extensions are rejected. Embedded PNG/JPEG images are supported. The existing
  1 MB attachment limit applies; generated resources are capped at 32 MB.
- Resource documents add `SkeletonProfile` with topologically ordered
  `bones: [{name, parent?, rest?}]`, and `Skin` with `binds: [{bone, pose?}]`.
  Rest/bind transforms use `{basis:{x,y,z}, origin}` with vector3 columns.
  `<Skeleton3D profile={rig}>` initializes the rig; `BoneAttachment3D` follows
  its named bone. `MeshInstance3D` accepts `skin` and a local `skeleton` path.
  Process commands read/write poses using immutable vector, normalized quaternion
  and transform DTOs. Reserve `bones` for imperative poses; do not also control
  `profile` while that effect is reserved.
- Animation graphs support `AnimationNodeBlendTree`, `AnimationNodeStateMachine`,
  and `AnimationNodeBlendSpace1D/2D`. Inline nodes are `animation`, `blend2`,
  `add2`, `timeScale`, `timeSeek` and `oneShot`; `{asset: id}` nests a graph.
  Blend trees define named `nodes` and `[target, inputIndex, source]` connections;
  inputs are checked for cycles, arity and output reuse. State machines define
  `states`, `entry` and `transitions: [{from,to,fade?,auto?,atEnd?}]`.
  Bind an `AnimationPlayer`'s default `library` declaratively before activating a
  sibling `AnimationTree`. The tree exposes typed parameter commands, `advance`,
  `startState`, `travel` and `getCurrentState`. Reserve `animationParameters`
  and/or `playback` according to the command effects.
- `<NativeScene scene={useResource('/model.glb','PackedScene')}/>` mounts the
  validated instance beneath a React-owned Node3D. `NativeScene2D` uses Node2D.
  Structured project scenes also register as PackedScene assets;
  `<ProjectScene name="/box.scene.json" native/>` selects that path.
  Default ProjectScene rendering still expands into ordinary React hosts.
  Native mode uses a command facade instead of per-node React overrides.
- Native descendants are internal children, excluded from React's public child
  audit. Replacing the asset validates the new instance before retiring the old
  one; invalid replacement retains the prior instance. Parent disposal frees the
  internal subtree. No raw Node/Resource is returned. `listSceneNodes` and typed
  position/bone/animation queries return values; playback, bone poses, tree
  parameters and state travel use process commands. Reserve `prefabPlayback`
  and/or `prefabPose` for mutations. Paths are relative to the instance root;
  traversal outside that instance is rejected. Scripts, method tracks, authored
  connections and unsupported node classes are rejected.

Run `pnpm test:showcase:native -- --advanced` for real-engine skeleton, blend tree,
1D/2D blend space, state travel, native 2D/3D prefab and skinned GLB checks. `--ownership` verifies 20
replacements, rejected escaping targets and transactional replacement. The Web
regression is `pnpm --filter @godot-js/playground test:browser:advanced`; it uses
the real WASM runner in development, production, then development again and
asserts Root cleanup and actual generated-file removal on every Stop. The Web
template must include glTF and PNG/JPEG decoding, alongside the matching bridge
and SDK. This scope does not load arbitrary desktop projects or script plugins.


## Input actions and remaining gameplay contracts

[`examples/completion-engine.project.json`](examples/completion-engine.project.json)
combines all additions in one editable project. Import it, focus the preview and
press/release **J**. Source is retained in `examples/completion-engine.tsx`; run
`python3 scripts/prepare-completion-example.py` from this directory to regenerate
its project document. The bundled font subset is derived from DejaVu; its license
is included in the fixture directory and the exported example. The OGG tone is
locally generated. Font and OGG inputs retain the 1 MB attachment limit.

`useInputActions(ref, definition)` binds an action map to a mounted host. Import a
JSON map or define `{jump:{deadzone:.2,bindings:[{key:74},{joyButton:0}]}}` in source.
Each binding selects one physical `key`, `mouseButton`, `joyButton`, `axis`, or `touch`,
with optional device and axis direction. Actions expose `isPressed`,
`isJustPressed`, `isJustReleased`, `getStrength`, `getAxis` and `getVector`.
Analog strengths apply per-action deadzones. `getVector(left,right,up,down,deadzone?)`
uses raw strengths and a radial deadzone (the four action deadzones averaged by
default), then caps length at one. The hook maintains independent process/physics edge queues before normal
frame callbacks. A focus reset releases held controls. Maps are instance-local
and do not modify Godot's global InputMap; unmount disposes the subscription and
state. `createInputActions` exposes the same controller with explicit `feed` and
`beginFrame` methods for non-Hook integrations and deterministic tests.

Node2D/Node3D wrappers expose `startTween({steps,loops?})`, `cancelTween`,
`pauseTween`, `resumeTween`, `advanceTween(seconds)` and `isTweenRunning` from
`useProcess`. Each step contains `property` (`position`, `rotation`, `scale`),
`to`, `duration`, and optional `delay`, numeric Godot `transition`/`ease` and
`parallel`. Steps chain by default; a parallel step joins the preceding group.
`loops:0` repeats indefinitely; every plan must consume positive time. Reserve
`transform2d` or `transform3d` on the wrapper and frame subscription. The native
Tween binds to its node, replaces the previous plan only after validation and is
killed during node retirement. Child render hosts inherit the wrapper's motion.

Showcase Controls accept `font`, `fontSize`, `fontColor` and `panelStyle`.
Standalone `.ttf`/`.otf` attachments register as `FontFile` assets after table
bounds validation. `StyleBoxFlat` resource documents accept `properties` for
background/border colors, border widths, corner radii and content margins.
`OptionButton` accepts bounded string `items`, a `selected` index and
`onItemSelected`; `CheckBox` inherits Button's toggle props/events. `SpinBox`
exposes min/max/value, editable and suffix, defaulting to `step:0` with optional quantization. Controlled selection,
check state and numeric values restore after native input unless their handlers
commit a new React value. GridContainer uses `columns`. TabContainer exposes
`tabsVisible`, `onTabChanged` and process commands `selectTab(index)` (reserve
`tab`) and `getCurrentTab`. Native tab layout owns child visibility/geometry.

`.ogg` attachments use the native Vorbis decoder and register as AudioStream
assets. Ogg framing is checked before decoding. Resource documents now accept
`Environment` with allowlisted background, ambient light, reflection source,
tonemapping and ordinary fog properties supported by the Web renderer.
StandardMaterial3D additionally accepts normal, roughness, metallic, emission
and AO textures with their corresponding enable/scale properties. Texture
references remain typed and participate in resource dependency validation.

AnimationLibrary tracks may add `type: 'position3d' | 'rotation3d' | 'scale3d'`
with `path: 'Rig:BoneName'` and increasing `[time,value]` keys. These serialize to
native transform tracks; rotation keys use normalized quaternion DTOs. Native
scene wrappers also expose `pauseSceneAnimation(playerPath)` and
`seekSceneAnimation(playerPath, seconds, update)`, under `prefabPlayback`.

Curve2D/3D resources contain `points: [{position,in?,out?,tilt?}]` and optional
`bakeInterval`/`closed`; control handles are relative vectors. Path2D/3D accepts a
curve AssetRef. PathFollow children reserve their transform intrinsically;
reserve `progress` for `setProgress` from process callbacks, and query
`getProgressRatio`. Offset geometry belongs on a child host. 3D followers expose
Godot's `rotationMode`; 2D followers expose `rotates`.

MultiMesh resources contain `{type:'MultiMesh',mesh,dimension:2|3,count,colors?}`.
Each mounted MultiMeshInstance copies the mutable instance resource, preserving
the shared mesh. Process commands `setInstances`, `setInstanceTransform`,
`setInstanceColor`, `getInstanceCount` and `getInstancePosition` access values
only. Reserve `instances` for mutations. `setInstances` accepts the complete
native row-major float buffer: 8 floats per 2D transform or 12 per 3D transform,
plus four RGBA floats when colors are enabled. Per-instance transforms use
`(index,position,rotation,scale)` in 2D and `(index,transform3d)` in 3D. Dimensions,
indices, finite values and complete buffer lengths are checked before mutation.

Node2D/3D wrappers expose physics-frame `rayQuery(from,to,mask,areas,bodies)`
and `shapeQuery(shape,position,mask,areas,bodies,maxResults)`; shape queries use
an identity orientation at the supplied world position. A ray returns `[]` or
`[collider,position,normal,shapeIndex]`. Shape queries return bounded arrays of
`[collider,shapeIndex]`, at most 64 hits. Colliders use managed read handles or
foreign identity DTOs. No RID or native object crosses the facade. ShapeCast2D/3D
adds a shape, target, mask/filter settings and `forceUpdate` (reserve
`shapeQuery`), collision count/point/normal/collider queries. Check the collision
count before indexing. Joint hosts accept local `nodeA`/`nodeB` paths and
collision exclusion. Endpoints resolve after the complete commit, so sibling order and simultaneous
body/joint removal are supported. Endpoints must belong to the same owned tree. Absolute/escaping paths are rejected.

`pnpm test:showcase:native -- --completion` verifies these features together,
including rejected tab/collision indices, oversized query limits and escaping
joint paths. `pnpm --filter @godot-js/playground test:browser:completion` compiles
the importable project and runs real Web input, simulation, rendering and three
Stop/re-run cycles in development/production modes. It verifies generated-file
removal and empty Root records after each Stop. SDK tests cover input edge
lifetimes, deadzones, control restoration and Tween ownership/validation.


## Additional Godot parity contracts

Import [parity-engine.project.json](examples/parity-engine.project.json), focus
its preview and press **Ctrl+J**. This example combines the contracts below and
includes interactive native checkbox, dropdown, stepped input and tabs. Regenerate
it with `python3 scripts/prepare-parity-example.py` after editing its TSX source.

- CanvasItems expose `zIndex`, `zAsRelative`, `ySortEnabled`, `textureFilter` and
  `textureRepeat`. Free Controls accept `layout={{anchors:[l,t,r,b],offsets:[l,t,r,b]}}`.
  Query actual geometry through `getLayoutPosition`, `getGlobalLayoutPosition`
  and `getLayoutSize`. Container children reserve layout; TabContainer also owns
  direct child visibility. Labels expose alignment, wrapping, clipping and line limits.
  HSlider/SpinBox accept `step` (zero means continuous); values snap relative to
  `minValue`. Nonzero steps must be at least 1e-9 and bounds at most 1e9 in magnitude.
- Key and mouse bindings accept `shift/alt/ctrl/meta/exactModifiers`. `touch`
  selects a touch index. `setBindings(name,bindings)` rebinds at runtime while
  retaining held physical state; `getBindings` and `getRawStrength` expose values.
- Physics bodies accept `physicsMaterialOverride` referencing a `PhysicsMaterial`
  with friction, bounce, rough and absorbent properties. Joint hosts expose native
  spring, softness, limit, damping and motor parameters where their Godot class
  supports them. `queryRay({from,to,exclude?,collisionMask?,...})` and
  `queryShape({shape,transform,motion?,margin?,exclude?,maxResults?,...})` add full
  world transforms and same-Root live collider exclusions. `castMotion` returns
  `{x:safeFraction,y:unsafeFraction}`. Run queries in physics callbacks. 2D transforms
  use `{basis:{x:{x,y},y:{x,y}},origin:{x,y}}`; 3D uses the existing transform3d DTO.
- MeshInstance3D exposes blend shape names/count/value and a `setBlendShapeValue`
  command (reserve `blendShapes`). NativeScene exposes the equivalent scene-path
  commands (reserve `prefabPose`). AnimationLibrary tracks accept `type:'blendshape'`.
  AnimationPlayer adds queue/clearQueue/getQueue alongside existing `play` crossfade.
  AnimationTree adds startStateAt/travelAt/getCurrentStateAt with a validated
  `parameters/.../playback` path; nested machine resources accept `stateMachineType`.
- `AudioBusLayout` declares 1–16 logical buses and up to eight effects per bus.
  Sends target Master or an earlier declared bus. Reverb, LowPassFilter, Compressor
  and Limiter use closed property sets. The host installs layouts before rendering,
  gives each Root unique native bus names, and removes them on Stop. Audio players
  accept logical names. `AudioBus busName="Music" engineOwned={['audioBus']}` exposes
  scoped volume/mute/solo/effect commands and volume/mute/peak queries. Master cannot
  be controlled through this facade. Native scene audio routing is remapped too.
- NavigationLink2D/3D connects existing baked regions with local start/end positions,
  direction, costs and layers. NavigationObstacle2D/3D adds circle/radius or polygon
  avoidance; agents expose avoidance layers/mask/priority. This extends baked
  navigation and avoidance, without runtime navigation-mesh baking.
- SubViewport renders an independently sized target; SubViewportContainer supports
  stretch/shrink. Sprite2D/TextureRect `viewportPath` resolves an owned SubViewport
  after commit. `getTexture` returns a Root-scoped ViewportTexture AssetRef, usable
  on another texture consumer; `getPixelColor` reads an in-bounds rendered pixel.
  Both binding forms reject feedback cycles and foreign sources. GUI input is
  disabled by default; direct children of SubViewportContainer may opt in with
  `guiDisableInput={false}`. Structured native prefab consumers must remain in
  their outer viewport; React trees may use acyclic nested viewport graphs.

Run `pnpm test:showcase:native -- --parity` and
`pnpm --filter @godot-js/playground test:browser:parity` for combined regression
checks. The browser gate verifies actual offscreen pixels, modifier input, native
UI edits, linked navigation and Stop cleanup in development/production/development.

## Game input, collision results and geometry

Import [gameplay-engine.project.json](examples/gameplay-engine.project.json) to
exercise the remaining gameplay contracts together. Edit its TSX source and run
`python3 scripts/prepare-gameplay-example.py` to regenerate it. The generated PNG
palette contains red and green texels; the example checks native atlas output, scaled viewport
GUI, character collisions, fast rigid bodies, and isolated mesh materials.

Input preserves Godot's order. `useInput` receives raw snapshots;
`useUnhandledInput(ref, callback, options?)` runs only for events reaching the
host's native `_unhandled_input`. For gameplay actions use
`useInputActions(ref,map,{inputPhase:'unhandled'})`. Text input and buttons can
consume events before this channel. Action maps still observe releases, modifier
changes and focus resets through the raw channel, so switching GUI focus while
holding a key cannot leave an action pressed. Existing action maps default to
raw input for compatibility. Control adds `focusMode`, `onMouseEntered`,
`onMouseExited`, process query `hasFocus`, and input command `releaseFocus`
(reserve `focus`, as for `grabFocus`).

Interactive SubViewport is explicitly enabled with `guiDisableInput={false}`
under a direct, owned SubViewportContainer. Native forwarding handles stretch,
shrink, pointer coordinates, GUI focus and handled-event propagation. TextureRect
and Sprite2D display viewport textures without forwarding pointer input. Pure
render targets retain disabled GUI input by default. Non-container interactive
targets are rejected at the commit barrier, including structured native scenes.

Node2D/3D-derived hosts expose `getTransform`, `getGlobalTransform`,
`getGlobalPosition`, `toGlobal(point)` and `toLocal(point)`. `lookAt(target)` in
2D or `lookAt(target,up)` in 3D reserves the existing transform ownership group.
Use physics callbacks for CharacterBody/RigidBody/StaticBody and process callbacks
for other spatial hosts. Singular inverse transforms, coincident look targets
and parallel/zero 3D up vectors reject before native operations. Camera3D adds
`unprojectPosition`, `isPositionBehind` and `isPositionInFrustum`; existing
`projectRayOrigin/projectRayNormal` remain available for picking.

CharacterBody2D/3D adds physics commands:

- `getSlideCollisionCount()` and `getSlideCollision(index)` after `moveAndSlide`.
- `moveAndCollide(motion,testOnly,margin)` for swept movement or a test-only sweep.
- `testMove(worldTransform,motion,margin)` to query from an explicit transform.

Movement mutations reserve the body's transform group. A missed sweep returns
`null`. Collision DTOs contain `position`, `normal`, `travel`, `remainder`,
`colliderVelocity`, `collider`, `colliderShape` and `depth`; 3D includes a bounded
`contacts` array. Managed colliders resolve to read handles, foreign objects to
identity DTOs. Collision resources and RIDs stay private. Area2D/3D adds
`getOverlappingBodies/Areas` in physics callbacks. RigidBody2D `continuousCd`
accepts 0/1/2 (disabled/cast ray/cast shape); RigidBody3D accepts a boolean.
These retain Godot's native physics semantics. The fast thin-wall gate uses 2D
cast ray and 3D CCD; native 2D cast shape can tunnel in extreme thin-wall cases.

Sprite2D adds `hframes`, `vframes`, `frame`, `regionEnabled`, `regionRect` and
`regionFilterClipEnabled`. `regionRect` is `{position:{x,y},size:{x,y}}`.
Grid setters run before frame selection, including updates where a controlled
frame stays unchanged. Frame indices must fit the complete grid. `AtlasTexture`
resources use `{type:'AtlasTexture',atlas:'image-id',region:[x,y,width,height],
margin?:[x,y,width,height],filterClip?:boolean}`; source dependencies, cycles and
known image bounds are checked. Texture consumers can use registered atlas refs.
NinePatchRect exposes texture/region, four patch margins, center drawing and
horizontal/vertical stretch modes.

Line2D supports bounded points, width, color, closed lines, antialiasing, caps,
joints and texture mode. Polygon2D supports polygon, matching UVs, texture,
color and antialiasing. CollisionPolygon2D supports solid/segment build modes,
disabled and one-way settings. Polygons are simple, nondegenerate and at most
256 vertices; line/vector arrays have the existing 4096-element bound.
ConvexPolygonShape2D/3D, ConcavePolygonShape2D/3D, SeparationRayShape2D/3D and
WorldBoundaryShape2D/3D are available as structured resources. Concave resources
use segment pairs in 2D and triangle faces in 3D; boundary normals normalize;
convex shapes require a convex 2D boundary or a nonzero-volume 3D hull. Concave
shapes follow native restrictions for static collision geometry.

ScrollContainer process commands `getScroll()` and `setScroll({x,y})` read/write
integer offsets; writes reserve `scroll`. Showcase ProgressBar now accepts
min/max and quantized step using the same precision rules as HSlider/SpinBox.
Container geometry and explicit ColorRect position/size share the layout
ownership checks. Supplying `layout` together with position/size rejects; codec
names such as `numberArray` are never valid ownership aliases.

An ArrayMesh document contains `{type:'ArrayMesh',surfaces:[{vertices,normals?,
uvs?,indices?,material?}]}`. Vertices/normals use vector3 DTOs, UVs vector2,
and indices bounded integers. The trusted adapter constructs native triangle
surfaces and saves a resource before use. It supports at most 64 surfaces and
65536 vertices per mesh, with existing aggregate byte/file limits. Optional
normal/UV arrays match vertex counts, normals normalize, and indices must form
complete triangles within bounds. MeshInstance3D `surfaceMaterials` is a bounded
array of registered material refs or nulls; overrides belong to the instance.
`getSurfaceCount` and `getSurfaceMaterial(index)` query actual native values.
Returned materials are Root-scoped AssetRefs usable by another mesh in that Root.
MeshLibrary and MultiMesh may reference the generated meshes too.

AudioBus process commands `setBusEffectParameter(index,name,value)` and
`getBusEffectParameter(index,name)` use the same closed Reverb, LowPassFilter,
Compressor and Limiter parameter sets as resource creation. Setters reserve
`audioBus`. Effects are cloned when installing scoped buses; invalid types,
indices, names and ranges reject before mutation. Master remains inaccessible.

The bounded Godot text-scene importer also accepts Rect2, integer vectors and
packed vector arrays for geometry, plus the supported atlas and shape resources.
ArrayMesh surfaces use structured resource documents rather than Godot's private
serialized surface buffers. Scripts and arbitrary constructors remain rejected.

Run `pnpm test:showcase:native -- --gameplay` and
`pnpm --filter @godot-js/playground test:browser:gameplay` for combined validation.
The browser gate types into a real LineEdit, verifies raw/unhandled counters,
changes focus while holding a key, clicks a stretched/shrunk viewport button,
reads rendered atlas pixels, and verifies complete Stop cleanup in three modes.


## Moving platforms, effects and independent Tweens

Import [behaviors-engine.project.json](examples/behaviors-engine.project.json) for
one scene covering the following additions. Its editable source is
[behaviors-engine.tsx](examples/behaviors-engine.tsx); regenerate the project with
`python3 scripts/prepare-behaviors-example.py` from this directory.

- `AnimatableBody2D/3D` supports physics-synchronized moving platforms.
  Character bodies expose `platformFloorLayers`, `platformWallLayers`,
  `platformOnLeave`, `getPlatformVelocity` and `applyFloorSnap` in physics hooks.
  `readPosition`, `readVelocity`, `setPosition` and `setVelocity` preserve the 3D
  `z` coordinate and choose the native command for the host type.
- Areas expose gravity/damping override modes, point gravity, strength, direction,
  center, unit distance and priority. The bridge retains direction and center
  separately and applies the active value when `gravityPoint` changes; this avoids
  their shared native storage making initialization depend on property order.
  Rigid bodies expose `freezeMode`, torque and torque impulse.
- Bodies, ray casts and shape casts offer `addCollisionException(handle)`,
  `removeCollisionException(handle)`, `clearCollisionExceptions()` and
  `getCollisionExceptions()` in physics hooks. Reserve `collisionExceptions` for
  mutation. Up to 64 explicit, live, compatible nodes in the same Root are allowed;
  retired targets are pruned and no RID crosses the bridge.
- Canvas nodes expose `getCanvasTransform`, `localToViewport` and
  `worldToViewport` in process hooks. `viewportToLocal` and `viewportToWorld`
  operate on input-event positions in input hooks, including camera zoom and
  CanvasLayer transforms. Camera2D adds drag margins/offsets, rotation smoothing
  and `forceUpdateScroll` (reserve `cameraSmoothing`). ColorRect now inherits the
  standard Control focus commands and focus signals.
- Visual 3D hosts expose 20-bit `layers`, camera `cullMask`, light `lightCullMask`
  and geometry `castShadow`. Canvas nodes and MeshInstance3D expose typed
  `setShaderParameter(slot, name, value)` / `getShaderParameter(slot, name)`.
  Slots are `-1` for canvas material, `-2` for mesh material override and `0..63`
  for mesh surfaces. Reserve `shaderParameters`. Values are booleans, numbers,
  vectors, RGBA colors and registered static Texture2D assets. Native uniform
  reflection rejects mismatched types and unknown names. Each node/material slot
  receives a private ShaderMaterial copy, preserving shared source assets;
  dynamic ViewportTexture samplers are excluded from this command.
- CPU particles add emission shapes, points/normals (up to 4096), fixed seeds,
  fixed FPS (`0..240`), `colorRamp` and `scaleAmountCurve`, plus 3D ring settings.
  Resource documents support `Curve` with 2..256 sorted `{x,y}` points (`x:0..1`,
  `y:-64..64`), `Gradient` with 2..256 sorted `{offset,color}` points, and
  `GradientTexture1D` with a Gradient id, width `1..4096` and optional `useHdr`.
  Curve segments default to linear and support the free tangents described below; gradients support interpolation modes `0..2` and color spaces `0..2`.
- Navigation agents expose bounded full paths (4096 points), current path index,
  final position, target distance, `onPathChanged`, neighbor distance/count and
  agent/obstacle time horizons. Read the path after `getNextPathPosition` in a
  physics hook; navigation maps still need their native synchronization frames.
- Appearance, Range value and audio volume Tweens have independent
  `start/cancel/pause/resume/advance` commands and `is…TweenRunning` queries,
  alongside the existing transform Tween. For example,
  `startAppearanceTween({steps:[{property:'modulate',to:{r:1,g:1,b:1,a:0},duration:1}]})`,
  `startValueTween({steps:[{to:100,duration:1}]})` and
  `startVolumeTween({steps:[{to:-12,duration:1}]})`. Reserve `appearance`,
  `range.value` and `volumeDb` respectively. Plans contain 1..128 steps with
  duration/delay `0..86400`, transition/ease, parallel steps and loops `0..1000000`;
  total duration must be positive. Appearance properties are limited to
  `modulate`, `selfModulate`, `color`, `defaultColor`; value targets must fit the
  Range and volume targets must be `-80..6` dB. Replacement, unmount and Root
  shutdown kill the affected Tweens, including paused Tweens.

Run `pnpm test:showcase:native -- --behaviors` and
`pnpm --filter @godot-js/playground test:browser:behaviors` after rebuilding the
native/Web engines. The browser gate runs development → production → development,
checks rendered shader/particle pixels, platform carrying, gravity motion,
exception retirement, pointer coordinates, focus and generated-resource cleanup.


## Processing, constraints, UI and display essentials

Import [essentials-engine.project.json](examples/essentials-engine.project.json).
Its [TSX source](examples/essentials-engine.tsx) is regenerated with
`python3 scripts/prepare-essentials-example.py` from this directory. Press F to
focus the Label, click First then press Tab, and press P to start the audio checks.

- All showcase hosts accept native `processMode`: inherit (0), pausable (1),
  when-paused (2), always (3), disabled (4). SDK process/physics/input callbacks
  respect native `canProcess`, including inherited modes. Raw release/reset
  snapshots still clear scoped input while a node is disabled. Native timers,
  bound Tweens and animation retain Godot's processing semantics; this does not
  change SceneTree-wide pause state. Timer adds `processCallback` (physics 0,
  idle 1) and process query `getTimeLeft()`.
- Derived Control hosts consistently expose focus commands. Spatial/2D hosts
  expose their inherited position/rotation/scale commands, with physics-body
  transform setters restricted to physics hooks. Native ColorRect size
  acknowledgements account for Godot's minimum-size clamping.
- Rigid bodies add `lockRotation`, `linearDampMode`, `angularDampMode`,
  `centerOfMassMode`, `centerOfMass`, `constantForce` and `constantTorque`.
  All supported PhysicsBody3D hosts expose six `axisLockLinearX/Y/Z` and
  `axisLockAngularX/Y/Z` flags. Center-of-mass mode is applied before its vector;
  custom centers affect simulation when mode is 1. Constant forces/torques are
  native persistent forces, not impulses reapplied by a React frame hook.
- Controls add `tooltipText`, `mouseDefaultCursorShape`, four
  `focusNeighborLeft/Top/Right/Bottom` paths and `focusNext`/`focusPrevious`.
  Focus paths are local, bounded to 512 characters and resolve to live Controls
  in the same Root after the complete commit. Clear paths when removing their
  targets. Native scene focus paths must also remain inside their scene subtree.
  Button/CheckBox/OptionButton add static texture `icon`, `expandIcon`,
  `alignment`, and StyleBoxFlat refs `normalStyle`, `hoverStyle`, `pressedStyle`,
  `disabledStyle`, `focusStyle`. The closed set of state names is validated.
  CenterContainer and AspectRatioContainer own their child layout outputs;
  manually controlled child layout remains rejected.
- Sprite3D exposes static texture/atlas frames, region, billboard mode, pixel
  size, modulate and draw flags. Label3D adds text, FontFile, size, outline,
  wrapping/alignment and billboard controls. Both support render layers and
  independent appearance Tweens. ViewportTexture is excluded from these new
  texture bindings. VisibleOnScreenNotifier2D/3D exposes bounded `rect`/`aabb`,
  `isOnScreen` and `onScreenEntered`/`onScreenExited`. Notifications require a
  rendered viewport and arrive after native visibility evaluation. AABB is a
  finite `{position:{x,y,z},size:{x,y,z}}` snapshot with nonnegative extents;
  bounded Godot text-scene import accepts the corresponding AABB constructor.
- Line2D adds `widthCurve` and `gradient`. CPUParticles2D/3D adds bounded
  `linearAccelMin/Max/Curve`, `dampingMin/Max/Curve` and
  `angularVelocityMin/Max/Curve`, reusing registered Curve assets. Minimums must
  not exceed maximums; damping cannot be negative. These resources remain shared
  and immutable through the public API.
- Audio players add `maxPolyphony` (1..64); spatial players add
  `panningStrength` (0..4), and 3D adds `attenuationModel` (0..3).
  Resource documents accept `{type:'AudioStreamWAV',format:0|1,stereo:boolean,
  mixRate:8000..192000,data:[bytes],loopMode:0..3,loopBegin,loopEnd}`. PCM data is
  limited to 1 MiB; format 0 is signed PCM8 and format 1 is little-endian PCM16.
  Loop positions count sample frames, independently of channels/byte width, and
  active loops require `0 <= loopBegin < loopEnd <= frameCount`. Ordinary WAV
  file import remains supported. Browser audio checks require a user gesture.

Run `pnpm test:showcase:native -- --essentials` and
`pnpm --filter @godot-js/playground test:browser:essentials` with rebuilt engines.
The browser gate checks real keyboard focus navigation, sprite/text/line pixels,
2D/3D screen events, subtree processing, physical motion, looping and one-shot
playback, and Stop cleanup in development → production → development. Headless
checks cover configuration and physics; rendered visibility and audible playback
are covered by the browser gate rather than dummy headless drivers.

A separate `test:browser:gpu-probe` exports a trusted engine-only GDScript fixture
and reads actual WebGL pixels from GPUParticles2D/3D. Supply `GODOT` and the matching
`GODOT_WEB_TEMPLATE` as for the main build. This probe evaluates native renderer
support independently from the TSX resource/host allowlist; it does not expose
arbitrary GDScript to playground projects.

The GPU probe passes for both 2D and 3D emitters on the current Godot 4.6.1
Compatibility/WebGL 2 build. This establishes basic emission/rendering support.
Particle trails, sub-emitters and manual `emit_particle` are outside Compatibility
support, and remain excluded from the TSX GPU API below.


## GPU particles, Control animation and interaction parity

Import [interactions-engine.project.json](examples/interactions-engine.project.json)
and click the second textured button. Its [TSX source](examples/interactions-engine.tsx)
is regenerated with `python3 scripts/prepare-interactions-example.py`.

- `GPUParticles2D/3D` expose emission, one-shot completion, restart, fixed/random
  seed, timing and visibility bounds. Registered `ParticleProcessMaterial` assets
  are copied per emitter; native scene materials must be local to their scene.
  The source remains immutable, including the 2D disable-Z flag. Amount is
  1..16384 per emitter and 65536 per live Root, including native scene subtrees.
  Lifetime is .01..600 seconds, preprocess 0..10, speedScale 0..16 and fixedFps
  0..240. 2D accepts static textures; 3D accepts registered Mesh assets, including
  the new bounded QuadMesh. Root replacement releases the previous budget.
- Resource JSON accepts `{type:'ParticleProcessMaterial',properties:{...}}` with
  a closed set of native names: direction/gravity/spread/flatness/color,
  particle_flag_disable_z, emission_shape (point/sphere/sphere-surface/box/ring),
  sphere/box/ring dimensions, initial_velocity_min/max, scale_min/max,
  angle_min/max, angular_velocity_min/max, linear_accel_min/max and damping_min/max.
  Scale/angular-velocity/linear-acceleration/damping curves reference
  `{type:'CurveTexture',curve:'curveId',width:256}` (width 2..4096), reusing the
  bounded Curve resource. color_ramp references GradientTexture1D.
  Minimums cannot exceed maximums. Point-texture emission, custom particle
  shaders, trails, sub-emitters and manual emit_particle are excluded.
- All Control hosts expose position/size/rotation/scale/pivotOffset and matching
  process-phase setters. Position and size belong to `layout.position` and
  `layout.size`; rotation/scale/pivot belong to `uiTransform`.
  `startLayoutTween({steps:[{property:'position',to:{x:100,y:20},duration:1}],loops:1})`
  supports those five properties with delay, transition, ease and parallel steps.
  Use cancel/pause/resume/advanceLayoutTween and isLayoutTweenRunning. Layout and
  appearance Tweens can run together. Plans contain 1..128 steps, positive total
  time and at most 1000000 loops (0 means infinite). Sizes respect native minimums;
  UI scales must be positive. Containers retain child layout/transform ownership.
  Anchored presets retain Godot's resize behavior without default-position writes.
- TextureButton exposes state textures, flipping/stretching and normal button
  toggling/signals. TextureProgressBar exposes layered textures, tints, radial
  modes, range quantization and the existing independent value Tween API.
  Button/CheckBox/OptionButton/TextureButton accept registered
  `{type:'ButtonGroup',allowUnpress:false}` assets. Each Root clones the group,
  sharing that copy among its buttons, with at most 32 groups and 64 members each.
  `getGroupPressedButton()` and `getGroupButtons()` return managed node identities.
- AnimationLibrary animations accept loopMode 0/1/2 (none/linear/ping-pong).
  Tracks accept interpolation 0..2, or 0..4 for scalar rotation including angular
  interpolation; updateMode is 0..2. A key is `[time,value,transition?]`, where
  transition is -16..16. Visibility defaults to nearest/discrete updates and
  requires that combination. Numeric value keys serialize as floating point so
  angular interpolation follows native semantics. AnimationPlayer exposes
  process-phase setBlendTime/getBlendTime for existing clips, bounded to 0..600s.
- SpringArm3D exposes length, margin, collision mask, registered Shape3D and
  physics-phase getHitLength plus managed add/remove/clear/getCollisionExceptions.
  Exceptions are scoped to live CollisionObject3D nodes in the same Root, bounded
  to 64 and pruned when their targets leave. Native RIDs remain internal.
  Camera3D adds keepAspect, frustumOffset and hOffset/vOffset. Projection helpers
  preserve Godot 4.6.1 behavior: with a frustum offset, a center ray may unproject
  away from the viewport center because native ray and projection helpers treat
  that offset differently.
- NavigationAgent2D/3D add pathPostprocessing, simplifyPath/simplifyEpsilon,
  pathMaxDistance/pathReturnMaxLength and onWaypointReached/onLinkReached.
  Events are immutable DTOs with position, type, owner, linkEntryPosition and
  linkExitPosition where supplied by Godot. Owner is a managed node or null;
  RID and arbitrary engine fields are removed, and nested vectors can be passed
  directly to movement commands. Custom link traversal is performed by the app.
  Native path simplification can remove collinear link waypoints; keep
  simplifyPath false when those waypoint/link callbacks drive traversal.
- StandardMaterial3D transparency rejects enum sentinel 5 (valid 0..4).
  StyleBoxFlat border/corner dimensions and AudioEffectLowPassFilter db reject
  fractional values before loading, matching native integer/enum properties.

Run `pnpm test:showcase:native -- --interactions` and
`pnpm --filter @godot-js/playground test:browser:interactions` after rebuilding
both engines. The browser gate checks actual GPU/progress pixels, native mouse
selection, layout resizing, animation and navigation in development → production
→ development, plus complete Stop cleanup. The native gate also rejects invalid
commands, checks group/material isolation, the Root particle budget and Tween
cleanup. Resource JSON is the complete authoring path for the new bounded graphs;
Godot text import continues to accept its documented closed subset.


## Presentation, text editing and resource import completion

Import [presentation-engine.project.json](examples/presentation-engine.project.json).
Click its input, type `abc`, select all, erase and type `go`. Regenerate the
[TSX source](examples/presentation-engine.tsx) bundle with
`python3 scripts/prepare-presentation-example.py`.

- Godot format-3 `.tres`/`.tscn` import now closes the existing Curve →
  CurveTexture → ParticleProcessMaterial and Gradient → GradientTexture1D graphs.
  It resolves external/subresource references recursively, including references
  inside arrays. Texture2D declarations can refer to supported texture subclasses.
  The parser accepts bounded arrays, multiline/trailing-comma array syntax,
  PackedFloat32Array and PackedColorArray; values have maximum depth 32, arrays
  have at most 16384 elements and each document has at most 65536 parsed values.
  Existing document, graph-depth and generated-resource budgets still apply.
  Curve import accepts the normalized 0..1 domain, free/linear tangent modes,
  2..256 points and bake resolution 2..1000. Tangents and value limits are
  preserved under the bounds below. This does not execute scene scripts.
- AnimatedSprite3D now shares Sprite3D's modulate, billboard, shaded, doubleSided,
  noDepthTest and fixedSize properties and independent appearance Tween commands.
  Animation playback and appearance ownership remain separate; a playing sprite
  can fade without changing its clip/frame ownership.
- LineEdit adds process-phase `select(from,to)`, selectAll, deselect,
  hasSelection, getSelectedText, getSelectionFromColumn, getSelectionToColumn,
  getCaretColumn, setCaretColumn, insertTextAtCaret, deleteText and
  deleteCharAtCaret. Indices use Godot Unicode codepoints, not JavaScript UTF-16
  offsets. `select` accepts -1 as its end sentinel; other indices must fit the
  current text. Commands operate on at most 65536 codepoints, reject reversed or
  invalid ranges, and require editable=true for mutations. Deletion at the caret
  preserves native grapheme/backspace behavior. Selection commands write
  `text.selection`; editing commands also write `text`. Declare those hook write
  groups and keep text engineOwned for imperative edits. Selection remains usable
  with controlled text. Native signal semantics are retained: insertTextAtCaret
  does not synthesize text_changed; range deletion uses native deferred delivery.
  onTextChangeRejected reports maxLength overflow. selectAllOnFocus, caretBlink
  and caretBlinkInterval (.01..10 seconds) configure native focus/caret behavior.
- TextureProgressBar adds integer stretchMarginLeft/Top/Right/Bottom (0..16384),
  radialCenterOffset and textureProgressOffset. Native nine-patch and radial
  rendering semantics are retained. StyleBoxFlat adds shadow_color, shadow_size
  (integer 0..4096), shadow_offset (±4096), expand_margin_left/top/right/bottom,
  draw_center, anti_aliasing and anti_aliasing_size (.01..10). Expansion margins
  are finite nonnegative values up to 4096. Resources remain immutable/shared.
- Parallax2D exposes scrollScale, scrollOffset, repeatSize, repeatTimes,
  autoscroll, limitBegin/End, followViewport and ignoreCameraScroll. Native
  position is an intrinsic scroll output; direct position writes and position
  Tweens are excluded. Positive scale is required. repeatSize is 0..16384 per
  axis; repeatTimes is 1..16, enforced in both SDK/native setters and scene
  validation. Zero repeat extent disables repetition on that axis. Use initial
  scrollOffset when autoscroll is nonzero; controlled scrollOffset conflicts with
  automatic scrolling. Scroll/limit vectors are bounded to ±10000000, and limits
  must be ordered. CanvasLayer adds followViewportEnabled and followViewportScale
  (.001..1000). Its native follow scale affects transforms; it does not mean a
  proportional reduction in camera translation.
- GPUParticles2D/3D add amountRatio and interpToEnd (0..1), interpolate,
  fractDelta and drawOrder (0..2 in 2D, 0..3 in 3D). Amount ratio controls emission
  while the allocated amount still consumes the full per-emitter/Root budget,
  including ratio zero. The native regression explicitly verifies that lowering
  ratio cannot bypass the 65536-particle Root cap. interpToEnd advances lifetime
  toward its endpoint on every simulation step; it is not a fixed spawn-age
  offset. The example restores it to zero before stable-pixel checks. Compatibility exclusions for
  trails/sub-emitters/manual emission remain in effect.

Run `pnpm test:showcase:native -- --presentation` and
`pnpm --filter @godot-js/playground test:browser:presentation` with rebuilt engines.
The browser gate validates real keyboard edits, animated sprite alpha, progress
and radial pixels, panel shadows, repeated backgrounds/viewport following, GPU
emission ratio changes and Stop cleanup in development → production → development.
Headless native checks cover resource loading, Unicode command semantics, invalid
arguments and budgets; renderer-dependent checks run in the browser gate.


## Map readback, text reveal, paths, lighting and material controls

Import [scene-details-engine.project.json](examples/scene-details-engine.project.json).
Its [TSX source](examples/scene-details-engine.tsx) runs all checks automatically;
regenerate the project with `python3 scripts/prepare-scene-details-example.py`.

- TileMapLayer adds process-phase getUsedCells(),
  getUsedCellsById(sourceId, atlasCoords, alternativeTile), getUsedRect() and
  getCellAlternativeTile(coords). Native -1 filter sentinels are preserved.
  GridMap adds getUsedCells(), getUsedCellsByItem(item) and
  getCellItemOrientation(coords). Results are immutable integer-coordinate
  snapshots, bounded to 65536 cells. Ordering follows Godot and is not guaranteed.
  getUsedRect returns `{position:{x,y},size:{x,y}}` with integer components and
  nonnegative extents. Empty maps retain native empty-rectangle semantics.
  GridMap exposes collisionLayer/collisionMask (uint32), collisionPriority
  (.001..128), cellScale (.001..100), cellCenterX/Y/Z. Tile/Grid mutation commands
  retain their existing `cells` ownership group. Physics queries observe native
  synchronization timing; a managed GridMap collider returns its Root-local node
  identity, without exposing RIDs.
- Label adds visibleCharacters (-1 for all, otherwise 0..128000),
  visibleCharactersBehavior (native TextServer modes 0..4), process-phase
  setVisibleRatio(0..1), getVisibleRatio(), getTotalCharacterCount(),
  getLineCount() and getVisibleLineCount(). Character limits and ratio commands
  share `textReveal` ownership. Use initial visibleCharacters and engineOwned
  textReveal for imperative reveal; the ratio is a derived command/query rather
  than a second independently controlled property. Native shaping, Unicode
  counts and ratio rounding are preserved. fontOutlineSize (0..64),
  fontOutlineColor, fontShadowColor, shadowOffsetX/Y (-256..256) and
  shadowOutlineSize (0..64) are closed, per-Label native theme overrides.
- PathFollow2D/3D adds process-phase setProgressRatio(0..1), hOffset/vOffset
  (-10000..10000) and cubicInterp. 3D additionally exposes tiltEnabled and
  useModelFront. Ratio and distance progress share `progress` ownership;
  position/rotation/scale remain intrinsic native path outputs. Ratio commands
  require an attached Path2D/3D with a nonempty positive-length curve, preventing
  native errors for invalid parents or empty paths. Native looping, tilt and
  orientation semantics are preserved; Cubic interpolation samples the baked
  path and can differ from linear interpolation on coarse curved bakes.
- CanvasItem-derived hosts add lightMask (20 bits). PointLight2D adds enabled,
  itemCullMask, shadowItemCullMask, blendMode (0..2), shadowColor and bounded
  height. LightOccluder2D adds occluderLightMask. DirectionalLight2D shares the
  relevant native Light2D fields, adds maxDistance (0..100000) and height (0..1),
  and requires no point-light texture. Per-light masks and per-occluder masks are
  distinct native filters. JSON resources accept
  `{type:'OccluderPolygon2D',points:[{x,y},...],closed:true,cullMode:0}`;
  polygons contain 3..256 points (open polylines 2..256), closed polygons must be
  simple, and cullMode is 0..2. The matching Godot text resource subset accepts
  polygon/closed/cull_mode. No arbitrary renderer/server handles are exposed.
- StandardMaterial3D JSON/text resources add uv1_scale and uv1_offset (finite
  Vector3 components ±10000), texture_filter (0..5), texture_repeat (boolean),
  cull_mode (0..2), and metallic_texture_channel/roughness_texture_channel/
  ao_texture_channel (0..4: red, green, blue, alpha, gray). These reuse registered
  static textures and immutable material graphs. UV scale may be negative for
  mirroring or zero to collapse an axis. Enum sentinels/fractional values and
  oversized UV components fail before native loading. GeometryInstance3D global
  transparency and visibility transparency fades require Forward+ and remain
  outside the Compatibility profile.

Run `pnpm test:showcase:native -- --details` and
`pnpm --filter @godot-js/playground test:browser:details` after rebuilding the
native editor and Web template. The browser gate checks actual tile/Label pixels,
point/directional light and shadow mask switching, material UV/repeat/filter/
culling and packed AO channel pixels in development → production → development,
plus Stop file/host/asset/event cleanup. The native gate also checks invalid
command ranges/targets, native material-property roundtrips and physical GridMap
collision filtering.


## Shape contacts, input lifecycle, scrolling and avoidance precision

Import [precision-engine.project.json](examples/precision-engine.project.json),
with [TSX source](examples/precision-engine.tsx). Regenerate it with
`python3 scripts/prepare-precision-example.py`.

- Curve points accept `leftTangent`/`rightTangent` in `-4096..4096` and
  `leftMode`/`rightMode` (`0` free, `1` linear). A supplied tangent defaults its
  mode to free; otherwise the segment remains linear. Optional `minValue` and
  `maxValue` lie within `-4096..4096` and must increase. Existing normalized x,
  y `-64..64`, point-count and bake-resolution bounds still apply. JSON and native
  text resources preserve tangents and limits. Gradient accepts
  `interpolationColorSpace` (`0` sRGB, `1` linear sRGB, `2` Oklab), also imported
  from native `interpolation_color_space`.
- Area2D/3D and RigidBody2D/3D expose `onBodyShapeEntered/Exited`; areas also
  expose `onAreaShapeEntered/Exited`. Their frozen `ShapeContact` contains
  `collider`, `colliderShapeIndex`, `localShapeIndex`, `colliderShape` and
  `localShape`. Public nodes in the same Root become managed handles; unavailable
  or external nodes become null. No RID or native instance ID is exposed.
  Rigid bodies require `contactMonitor` and sufficient `maxContactsReported`.
  Collision bodies expose physics-phase `getShapeOwner(index)`; RayCast2D/3D
  expose `getColliderShape()` and `getColliderShapeOwner()`. Indices are snapshots
  of native shape ordering, not persistent IDs; removed handles become invalid.
  Owner lookup returns null for unavailable shapes, bounds indices to `0..65535`
  and uses a 4096-shape lookup budget.
- Button, CheckBox, OptionButton and TextureButton expose `onButtonDown/Up`,
  `actionMode` (`0` press, `1` release), `buttonMask` (`0..7`, left/right/middle
  bits) and `keepPressedOutside`. OptionButton retains Godot's press default;
  others default to release. Normal activation emits down → pressed → up.
  In press mode activation happens on down. `keepPressedOutside` preserves the
  held drawing state outside the control; releasing outside still cancels normal
  release-mode activation. Process getters `getDrawMode()` and `isHovered()`
  report native state. Mouse, keyboard and touch retain native behavior.
- ScrollContainer adds `scrollDeadzone` (`0..4096`), horizontal/verticalCustomStep
  (`-1..4096`) and process-phase `ensureControlVisible(handle)`, a `scroll` write
  requiring matching hook writes and `engineOwned`. Targets must be managed
  descendant Controls in the same Root. `onScrollStarted/Ended` follow Godot's
  touch-drag lifecycle; wheel and programmatic scrolling do not synthesize them.
- NavigationAgent3D adds `height` (`.01..10000`), `pathHeightOffset`
  (`-10000..10000`), `use3dAvoidance` and `keepYVelocity`. Height controls overlap
  in planar avoidance; 3D avoidance considers the vertical velocity. Path height
  offset shifts returned path positions. Both agents expose physics-phase
  `setVelocityForced(vector)` as an `avoidanceVelocity` write, with component
  magnitude at most one million. After teleporting the owning body, use it to
  synchronize the avoidance simulation, then continue regular `setVelocity`
  updates. It does not move the body.

Run `pnpm test:showcase:native -- --precision` and
`pnpm --filter @godot-js/playground test:browser:precision` after rebuilding the
engine and frontend. The browser gate checks rendered free-curve/three-color-space
pixels, compound 2D/3D shape contacts and owner removal, ray shape indices,
press/release timing, keyboard, right-mask input, held-outside drawing, touch
activation/scrolling and navigation behavior. It covers development, production,
then development again, verifying Stop releases Root and resource state each time.


## UI layout, animation sections, cameras, generated textures and drawing fidelity

Import [fidelity-engine.project.json](examples/fidelity-engine.project.json), with
[TSX source](examples/fidelity-engine.tsx). Regenerate it with
`python3 scripts/prepare-fidelity-example.py`.

- Every exposed Control descendant inherits `clipContents`, `layoutDirection`
  (`0` inherited, `1` application locale, `2` LTR, `3` RTL, `4` system locale),
  and `sizeFlagsStretchRatio` (`.001..1024`). ScrollContainer preserves its native
  clipping default of true; other Controls default to false. `onResized` and
  `onMinimumSizeChanged` have no arguments. A signal emitted synchronously by its
  own React property setter is suppressed; native container/deferred size
  notifications are delivered. Callbacks should update state only when needed.
  Child position/size still belongs to its native Container.
- AnimationPlayer adds process-phase `playSection(name,start,end,blend,speed,fromEnd)`,
  `playSectionBackwards(name,start,end,blend)` and `resetSection()` as `playback`
  writes. Use the existing hook writes and `engineOwned` declarations. Names must
  identify a registered clip and times satisfy `0 <= start < end <= clip.length`
  (at most 600 seconds); blend is `-1..60`, speed is `-16..16`. Read-only process
  commands are `hasSection`, `getSectionStartTime`, `getSectionEndTime` and
  `getCurrentAnimationLength`. `onCurrentAnimationChanged(name)` follows native
  behavior, including the empty name when stopped. Replaying the same clip can
  retain its position; call `stop(false)` before starting a fresh reverse section.
- Camera2D adds `ignoreRotation` (native default true), `limitEnabled` (true),
  `limitSmoothed` (false) and `anchorMode` (`0` fixed top-left, `1` drag center).
  `align()` is a process-phase `cameraSmoothing` write. Read-only process getters
  expose `getScreenCenterPosition`, `getTargetPosition` and `isCurrent`.
  Rotation smoothing takes effect with `ignoreRotation=false`; limit smoothing
  requires position smoothing. `resetSmoothing` immediately applies the limits.
  Camera3D adds read-only process `projectPosition(screenPoint,depth)` and
  `projectLocalRayNormal(screenPoint)`. Depth must be positive and at most one
  million; projection coordinates have component magnitude at most one million.
- Structured resources and bounded Godot text import support GradientTexture2D:
  `gradient`, `width`/`height` (`1..1024`), `fill` (`0` linear, `1` radial, `2`
  square), `fillFrom`/`fillTo` (components `-16..16`), `repeat` (`0` none, `1`
  repeat, `2` mirrored) and `useHdr`. Every existing static texture consumer accepts
  it. Generated 2D gradient and bitmap bytes share an 8 MB budget with decoded
  project media; HDR uses native RGBA32F accounting, 16 bytes per pixel.
- TextureButton adds `textureClickMask: AssetRef<'BitMap'>`. A BitMap resource
  accepts `{type:'BitMap', image:'/assets/button.png', alphaThreshold:.1}`, or
  `{type:'BitMap', width, height, data:[packed bytes]}`. Dimensions are `1..1024`;
  data has exactly `ceil(width*height/8)` bytes with zero unused padding. Native
  bit order is least-significant bit first, row-major; alpha must be strictly
  greater than the threshold, using Godot's float32 threshold precision. Godot text `data = {"size":Vector2i(...),
  "data":PackedByteArray(...)}` imports under the existing text value budgets.
  The parser bounds dictionaries to 128 unique safe string keys, rejects byte
  overflow, and retains its depth/count limits. Scaled button mask coordinates
  and transparent clicks follow native TextureButton behavior.
- CPUParticles2D/3D adds `angle`, `radialAccel`, `tangentialAccel`, `orbitVelocity`
  and `hueVariation` Min/Max/Curve fields, plus `colorInitialRamp`. Curves reference
  Curve; the initial ramp references Gradient. Angles lie in `-3600..3600`, radial
  and tangential acceleration in `-10000..10000`, orbit in `-1000..1000`, hue in
  `-1..1`, and each minimum must not exceed its maximum. GPU ParticleProcessMaterial
  adds the corresponding native fields and references CurveTexture and
  GradientTexture1D, preserving per-node material isolation. Existing particle,
  curve, resource-graph and lifetime budgets continue to apply.
- NavigationAgent2D/3D adds `pathSearchMaxDistance` and `pathReturnMaxRadius`
  (`0..1000000`, zero disables the respective distance/radius constraint), plus
  `pathSearchMaxPolygons` (`1..4096`). The polygon search bound cannot be disabled.
  `isTargetReached()` is a read-only physics command. A search-budget/distance
  cutoff can return a partial path toward the target; a return-radius limit clips
  the resulting path. Neither implies the agent has reached its requested target.
- Polygon2D adds `vertexColors`, `offset`, `textureOffset`, `textureRotation`,
  `textureScale`, `invertEnabled` and `invertBorder`. Color arrays are immutable,
  contain at most 256 entries and cannot exceed the polygon vertex count; omitted
  vertex colors follow native fallback behavior. RGB is `0..16`, alpha `0..1`;
  offsets/scale components have magnitude at most 10000, scale components must be
  nonzero, rotation is `-10000..10000`, and invert border is `0..10000`. Line2D
  adds `sharpLimit` (`0..128`) and `roundPrecision` (`1..64`).

Run `pnpm test:showcase:native -- --fidelity` and
`pnpm --filter @godot-js/playground test:browser:fidelity` after rebuilding the
engine and frontend. The comprehensive project checks 44 behaviors, including
clipped/gradient/particle/polygon pixels, actual scaled mask input, RTL/stretch
layout and bounded size notifications, forward/reverse animation sections,
camera rendering and projection, bounded 2D/3D path search and arrival. Browser
coverage runs development, production, then development, verifying Root/resource
cleanup after every Stop. Native tests also reject invalid sections, projection
depths, wrong phases and disabled/excessive search budgets, and verify generated
mask bits, imported gradient fields and particle material resources directly.


## Rich text, complete ranges, grouping, viewport modes and spatial audio

Import [usability-engine.project.json](examples/usability-engine.project.json),
with [TSX source](examples/usability-engine.tsx). Regenerate it with
`python3 scripts/prepare-usability-example.py`.

- RichTextLabel inherits Control layout/focus/clipping and exposes `text`,
  `bbcodeEnabled`, `fitContent`, scrolling/following, selection, wrapping,
  alignment and character reveal. Text has at most 128000 Unicode codepoints,
  4096 tags and 32 nested levels. Supported tags are b/i/u/s/code,
  left/center/right/fill, hexadecimal color/bgcolor, font_size (1..256),
  url with bounded string metadata, and lb/rb/br. URL metadata is delivered as
  strings through onMetaClicked/onMetaHoverStarted/onMetaHoverEnded.
  Text and parsing mode update atomically when both change.
- Rich text font resources use the existing registered FontFile capabilities:
  font/fontSize apply to the normal style; boldFont, italicsFont,
  boldItalicsFont and monoFont have corresponding optional Size properties.
  Each font size is 1..256. FontColor maps to the native default color.
  Registered images use process `addImage(texture,width,height)` (1..4096,
  at most 64 images per content reset). Resource-loading markup is outside the
  supported tag set. Process commands setText/appendText/clear/addImage are
  `richText` writes; selectAll/deselect are `selection` writes; scrollToLine is
  a `richScroll` write; setVisibleRatio is a `textReveal` write. Hook writes and
  engineOwned must match. Getters expose parsed/selected text, character/line/
  paragraph counts and content size; private scrollbar/menu nodes remain private.
- VSlider, HScrollBar and VScrollBar complete the numeric control family.
  All numeric controls add page, rounded, expEdit, allowGreater, allowLesser
  and onRangeChanged. Bounds/value magnitude remains at most one billion;
  page must lie in 0..(max-min), and positive step must be at least 1e-9.
  Rounded half values follow native rounding away from zero. Without allowGreater,
  the upper value is max-page; without allowLesser, the lower value is min.
  `getRatio()` reads native normalized state; `setRatio(0..1)` is a process
  `value` write sharing `range.value` ownership. Exponential mode requires
  nonnegative min and increasing positive logarithmic bounds (min=0 requires
  max>1). Scrollbar scrolling events and slider drag events retain native behavior.
- LineEdit adds clearButtonEnabled, rightIcon, alignment, selectingEnabled,
  keepEditingOnTextSubmit and onEditingToggled(boolean). Process edit/unedit are
  focus writes and isEditing is read-only. SpinBox adds prefix (at most 256
  characters), selectAllOnFocus and updateOnTextChanged. ProgressBar adds native
  indeterminate rendering. Numeric step, echo suppression and controlled values
  continue to share existing range ownership.
- CanvasGroup inherits Node2D and composites its children as one group. It adds
  clearMargin/fitMargin (0..1024) and useMipmaps. Use selfModulate for group
  opacity, which applies after overlapping children are composed. The Web renderer
  allocates a level-zero backbuffer for small viewports too; the 64×32 regression
  target covers the original GLES3 allocation guard. Native ordering, texture/filter inheritance
  and appearance Tweens remain available.
- SubViewport adds renderTargetClearMode (0 always, 1 never, 2 next frame),
  size2dOverride (integer components 0..4096; a zero component disables the
  override), and size2dOverrideStretch. Physical texture size still follows
  existing viewport/container ownership. Process setClearMode is a
  renderTargetClear write. Native containers handle logical-to-display input.
- Audio players expose playbackType (0 default, 1 native stream, 2 Web sample).
  Select stream for native DSP/reverb and bus-peak meters; the regression project
  uses this mode to measure actual mixing. Spatial players add 32-bit areaMask; AudioStreamPlayer3D adds emission-angle
  enable/degrees (0..90), outside-angle attenuation (-80..0 dB), distance-filter
  cutoff (20..20500 Hz) and attenuation (-80..0 dB). Area2D/3D adds
  audioBusName/audioBusOverride; Area3D also adds reverbBusName, enable, amount
  and uniformity (0..1). Names must be Master or a bus registered in the same
  Root. Private physical bus names from another Root are rejected. Imported
  scenes preserve logical bus metadata, which native prefab preparation remaps
  into the current Root before attachment. Existing getBusPeaks meters verify
  actual routes, reverb sends and area-mask fallback in the browser.
- StandardMaterial3D JSON/text resources add alpha_scissor_threshold (0..1),
  alpha_hash_scale (0..2), depth_draw_mode (0..2), no_depth_test, billboard_mode
  (0..3) and billboard_keep_scale. Resource graph and texture budgets remain
  unchanged. Native text import supports explicit theme/audio aliases and
  bounded StringName literals; scene scripts are not executed.

Run `pnpm test:showcase:native -- --usability` and
`pnpm --filter @godot-js/playground test:browser:usability` after rebuilding the
engine and frontend. The project checks 38 behaviors: rich text/selection/reveal/
registered images and metadata, mode changes, native numeric semantics and actual
control input, group opacity, retained rendering/one-frame clear/logical input,
spatial bus peaks including private prefab routes and mask fallback, and material
alpha/hash/depth/billboard pixels. The Web build backports Godot's existing RD
Alpha Hash function and object-space discard to GLES3 and repairs small canvas
backbuffer allocation via `scripts/patch-web-renderer.py`. It checks all source
anchors before writing and is idempotent. Browser coverage runs development, production,
then development with verified Stop cleanup. Automatic compilation preserves the
editor focus; explicit Run and its keyboard shortcut can focus the preview if the
user has not moved elsewhere while compilation runs. The native probe checks unsupported
markup, invalid ranges/phases, scoped bus isolation and material import fields.

## Multiline editing, lists, split/flow layout and scene visibility

Import [composition-engine.project.json](examples/composition-engine.project.json),
with [TSX source](examples/composition-engine.tsx). Regenerate the project with
`python3 scripts/prepare-composition-example.py`.

- TextEdit adds native multiline editing, wrapping, read-only/placeholder state,
  caret blinking, scrolling and current-line highlighting. It defaults to native
  keyboard focus and an I-beam cursor. Text is limited to 65536 Unicode codepoints;
  placeholders to 1024 UTF-16 code units. The native text-changed guard also trims
  excessive user edits. Truncation uses native set_text and resets undo history.
  Process setText/insertTextAtCaret/undo/redo write `text` and
  `selection`; select/selectAll/deselect/setCaretPosition write `selection`.
  Coordinates are native line/codepoint-column indices, checked against actual
  line lengths. Getters expose line counts/text, caret position, selected text and
  undo/redo availability. Native onTextChanged has no arguments; onCaretChanged
  and onLinesEdited retain native semantics. Private menus, scrollbars and timers
  remain private. Browser tests exercise real typing, undo/redo and one more key
  after the text reaches its limit.
- ItemList accepts at most 1024 strings or `{text,icon?,disabled?,selectable?,metadata?}`
  objects. Labels are at most 256 codepoints; metadata is a string of at most 256
  UTF-16 code units. Icons must be shared registered static Texture2D resources.
  `selectMode` supports native single/multi/toggle modes; selectedItems and
  select/deselect/deselectAll share `listSelection` ownership. Selection indices
  must be unique, in range, selectable and enabled. Replacing items retains still
  valid selection indices. Layout options include columns, icon size/scale,
  text lines and auto-height. Item-selected, multi-selected, clicked and activated
  events use primitive values. Getters expose selected indices, item count, text,
  string metadata and item rectangles without native child handles.
- HSplitContainer/VSplitContainer reuse managed Container layout, adding
  splitOffset, collapsed, draggerVisibility, draggingEnabled and touchDraggerEnabled.
  A process setSplitOffset command writes `split`; onDragged/onDragStarted/
  onDragEnded follow native events. Offsets are bounded to ±1000000 pixels.
  HFlowContainer/VFlowContainer expose alignment, lastWrapAlignment, reverseFill
  and getLineCount. Children inherit existing layout/transform ownership rules,
  so native resizing and automatic wrapping cannot conflict with controlled size.
- TabContainer adds alignment, top/bottom placement, clipping and minimum-size
  options. Process setTabTitle/setTabIcon/setTabDisabled/setTabHidden share
  `tabMetadata` ownership; hiding a tab additionally writes `tab`. Titles are at most 256 codepoints, icons are registered
  textures, and every index is checked against the current child tabs. Read-only
  title/state/rectangle queries and clicked/selected/hovered events supplement
  existing native selection. Browser coverage checks disabled and hidden tabs,
  enables a page and removes the selected page.
- CanvasItem hosts expose a 32-bit visibilityLayer, independently of lightMask.
  SubViewport exposes the matching canvasCullMask. Native ancestor-layer rules
  apply: a visible child does not bypass an ancestor excluded by the viewport.
  The example renders independent filtered views and changes an ancestor layer.
- Resource JSON and Godot text import support Sky, ProceduralSkyMaterial and
  PanoramaSkyMaterial. Sky materials and panorama/cover textures reference
  registered resource graph entries. Radiance sizes are 32, 64 or 128; the plan
  reserves a conservative total 16 MiB for the two cubemaps and mip levels per
  sky. Environment adds sky/rotation/custom FOV, sky ambient contribution,
  fog_mode, depth begin/end/curve, height/density, aerial perspective, sky affect
  and sun scatter. Existing basic fog/color/exposure properties remain available.
  Fog end must be zero or at least begin. This uses the GLES3 sky and ordinary
  fog paths. The regression checks procedural sky color, panorama rotation and
  depth/height fog using actual viewport pixels.
- GeometryInstance3D hosts add visibilityRangeBegin/End and corresponding margins
  plus extraCullMargin. End zero disables the far limit; otherwise end must be
  at least begin. Distances are 0..1000000; margins are 0..100000. Native hard
  range switching and hysteresis are used. The example crosses both limits and
  enters/exits the hysteresis interval to verify retained visibility state.
  Geometry-wide transparency and range fading are outside this GLES3 contract.

Native UI scene imports preserve multiline text, bounded item fields and registered
icons. Engine-created internal split draggers and tab bars are validated only
under their native parents; they are not public hosts or accessible capabilities.
The native gate checks scene round trips, invalid phases, invalid selection and
text, private-host rejection, and reflected-mutation rejection.

Run `pnpm test:showcase:native -- --composition` and
`pnpm --filter @godot-js/playground test:browser:composition` after rebuilding.
The browser checks 40 behaviors in development, production, then development,
including actual keyboard/mouse input, native pixels, and verified Stop cleanup.

## Native UI layout, texture skins, state playback and editor workflows

Import [workflows-engine.project.json](examples/workflows-engine.project.json),
with [TSX source](examples/workflows-engine.tsx). Regenerate it with
`python3 scripts/prepare-workflows-example.py`.

This extension adds `MenuButton`, `CheckButton`, `HSeparator`, `VSeparator` and
`CodeEdit`. See the refinements section below for current profile totals.

- Native UI text scenes accept `layout_mode`, `anchors_preset` (`-1..15`),
  `anchor_left/top/right/bottom`, `offset_left/top/right/bottom`, and
  `grow_horizontal/vertical` (`0` begin, `1` end, `2` both). Import normalizes
  anchors and offsets into `initial.layout`, including nested scene overrides;
  Container children retain native layout ownership. Preset hints normalize to
  anchors and growth, and explicit geometry takes precedence. Anchors must be
  ordered in `0..1`; offsets remain bounded to ±1,000,000. The native setter now
  pushes the opposite anchor while applying an interval, preserving right and
  center anchors instead of clamping them against a previous value. The native
  gate saves a real PackedScene with Godot, reimports it, then checks both React
  and native instance geometry.
- Every existing StyleBoxFlat slot also accepts `StyleBoxTexture` and
  `StyleBoxEmpty`, including panels, button states and the new separators.
  StyleBoxTexture supports a shared registered static texture, bounded region,
  texture/expand/content margins, stretch modes, center drawing and modulation.
  Texture/expand margins are `0..4096`, content margins are `-1..4096`, and axis
  stretch modes are `0..2`. Empty styles retain content margins without drawing.
- Node2D and Node3D hosts expose `topLevel`, sharing their existing transform
  ownership group. CanvasItem hosts expose `showBehindParent`. These use native
  hierarchy semantics, with independent world-coordinate and overlap-pixel
  checks.
- AnimationTree adds process commands `stopState(path)`, `nextState(path)`,
  `isStatePlaying(path)`, `getStatePosition(path)`, `getStateLength(path)`,
  `getFadingFromState(path)`, `getFadingPosition(path)`, `getFadingLength(path)`
  and `getTravelPath(path)`. Paths are bounded `parameters/.../playback` strings,
  including `parameters/playback` and nested machine paths. Mutations require
  `playback` ownership; queries return immutable scalars or arrays. State-machine
  resource transitions accept a simple named `condition`, used with `auto: true`
  and existing `setParameterBoolean('parameters/conditions/name', value)`.
  Expressions and scripts remain outside this resource format.
- TileMapLayer adds `getPattern(cells)`, `mapPattern(origin, cell, pattern)`,
  `setPattern(origin, pattern)` and `setCellsTerrainPath(path, set, terrain,
  ignoreEmpty)`. Patterns are immutable arrays of
  `[x,y,source,atlasX,atlasY,alternative]`, containing at most 4,096 unique cells;
  pattern coordinates are `0..4095`. Native TileMapPattern objects stay private.
  Source/atlas/alternative IDs are checked against the actual TileSet before
  mutation. Terrain paths contain at most 4,096 adjacent cells and require valid
  terrain IDs (`-1` erases terrain); cells and their affected neighborhood stay
  within the map bounds. Mutations require `cells` ownership and conservatively
  reserve against the existing 65,536-cell budget. Terrain matching still needs
  a TileSet with the appropriate peering patterns, as in Godot.
- MenuButton `items` are objects with `text`, optional stable `id`, registered
  static `icon`, `disabled`, `checkable`, `checked` and `separator`. At most 256
  items are allowed, IDs are unique `0..65535` (defaulting to the item index), and
  labels contain at most 256 Unicode codepoints. Native menu fields import and
  export with integer `checkable` enums. `onIdPressed(id)` delivers the selected
  ID from the private PopupMenu. `setMenuItemChecked(id, value)` and
  `setMenuItemDisabled(id, value)` require `menuState` ownership; use
  `initial.items` with `engineOwned={['menuState']}` for imperative state.
  `isMenuItemChecked(id)`, `isMenuOpen()` and `getMenuRect()` are read-only.
  PopupMenu handles are not exposed. Removing or stopping the owning MenuButton
  disconnects its private emitter. CheckButton reuses button toggle/focus events;
  separators accept `separatorStyle`.
- CodeEdit inherits bounded TextEdit commands, text/selection ownership and its
  65,536-codepoint input guard. It adds `drawLineNumbers`, `indentSize` (`1..16`),
  `indentUseSpaces`, `indentAutomatic`, `braceCompletionEnabled` and
  `syntaxHighlighter`. `indentLines()` and `unindentLines()` require both text
  and selection ownership. CodeHighlighter resources support number, symbol,
  function and member colors; up to 256 keyword colors, 256 member keywords and
  32 symbol-delimited color regions. Keyword identifiers are at most 64 ASCII
  characters; region delimiters are at most 32 characters each. Each editor,
  including imported native instances, receives its own highlighter copy so
  native TextEdit bindings and caches cannot cross between editors.

Run `pnpm test:showcase:native -- --workflows` and
`pnpm --filter @godot-js/playground test:browser:workflows` after rebuilding the
native engine, Web template and frontend. The project checks 37 behaviors. The
browser gate exercises actual menu mouse/keyboard selection and disabled items,
CheckButton mouse/Space toggles, CodeEdit brace completion/indentation/undo-redo,
button hover/press pixels, nine-patch corners, separators, independent syntax
colors, canvas draw order and tile pixels. It stops with a menu open and verifies
zero remaining host/asset/event records and removal of generated files, in
development, production, then development mode.

## Instance data, canvas masks, flipbooks, maps and editor refinements

Import [refinements-engine.project.json](examples/refinements-engine.project.json)
([source](examples/refinements-engine.tsx)); regenerate it with
`python3 scripts/prepare-refinements-example.py`. The showcase now exposes 117
hosts, 3,889 declared properties (3,772 mutable plus 117 construction names), and
369 signals.

- MultiMesh resources accept `customData`, `visibleCount` (`-1` means all), and
  `customAabb`. Both instance hosts expose visible-count, per-instance custom
  data/color readback, and instance-bound commands. Mutations reserve `instances`.
  Each node, including native scene instances, receives its own MultiMesh copy;
  source resources and sibling buffers stay independent. A Root has a 32 MiB
  instance-buffer budget, including colors/custom data and detached owned nodes.
  Custom-data components are finite and bounded to the half-float range ±65,504.
- CPUParticles2D adds animation speed/offset min/max and Curve resources.
  ParticleProcessMaterial accepts corresponding GPU parameters and CurveTexture
  resources. CanvasItemMaterial accepts `particles_animation`, horizontal/vertical
  frames, and looping. Each dimension is 1..256, with at most 4,096 sheet frames;
  speed is 0..1,000 and offset 0..1. These use native particle simulation and
  shader frame selection. The example verifies repeated frames within one
  particle lifetime for CPU and GPU particles.
- CanvasItem hosts expose `useParentMaterial` and `clipChildren` (0 disabled,
  1 clip only, 2 clip and draw). Alpha comes from the native mask drawing.
  Nested masks and combining a mask with CanvasGroup ancestry are rejected
  before attachment/property mutation. CanvasLayer and SubViewport boundaries
  start a separate clipping scope. CanvasGroup retains its own native behavior.
- TileMapLayer adds `enabled`, `occlusionEnabled`, `ySortOrigin`,
  `xDrawOrderReversed`, `useKinematicBodies`, and rendering/physics quadrant
  sizes (1..256). `updateInternals()` reserves `cells`. TileSet resources may
  specify `textureRegionSize` independently of logical `tileSize`, and registered
  NavigationPolygon references per tile. Atlas regions must fit the image.
  The example checks actual enable/disable pixels, collision and navigation
  removal/restoration, moved collision, and overlapping X/Y draw order.
- Path2D/3D expose baked length, point/transform sampling, and closest
  point/offset queries through bounded DTOs. Queries run in the process phase.
  Curves contain 2..4,096 control points; coordinates are bounded to ±1,000,000,
  bake intervals to 0.001..1,000. Sampling offsets and nearest-point coordinates
  are bounded to ±1,000,000; valid offsets clamp to the baked length.
  Conservative control-polygon estimates reject
  more than 65,536 baked points per curve before native allocation; aggregate
  estimated curve caches are limited to 16 MiB. Degenerate curves return stable
  native positions and identity orientation.
- GeometryInstance3D hosts add `materialOverlay` and `customAabb`.
  `setOverlayShaderParameter()` reserves `overlayParameters`; overlay shader
  copies are private to each node, including native scenes. Bounds use finite
  position/size vectors bounded to ±1,000,000 with nonnegative size. A zero box
  restores native automatic bounds. Forward+-only transparency and visibility
  fading remain outside this Web Compatibility renderer contract.
- TextEdit/CodeEdit add minimap width (8..256)/drawing and bounded native search/highlight
  (`searchText`, `searchFlags`, `search()` and `getTextRect()`). Search strings
  contain at most 1,024 Unicode codepoints; flags are native bits 0..7. CodeEdit
  adds native folding, bookmark/breakpoint/executing gutters, marker queries and
  `onBreakpointToggled`. Folding reserves `folding`, `selection`, `textScroll`;
  marker writes reserve `lineMarkers`, with at most 4,096 returned markers.
  Native typing migrates markers with their lines. Runtime search highlights
  are editor state and are not persisted into authored scene resources.
- RichTextLabel accepts bounded `[table=columns]`, `[cell]`, `[ul]`, `[ol]`,
  `[indent]`, and `[hint=text]` tags. Tables have 1..16 columns and at most 1,024
  cells; nested tables and non-cell table content are rejected. Existing text,
  tag and nesting budgets still apply. Hint text is limited to 256 codepoints;
  `getHintAt(localPoint)` uses native tooltip hit testing.

Run `pnpm test:showcase:native -- --refinements` and
`pnpm --filter @godot-js/playground test:browser:refinements` after rebuilding
both engine variants and the frontend. The browser gate checks 51 behaviors in
**development → production → development**, including real gutter clicks,
folding, search input, native typing, pixels and tooltip creation, then verifies
zero remaining owned nodes/assets/events and removal of generated files.
Headless Dummy rendering cannot retain per-instance GPU data or produce pixels;
those assertions run against actual WebGL instead.

The Web engine build applies `scripts/patch-native-tooltips.py` to the pinned
Godot source. Apply the same script before custom native builds. It marks the
Viewport-created tooltip PopupPanel as an internal child, preserving strict
public-node ownership checks while allowing native tooltip creation and cleanup.
