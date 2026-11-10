# GodotJS React build

Full-engine Web projects use the shared `prepareEngineProject({files, runtime, ...})` API from `@godot-js/react-build/core`. It returns project bytes, a manifest and diagnostics for the browser PCK adapter or Node tooling. Native main scenes, autoloads, UID metadata and imported resource caches are preserved; the browser does not run Godot editor importers.

The commands and managed-entry policies documented below describe the legacy React CLI pipeline. Its unmanaged-main-scene and business-autoload restrictions do not apply to full-engine projects prepared through the shared core API.

`@godot-js/react-build` compiles ordinary React TSX components into a single canonical React runtime, application modules, genuine entry/native interface scripts, resource hubs and a sealed manifest. Godot editor/export integration consumes the manifest. Application modules never receive fake `.ts` files.

```js
// godot-react.config.mjs
export default {
  entries: {
    app: { module: "src/App.tsx", props: {}, startupAssets: ["marker"] },
    preview: "src/Preview.tsx",
  },
  templates: { panel: "templates/Panel.tscn" },
  assets: { marker: { source: "assets/marker.tres", type: "Resource" } },
  godot: "/path/to/current/godot",
  nativeReport: "/path/to/react-native-build.json", // required for source-certified export if not auto-discovered
  profileId: "core-ui-v1",
};
```

```sh
godot-react setup --project path/to/project
godot-react check --project path/to/project
godot-react build --project path/to/project
godot-react watch --project path/to/project
godot-react watch --project path/to/project --entry app --headless
godot-react preview --project path/to/project --entry preview
godot-react preview --project path/to/project --entry app --verify
godot-react doctor --project path/to/project
godot-react export --project path/to/project --entry app --output build/app.pck
```

`setup` enables `godotjs/react/enabled`, selects the first configured generated React entry as the main scene, generates template declarations and installs the template alias in `tsconfig.json` (JSONC is rewritten as JSON). Business autoloads and unmanaged main scenes fail the normal build/doctor policy. `watch --skip-initial` resumes observation after a synchronous editor build.

`watch --entry app` owns a preview and restarts it only after the old process has exited and the next generation is READY. A failed build leaves it stopped until a later successful edit. Plain `watch` also resumes existing SDK `preview` sessions, preserving entry and headless options. Reader leases cover the entire child lifetime, including startup and shutdown; interrupted child records remain recovery fences. External Godot/editor processes without a preview supervisor are refused with `E_RUN_ACTIVE`, rather than adopted. Stopping the watcher closes its owned previews.

Install `@types/react@19.3.0` in the consumer project. The compiler resolves this package from the application before falling back to the SDK dependency layout; published packages need no nested development `node_modules` directory.

Application and dependency module loading must use literal paths: static imports,
`import("./Scene.js")`, or `require("./model")`. Build rejects variable module names,
escaped/aliased `require`, and computed glob dispatchers with `E_DYNAMIC_MODULE`.
Use an explicit map of literal loaders when selecting modules at runtime. This
gate runs before artifacts are published; `check` remains the TypeScript check.

Import templates as ordinary components: `import Panel from "@project/react-templates/panel"`. Only preflighted format-3 text scenes and whitelisted resource types are accepted. Explicit `profile: "template-structural-v1"` expands shared-resource nested scenes and inherited property overrides into complete React host plans, with a 32-scene depth / 10,000-node limit. Default T0 rejects those inputs. An isolated minimal Godot project verifies topology, properties, owner and sibling order using SceneState; it never instantiates the scene. Scripts, connections, embedded resources, custom ownership, unsupported constructors and unsupported index reordering fail explicitly. Flat local CanvasItemMaterial/Resource assets require `templates.panel = {source: "...", profile: "template-local-v1"}` and a native bridge implementing local scopes. Nested/local combinations are rejected because they require distinct nested scene scopes. Physics hosts require explicit `profileId: "behavior-physics-v1"`.

Static per-node native interfaces use `nativeInterfaces: { actor: { version: 1, nativeLeaf: "Node", callbacks: ["_ready"], rpc: { rpcPing: { arguments: ["string"] } } } }`. The SDK token and configured schema must match. The compiler emits a real Script.ts class extending the exact native leaf, with modern Godot annotations; these classes remain separate native scripts.

Resources are copied into an immutable generation closure under `generated/react/resources/<generation>/`, with dependency paths rebased and stale UIDs removed. Manifest asset IDs stay logical; use `manifest.resources[id].uri` for native diagnostics. Runtime loading never follows the mutable author resource path. `sourceOrigins` and the source snapshot retain the author path for diagnostics and drift detection.

Publication freezes inputs, checks a full TypeScript Program (including entry props), emits immutable generation modules, imports native resources, seals the manifest, and switches `active.json` last. The portable `.publish-lock` / `run-leases/*.json` protocol prevents publication over live managed roots. Closing the running application releases its lease. `recover` handles a dead publisher; an unowned lock requires explicit `--force-unowned-lock`. Modified or missing owned artifacts fail `doctor`; recovery never silently launches a changed resource snapshot. `gc --keep 2` removes only hash-matching immutable compiler generation artifacts belonging to old sealed manifests.

Official export requires source certification, uses a selected-scenes preset containing the entry and its non-running export hub, verifies a temporary PCK from an empty directory using a structured SDK BootReport, and publishes the final output only after verification. `nativeReport` names a successful native build report; otherwise the compiler searches beside the selected binary and its parent directory. Reports must have `status: "built"`, match the binary SHA, and agree with configured source/engine/build flags. Unknown commits, placeholder hashes, missing build flags or schema digests fail with `E_NATIVE_TARGET_UNCERTIFIED`. Check/build/preview remain available for explicitly uncertified development. `--preset` selects an existing preset instead. Export holds a reader lease through verification and preset restoration. A configured `verification: {entry: "src/verify.ts"}` adds a separate business run: export `start(controller, applicationModule)` and return a Promise that rejects on failure. SDK boot verification is a framework smoke test, not business certification.

Supply `target` from the actual native build report for release certification. `engine` and `godotVersion` are queried from the selected binary's native bridge in an isolated trusted project; native commit/diff flags cannot be inferred from the application repository and remain explicitly unknown until supplied. `generatedDir` is fixed to `generated/react` by the native integration profile.

The package exports `buildProject`, `checkProject`, `doctorProject`, `generateProjectTypes`, `setupProject`, `previewProject`, `watchProject`, `exportProject` and recovery helpers. `build --wait-publisher-ms 30000` waits for a live publisher. Watch keeps pending changes when publication is busy. Forks are journaled before launch: recovery refuses a live orphan importer or an uncertain partial spawn, and a crashed exporter reader remains leased until its children have exited. An interrupted `.recovery-lock` requires inspection rather than automatic lock theft. Errors include stable `E_*` codes and CLI exits nonzero. `pnpm test` runs compiler, type-negative, publication, template and process-boundary tests; `GODOT_REACT_BIN=/path/to/godot pnpm test` also checks native template equivalence.
