# GodotJS browser playground

A static Monaco workbench with a TypeScript compiler Worker and an ordinary Dedicated Worker running Godot, GodotJS and React together. Godot 4.6.1's normal Web module set supplies engine capabilities. The main thread provides DOM/input, presentation and AudioContext/AudioWorklet hosts; transport uses transferable ArrayBuffers without SharedArrayBuffer or cross-origin isolation.

Ordinary build/dev commands and demos use Worker execution. The legacy entry has been removed. The framework is still pre-launch and its architecture is changing frequently. Prioritize maintainable designs and working core flows under the [framework development and review principles](../../CONTRIBUTING.md#framework-development-stage-and-reviews). See the [Worker runtime and delivery contract](../../docs/browser-worker-runtime.zh-CN.md) for runtime behavior and release validation.

The independently selected `proxy-pthread` candidate is documented in the [complete Worker engine guide](../../docs/browser-worker-engine.zh-CN.md); it retains its own build namespace and acceptance gates.

## Engine profiles

The default `full-engine-v1` builds all eight demos. `engine-2d-v1` uses the same native GodotJS/React runtime with 3D scenes, physics, navigation and XR disabled, and publishes Shader, Lights, Match3 and Dungeon. SDK inputs are built once; engine, resource, export and output directories are isolated per profile and target. The explicit new React project action creates a Schema 4 engine document with an ordinary `start(ctx)` entry. Existing native/component templates and bundled demos retain Schema 3; all carry their engine profile, and reading an old project does not rewrite its stored format.

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

The product compiler uses `project-tools`' shared compiler policy, owned type environment and artifact facade. Browser-specific loading and completion/hover messages stay in the workbench. The separate `godotjs` Node CLI supports `check`, `build` and `export-pck` against a matching release; it does not replace the retained legacy React CLI or conformance workbench. See [project-tools](../../packages/project-tools/README.md).

Ordinary script entries receive `ctx.lifetime` for cancellation and synchronous or asynchronous registered cleanup. Passing the captured `ctx.host` to `createRoot()` automatically registers the React root with the entry, including roots created by the new Schema 4 React template. Matching lifecycle-ABI-1 engines wait at a native pre-exit gate for tracked cleanup and actual queued deletion before native shutdown. Unfinished startup, cleanup timeout and forced termination remain explicit outcomes. Old templates do not gain this native hook from a frontend refresh.

PNG/JPEG and PCM WAV conversion retains `ImageTexture` and `AudioStreamWAV`, using native Base64 `PackedByteArray` TRES output. Internal build bytes stay in owned `Uint8Array` storage, with generated-output and PCK budgets checked before final allocation. This does not raise the editor's existing file/source limits or remove the 64 MiB runner limit. CTEX and custom compressed-resource routes are not the product resource format. See the [implementation and verification guide](../../docs/engine-evolution-implementation.zh-CN.md).

Native projects follow Godot's last-assignment rule for project settings. React replaces the launch scene with its generated bootstrap while preserving the rest of the project configuration.

Old documents retain their exact original source and attachments in migration history. Built-in demo saves from the removed renderer open the migrated React demo; the original document remains available through **Export original project**. Arbitrary old source is preserved for manual adaptation. No old renderer is selected or executed. Autosave, recovery backups and per-project tab conflict checks remain active.

During framework development, rename supports ordinary scripts and text `.tscn` scenes while preserving extensions. Resource and declaration-file renames are disabled. Unsupported references and binary native resource graphs cause rejection before any project files change.

## Agent tools

Expand **API 调用** in the sidebar to browse eleven Summer-style operations and seven GodotAI helpers. Each entry shows the API name and a one-line summary. Open an API to edit its JSON input and inspect results or PNGs alongside the live preview. Each API has its own tab, draft and result view, with shared call history. Requests use the same `window.godotPlayground` API (`schemaVersion: 1`) as external callers. Ctrl/Cmd+Enter executes the active API draft in the request editor and builds the project in the code editor.

The console retains per-operation drafts and bounded in-memory history. Loading a preset or historical request never executes it. **更新目标 / 填入上下文** uses explicit project, run, node and method selections. PNGs are separate attachments and JSON results identify binary summaries. **打开独立示例** switches to the selected sample and ends the previous preview without automatically playing it. The lesson lists cover position changes, exported gameplay properties, and registered method calls. [Console design and lifecycle rules](../../docs/design/playground-api-console.zh-CN.md)

Open **API 调试** for the existing **自动验证** replays; these retain their independent assertions and cleanup. The adjacent **API 文档** opens reference examples. Manual console calls and replays share a UI gate, while the page's Stop action remains available. Cancelling a supported request or wait does not undo an effect already performed by the game.

The runtime property workbench adds `describe_runtime_properties`, `read_runtime_properties`, `write_runtime_property` and `summer_call` to the same entry. The independent scripted sample exposes `health`, `move_step`, `can_move` and `display_name` using standard GodotJS export decorators. Its replay changes health and movement, checks actual values and PNGs, then restarts the same source to verify defaults return. Property access requires a matching Full/debug Worker Direct engine with `runtimeProperties: 1`; older write-capable templates continue to support the original position replay.

`summer_call({op, input})` accepts selected Summer 4.9.2-style inputs and returns GodotAI typed results. It supports selected context, main play/stop/state, runtime tree, native node inspection, property writes, registered method calls, game screenshots, game probes and `engine.game_input` frame scripts. Script properties use explicit typed read operations. `engine.inspect_runtime_node` uses the native observation path. Game screenshots require an explicit `target: 'game'`. See the [Input Script contract](#input-script) and the [Summer adapter and runtime property contracts](../../docs/design/runtime-properties-and-summer-api-v2.zh-CN.md).

On a Full Engine debug Worker Direct preview with `runtimeProperties: 1` and `runtimeCall: 1`, open **打开独立示例** from `engine.runtime_call` and follow **Summer：调用玩法方法** under **手工教学流程**. The sample registers `take_damage` on `/root/Main/Player` with `@bind.runtimeMethod({args: ['int'], returns: 'int'})`. Each step opens its API tab and loads a draft. When a step asks you to fill parameters from an earlier call, select the source in shared history and fill the current operation. Check the draft and then execute it. Read `health` and capture the game before and after `take_damage(25)` to verify `100 → 75`. Wait for the original run to exit. Start the same source and discover the player again to verify `100` and a full health bar in the new run.

A Console draft filled from method discovery keeps the selected instance and method token. Select a fresh discovery result after the node or registration changes. You can edit the arguments in the draft. Method requests must fit in 4 KiB of UTF-8 JSON, including the native envelope.

```js
await window.godotPlayground.summer_call({
  op: 'engine.runtime_call',
  input: {path: '/root/Main/Player', method: 'take_damage', args: [25]},
});
```

For a caller with an exact run and node instance, use `describe_runtime_methods` to obtain a method token and pass it to `call_runtime_method` with typed arguments. Tokens are scoped to the registered method, instance, run and release. If a call reports `outcome_unknown`, read the live state before deciding whether to call again. Older templates report `unsupported`. The generated `godot.annotations` declaration follows the annotation observed in the exact engine template.

### Input script

Open the `engine.game_input` example in the API console on a Chromium Full Engine debug Dedicated Worker Direct preview that advertises `inputScript: 1`. Run the lesson in order to capture the player's starting position, move it from `(64, 256)` to `(128, 256)`, and verify the starting position after Stop and Play. Each capture pairs the coordinates with a PNG from the same draw.

After each startup wait, match the receipt's `runId` to the console's main run. Continue when the pending attempt is clear and both **物理帧输入** and **游戏帧探测** show **可用**.

When the run changes, bind the lesson draft using a receipt from the new run. Filling the draft never sends input. Pausing or suspending the scene tree ends its input script, even if the project resumes during the same physics step.

```js
await window.godotPlayground.summer_call({
  op: 'engine.game_input',
  input: {
    action: 'script',
    events: [
      {type: 'action', action: 'move_right', pressed: true, at_frame: 0},
      {type: 'action', action: 'move_right', pressed: false, at_frame: 4},
    ],
  },
});
```

The subset accepts one press and release for the same registered InputMap action. The defaults are `instance: 'main'`, `clock: 'frame'`, `wait: true`, press offset `0`, and strength `1`. The release offset is greater than the press offset and at most `120`. The action is visible during eligible physics callbacks through `Input.is_action_pressed` and `Input.get_action_strength` with `exact_match: false`, and through `Input.get_axis`. Raw input, recording, replay, event callbacks and just-pressed queries are outside this subset.

Use `get_run({runId})` to read `inputScript.supported` and `inputScript.ready`. For a captured run, use `run_game_input_script({runId, actionName, pressOffset, releaseOffset, timeoutMs?}, signal?)` or `WorkerPreviewRunner.runGameInputScript(input, signal?)`. The timeout defaults to 5,000 ms and accepts integers from 1 to 30,000 ms. A completed receipt includes both native physics frames. Use the resulting `outcome` and `terminal` to distinguish a skipped request from an interruption. If the response is `outcome_unknown`, inspect the original run before deciding whether to issue another command. The existing `game_input` method on the debug API continues to accept physical gestures.

### Game probe

On a Chromium Full Engine debug Dedicated Worker Direct preview with `gameProbe: 1`, open **打开独立示例** from `engine.game_probe`. The lesson discovers `/root/Main/Player`, captures its local position and PNG together, moves the player, and repeats the capture. After stopping and restarting the same source, it captures the starting position again. Filling a draft from run history requires a separate execution action.

```js
await window.godotPlayground.summer_call({
  op: 'engine.game_probe',
  input: {
    tree: {path: '/root/Main', depth: 2, limit: 30},
    props: ['/root/Main/Player:position'],
    max_dim: 512,
  },
});
```

The PNG, tree and allowlisted native properties come from the next eligible automatic draw. The PNG and structured state share `frame.renderSerial`. Set `screenshot: false` to read state at the end of a native iteration and receive `image: null`. Supply up to 16 property queries. Tree depth ranges from 1 to 8 and node limit ranges from 1 to 500, with defaults of 2 and 200. The longest PNG dimension is capped by `max_dim`, which ranges from 16 to 1024 and defaults to 1024. A main viewport that renders directly to the screen returns `unsupported` with reason `direct_to_screen` for PNG probes.

For an exact run, use `game_probe({runId, tree?, props?, screenshot?, maxDimension?, timeoutMs?}, signal?)` or `WorkerPreviewRunner.gameProbe(input, signal?)`. Each `props` entry takes `{path, property}`. Use `get_run({runId}).result.gameProbe` to check capability and readiness. Unsupported templates return `unsupported`. Live PNG captures share one slot with ordinary screenshots and can return `busy` until the previous capture drains.

```js
const api = window.godotPlayground;
const { result: context } = api.get_project_context();
const input = { projectId: context.projectId, expectedEditorRevision: context.editorRevision };
const check = await api.check(input);
if (check.ok && check.result.status === 'completed' && check.result.diagnostics.counts.error === 0) {
  const play = api.play(input);
  if (play.ok) {
    const ready = await api.wait_for_event({ attemptId: play.result.attemptId, until: 'running' });
    if (ready.ok && ready.result.outcome === 'reached') {
      const { runId } = ready.result.run;
      console.log(api.read_run_events({ runId, kinds: ['log'] }));
      api.stop({ runId });
      console.log(await api.wait_for_event({ runId, until: 'exited' }));
    }
  }
}
```

`check` returns type diagnostics for the captured source. `get_diagnostics` reads retained results for a project revision, with optional `checkId`, `attemptId`, `runId` and `path` filters. `get_build` and `get_run` follow the exact build and session. A wait that times out can be repeated with the same ID. The run's exit includes the receipt source and the cleanup facts actually reported. See the [P0 contract and acceptance cases](../../docs/design/playground-agent-api-p0.zh-CN.md).

**试玩验证** opens a standalone sample whose script creates a `Node2D` named `Player` at runtime. With runtime observation available, it reads `Player.position`, captures the starting frame, sends one ArrowRight gesture and checks that `x` moves from 64 to 128 on the same instance. The two thumbnails show the sampled positions and the white marker at the old and new locations. Suitable older releases replay a Space gesture and verify the background changes from red to green. The Agent panel also shows the input and exit receipts. Repeated playtests reuse an unedited sample and preserve any edited copies.

`get_run({runId}).result.observation` reports runtime query support and readiness independently of `interaction`. `get_runtime_tree({runId, path?, depth?, limit?, timeoutMs?}, signal?)` starts at the actual `SceneTree` root (usually `/root`) when no path is supplied. It returns node paths, types and instance IDs, with explicit truncation when result limits are reached. `inspect_runtime_node({runId, path, properties, timeoutMs?}, signal?)` reads a `Node2D`'s local `position` and `rotation` (radians) or a `CanvasItem`'s local `visible` flag from an absolute path. Each requested property has a value or an `unavailable` reason. Missing nodes return `node_not_found`, and retained stopped runs return `run_ended`. Both queries return the full run identity, a request ID and a sample sequence. PNG captures use an independent render serial. Correlate state and image samples using their run identity.

**运行时写入验证** requires runtime write ABI 1 on a Full Engine debug Dedicated Worker Direct preview. It moves the sample's `Player` to `x=192`, checks the same instance through an independent query and compares the PNGs. It then starts the same source again, verifies that `Player` is at `x=64` and gets an exit receipt for each run.

`get_run({runId}).result.runtimeWrite` reports the write capability. Call `runtime_set({runId, path, expectedInstanceId, property: 'position', value: {x, y}, timeoutMs?}, signal?)` with the absolute path and string instance ID from a runtime query. The write targets the running `Node2D`'s local position. Read `outcome` and `observedValue` to determine the native result. If the outcome is `unconfirmed`, inspect the live node again before making another write decision. [Runtime write contract](../../docs/design/playground-runtime-set-p0.zh-CN.md)

On a Chromium Dedicated Worker Direct run of `full-engine-v1/template_debug`, `get_run({runId}).result.interaction` reports support and readiness. `screenshot({runId, timeoutMs?}, signal?)` awaits a new render submission and returns PNG bytes, run identity, render serial, and sampling geometry. A capture can return `busy` while a previous encode drains after cancellation. `game_input({runId, gesture})` assigns an operation ID to a single gesture. Use `{kind: 'key_tap', code: 'Space'}` (also supports the four arrow keys) or `{kind: 'primary_click', x, y, geometryEpoch}`, where the coordinates are normalized across the full canvas and the epoch comes from the frame. Screenshot and gesture requests for a retained ended run return `run_ended`. `wait_for_input({runId, operationId, timeoutMs}, signal?)` reads dispatch evidence for each edge. Use a zero timeout for a snapshot. Timing out or cancelling the wait leaves the input operation in place. The project effect can be checked with a subsequent capture.

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

For an already prepared resource tree, `node apps/playground/scripts/build.mjs --skip-assets` reuses the imported sources. `build:frontend` refreshes an existing release's shell and demo runtime while reusing its engine. Before changing site files or delivery variants, it checks the frozen SDK and, when `runtimeCall` is declared, the actual JavaScript and WASM against the build report. The declaration inputs must also match. Rebuild the complete release to consume a new SDK or engine.

Ordinary build/dev/test commands use Worker in `dist`, `dist-2d-debug`, `dist-2d-release` and `dist-full-release`. The `:worker` npm commands and `--worker-execution` remain aliases for the same path; no `-worker` output suffix is added. Explicit `--out`, `PLAYGROUND_DIRECTORY` and `PLAYGROUND_TEST_DIRECTORY` override locations. Frontend refresh requires an existing Worker release; rebuild an old legacy site with the ordinary build command. Shell-only test fixtures use `dist-shell`; SDK conformance retains `dist-conformance`.

The default product build reads the matching engine report produced by the Web wrapper. Artifact and build paths include profile, target, module mode, LTO and a configuration hash. Each successful engine build is retained in an immutable report-hash directory; the current report points to that archive. Use `--engine-report` for another certified build, or keep `engine-report.json` beside an explicit `GODOT_WEB_TEMPLATE`. Missing or invalid source evidence fails before resource export. An uncertified local template requires `--development` and cannot receive a site acceptance seal.

Explicit and adjacent reports both supply unspecified profile, target, LTO and module-mode defaults. Explicit CLI/environment choices remain constraints and must match the report. Published current reports can be repackaged after the original build tree is removed: compiler logs are located beside the report or its referenced immutable ZIP and verified against the recorded hash. Publication rejects output paths overlapping source reports, ZIPs, logs or immutable artifact files before creating any output.

Package a local build report with `node scripts/test/package-browser-engine-artifact.mjs --report /path/to/engine-report.json --out /path/to/browser-engine-artifact`. The portable directory contains the exact ZIP, reports, compiler log and integrity manifest. Recheck an existing portable directory with `--out /path/to/browser-engine-artifact --verify`. Run `node scripts/test/measure-browser-engine.mjs --report /path/to/browser-engine-artifact/engine-report.json --out /path/to/measurement.json` to measure it.

For Input Script builds, the linker records the exact WASM digest in the generated JavaScript. Packaging and Playground builds verify the pair and check the Emscripten initialization path to its export assignments. Each binding must map to a distinct WASM function with the expected signature. Assertion builds may install early-access placeholders before initialization. Their final wrappers must declare the matching argument count. Rebuild any local Input Script template produced before the link-digest check to generate a matching pair and report.

Releases that advertise Input Script also check the initialized module in Chromium during each production API capture. The captures record the observed ABI version and the exact JavaScript and WASM hashes. Rebuild older candidates to obtain these captures before sealing a new release.

Run browser verification locally against the exact candidate and select the relevant profile, target and presentation backend. For complete release evidence, prepare both profiles with both debug and release templates, then run both Worker presenters with default browser settings. Optional performance verification uses a separately frozen historical site as the legacy baseline for the matching profile and target. The local rollout verifier rechecks the four candidates and their capability, browser and performance evidence. [Worker verification commands](../../docs/browser-worker-runtime.zh-CN.md) · [Local verification policy](../../CONTRIBUTING.md#local-verification)

The release captures snake and camel declarations from the actual exported Web engine. Types, SDK modules, engine JavaScript/WASM and audio worklets are bound to that release. Local engine builds use the checked native patch pipeline, including the established renderer/audio/presentation fixes and the versioned Worker startup, host, audio and browser bridges. Build and acceptance consume the same native patch-file registry. Worker releases require its complete built-source proof and a fresh frozen SDK; old templates cannot acquire the ABI by adding metadata.

The WebKit patch parks the default framebuffer between engine loops and restores Godot's separate READ/DRAW bindings before the next loop. It changes the JavaScript config wrapper; each rebuild still checks the actual WASM identity. Public JavaScriptBridge callbacks remain available: real asynchronous viewport readback, ImageTexture creation and Sprite updates have been checked with resulting pixels. Host code that directly mixes raw WebGL rendering must respect ownership of the engine context. Feature acceptance rejects actual browser console errors, including WebGL validation errors; successful native assertions alone are insufficient. Reports from an earlier wrapper or candidate cannot certify a rebuilt release, even when its WASM bytes are unchanged.

## Preview deployment

Serve the editor and preview from distinct HTTP(S) origins. Set `previewOrigin` in `web/preview-config.json`, or pass `?previewOrigin=https://preview.example.com`. Localhost development can use the localhost/127.0.0.1 alias pair. The single-thread build does not require COOP/COEP.

The Worker candidate instead requires trusted HTTPS and actual cross-origin isolation at both page origins and the engine Worker, with COOP/COEP, Permissions-Policy/iframe delegation, and compatible asset CORS/CORP/CSP. Build it explicitly with `--engine-report /path/to/worker-report.json --execution-model proxy-pthread`; the full debug output is `dist-worker-full-debug/`. This separate namespace cannot overwrite the old default. A static HTTP dev server alone does not satisfy the candidate's threaded deployment contract.

Each preview verifies its engine and worklet bytes, receives the compiled project over a private MessagePort and starts a fresh Godot instance. Startup, cancellation, stop, failure and telemetry are scoped to the current run. Source maps carry native React failures back to the editor.

## Validation

The native project tests use `GODOT` or `tests/bin/godot-host-qjs`. When building that host from Godot 4.6.1, run `pnpm prepare:native --godot-source /path/to/godot-4.6.1` before SCons so the engine can drain script and React cleanup before exiting.

```sh
pnpm --filter @godot-js/playground typecheck
pnpm --filter @godot-js/playground test
pnpm --filter @godot-js/playground test:browser:react
pnpm --filter @godot-js/playground test:browser:projects
pnpm --filter @godot-js/playground test:browser
```

Browser suites cover control edits during startup, input for dynamically mounted components, native scripts importing demo helpers, the actual compiler, native and React startup, all eight demo interactions, controls and JSON export, persistence/migration, workbench layout and fresh-session stop/rerun. The older browser SDK conformance workbench remains an independent library fixture (`build:conformance`), rather than a selectable Playground runtime.

Run `test:browser:debug-api` against a matching Full Engine debug Worker site to verify the Agent API on real WASM. Set `PLAYGROUND_DEBUG_API_CASE=runtime-tree-node-and-png` to run just the runtime observation case. With `PLAYGROUND_DEBUG_API_REPORT` set, it saves the sampled PNG evidence alongside the JSON report. The full suite also reads node state with rendering paused.

`test:browser:api-console` validates the console against controlled APIs (`engineExecuted=false`). `test:browser:api-console:shell` exercises the actual main/editor integration on a separately built shell-only site. Run `test:browser:api-console:real` with `PLAYGROUND_TEST_DIRECTORY` set to a matching Full/debug Worker Direct site and `PLAYGROUND_API_CONSOLE_REAL_REPORT` set to the output JSON path for real gameplay, PNG and restart verification. The real suite requires runtimeProperties ABI 1 and records `engineExecuted=true`; the two UI suites cannot replace that evidence.

Run `test:browser:runtime-call` once per Full/debug Worker Direct candidate. Set `PLAYGROUND_TEST_DIRECTORY` and `PLAYGROUND_RUNTIME_CALL_REPORT` for each site, and set `PLAYGROUND_RUNTIME_CALL_CASE` to `supported` for ABI 1 or `unsupported` for the previous template. The new template run records the method receipt, typed property readback, before/after/restart PNGs and native exit receipts. The previous template run checks the unavailable response and confirms that no method request was sent to the Worker.

### Reproduce the Summer input demo and evidence

Use a Full Engine debug Dedicated Worker Direct site for each template. The current template advertises `gameProbe: 1` and `inputScript: 1`. The previous Game Probe template from `e80c754` advertises `gameProbe: 1`. Build both sites with the same SDK outputs from the current checkout. Keep the template archives, sites and reports in separate directories.

If the sites already exist, use their original bytes. To build new sites, verify both portable template directories first. Each contains the template ZIP, the original and portable engine reports, and the compiler log. When rebuilding a template from source, use a separate build directory outside both source trees, the Godot `4.6.1-stable` Git checkout, and Emscripten `4.0.11`. Build the previous template from the previous checkout and assemble both sites from the current checkout. Use a verified Godot 4.6.1 editor for resource preparation and export. The full resource set needs glTF and Ogg support.

Run the following commands from the repository root after `pnpm install --frozen-lockfile` and `pnpm build`. Set `COMPAT_NEW_TEMPLATE`, `COMPAT_OLD_TEMPLATE`, `COMPAT_NEW_SITE`, `COMPAT_OLD_SITE` and `COMPAT_REPORTS` to absolute paths. For site builds, also set `GODOT`, `GODOT_IMPORTER` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Keep `GODOT_WEB_TEMPLATE` unset so each build uses the ZIP named in its own report.

```sh
node scripts/test/package-browser-engine-artifact.mjs --verify --out "$COMPAT_NEW_TEMPLATE"
node scripts/test/package-browser-engine-artifact.mjs --verify --out "$COMPAT_OLD_TEMPLATE"

# With the locked JS dependencies and current SDK build available, G0 can run before the sites are built.
node apps/playground/scripts/browser-game-probe-g0.mjs --input-script \
  "$COMPAT_NEW_TEMPLATE/engine-report.json" "$COMPAT_REPORTS/g0"

# Each site build uses the current SDK and its own work directory under work/playground/.
node apps/playground/scripts/build.mjs --engine-report "$COMPAT_NEW_TEMPLATE/engine-report.json" \
  --out "$COMPAT_NEW_SITE" --skip-sdk-build
node apps/playground/scripts/build.mjs --engine-report "$COMPAT_OLD_TEMPLATE/engine-report.json" \
  --out "$COMPAT_OLD_SITE" --skip-sdk-build

node apps/playground/scripts/seal-site-acceptance.mjs "$COMPAT_NEW_SITE" "$COMPAT_REPORTS/new" --begin
PLAYGROUND_TEST_DIRECTORY="$COMPAT_NEW_SITE" \
PLAYGROUND_ACCEPTANCE_CONTEXT="$COMPAT_REPORTS/new/site-start.json" \
PLAYGROUND_INPUT_SCRIPT_REPORT="$COMPAT_REPORTS/new/report.json" \
PLAYGROUND_INPUT_SCRIPT_CASE=supported node apps/playground/scripts/browser-input-script-test.mjs

node apps/playground/scripts/seal-site-acceptance.mjs "$COMPAT_OLD_SITE" "$COMPAT_REPORTS/old" --begin
PLAYGROUND_TEST_DIRECTORY="$COMPAT_OLD_SITE" \
PLAYGROUND_ACCEPTANCE_CONTEXT="$COMPAT_REPORTS/old/site-start.json" \
PLAYGROUND_INPUT_SCRIPT_REPORT="$COMPAT_REPORTS/old/report.json" \
PLAYGROUND_INPUT_SCRIPT_CASE=unsupported node apps/playground/scripts/browser-input-script-test.mjs
```

Archive the reports outside the site, along with command logs and exit codes. G0 verifies native input and uses its own fixture release identity. Match it to the newer site with the template and engine report hashes. The site tests report the candidate and release identities, movement and restart, stale run receipts, and previous-template physical gestures. `--begin` records the input for the targeted checks. Full release acceptance uses the separate browser matrix below.

To play the archived demo, extract the new local candidate into a fresh directory, then serve the same directory twice with the product server. Use `PLAYGROUND_DIRECTORY=<absolute-site> PORT=4173 node apps/playground/scripts/serve.mjs` for the editor and the same command with `PORT=4174` for the preview. In a clean Chromium profile open `http://127.0.0.1:4173/?presentationBackend=direct&previewOrigin=http%3A%2F%2F127.0.0.1%3A4174`. Open **API 调用 → engine.game_input → 打开独立示例**, then follow **Summer：用输入验证移动**. The expected positions are `64 → 128 → 64`. The local candidate uses the root path. Candidates built with `--public-assets` use their versioned release prefix on both origins.

Use the same input cases on the pinned Summer CLI and a separately verified editor to capture the native comparison. The collector records each public CLI response, original Probe image and fixture trace. Check the actual held steps, displacement, release and reset against the Playground session. Keep each side's original frame counters and result fields. [Native fixture and collection instructions](scripts/fixtures/summer-compat/README.md)

To check an existing handoff, run the following from its directory with Node.js, Python 3 and Pillow installed. The block creates a fresh `replay` directory. To recheck an existing extraction, run the final three commands together in a shell with `set -e` enabled. The checks read the original reports and rerun the image measurement. A complete comparison includes both native `hold_ms` runs. On the Playground side, the expected result for that request is `unsupported` with zero input dispatches.

```sh
(
  set -e
  sha256sum -c SHA256SUMS
  mkdir replay
  tar -xf playground-sites.tar.gz -C replay
  tar -xf playground-templates.tar.gz -C replay
  tar -xf summer-compat-evidence.tar.gz -C replay
  node replay/verify/verify-summer-compat.mjs replay
  cmp report.json replay/verification-summary.json
  cmp replay/reports/pixels.json replay/verification-pixels.json
)
```

For a fresh capture, place the sites and templates in `sites/{new,old}` and `templates/{new,old}` under a common directory, with `COMPAT_REPORTS` pointing to its `reports/`. Collect the full native run in `reports/summer-native`. Archive the two sites, extract the archive into another directory and set `COMPAT_REPLAY_SITES` to the extracted `sites/` path. Reuse the original preflight file for each replay.

```sh
for variant in new old; do
  mode=supported
  if [ "$variant" = old ]; then mode=unsupported; fi
  PLAYGROUND_TEST_DIRECTORY="$COMPAT_REPLAY_SITES/$variant" \
  PLAYGROUND_ACCEPTANCE_CONTEXT="$COMPAT_REPORTS/$variant/site-start.json" \
  PLAYGROUND_INPUT_SCRIPT_REPORT="$COMPAT_REPORTS/replay-$variant/report.json" \
  PLAYGROUND_INPUT_SCRIPT_CASE="$mode" node apps/playground/scripts/browser-input-script-test.mjs || exit 1
done
node apps/playground/scripts/verify-summer-compat.mjs "$(dirname "$COMPAT_REPORTS")"
```

The handoff also records a separate smoke run using the archived `serve.mjs` entry point. Fresh captures show `manual.status: not_run` when that supplemental report is absent. Set `PYTHON` to select an interpreter with Pillow.

Run `PLAYGROUND_DEBUG_API_CASE=runtime-set-position` on a site with write ABI 1 and `runtime-set-unsupported` on an observation ABI 1 site with a read-only template. Set `PLAYGROUND_TEST_DIRECTORY` to the matching site for each run. The write case records the write receipt, PNGs and both exits.
`PLAYGROUND_DEBUG_API_CASE=runtime-set-boundaries` checks coordinate precision, same-origin iframe inputs and synthetic abort events on the write-capable site.

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
