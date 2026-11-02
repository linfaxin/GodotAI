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
| `apps/` | Application consumers; currently only the playground README |
| `configs/tsconfig/` | Shared checks for new TypeScript packages |
| `tests/project/` | Independent GodotJS consumer used by engine integration tests |

The active workspace contains the root orchestration package, the three embedded-script packages, the existing React renderer and build-tool packages, and `packages/tsx`. The workspace also reserves `apps/*`; a README-only directory does not become a package.

## Build boundaries

Install dependencies explicitly from the GodotJS module root, using the Node.js and pnpm versions declared by the repository:

```sh
pnpm install --frozen-lockfile
```

| Command | Responsibility |
| --- | --- |
| `pnpm build:engine-js` | Build only `@godot-js/jsb-runtime`, `@godot-js/jsb-editor`, and `@godot-js/web-bridge` |
| `pnpm build:packages` | Build packages selected by their `packages/` location and the two existing React packages |
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

New reusable libraries belong in `packages/`, and applications consume those libraries. The existing `@godot-js/react` and `@godot-js/react-build` packages stay under `scripts/` and are explicitly included in the ecosystem build. Libraries do not depend on application code. Declare package dependencies with `workspace:*` and use package entry points rather than imports into another package's source directory.

GodotJS provides modules such as `godot`, `godot-jsb`, `godot.lib.api`, and `godot.annotations` inside the engine. Future ecosystem code must use the intended host API and preserve required host modules as external references when bundling. It must not install the private embedded packages as substitute runtimes.

Do not create empty renderer, reactivity, compiler, resolver, or type packages solely to reserve names. Extract an additional package when it has a concrete responsibility and consumer. See [package conventions](../packages/README.md).

## TypeScript and declarations

The shared base config contains only common checks. Each package chooses its module format, resolution, target, libraries, ambient types, and output directory. Existing internal configs remain unchanged.

The current TSX foundation emits CommonJS and declarations to `packages/tsx/dist/`. It has no JSX runtime or scene API yet and does not replace the implemented React renderer. Additional entry points and formats should be introduced with their implementations and consumer verification, rather than exposed as empty compatibility promises.

Keep Node tools, browser applications, and Godot user programs in distinct type environments. In particular, do not inherit the internal runtime's Node ambient types into every ecosystem package.

`scripts/typings/godot.generated.d.ts` is an in-repository compilation placeholder. Full Godot declarations are generated by an editor build for a target project. Future type distribution must separate engine API snapshots from project-specific scene, autoload, and resource declarations, and identify the matching engine and binding profile. The runtime naming proxy does not by itself establish declaration compatibility across profiles.

## Validation and release boundaries

`tests/project` remains outside the workspace and retains its own lockfile. The existing runtime matrix installs it with `--ignore-workspace`; this preserves its role as an independent consumer.

The current foundation is verified through embedded-script builds, the ecosystem build and type check, and package-entry checks. Before public package releases, add isolated tarball consumers to verify declarations, exports, dependencies, and supported hosts. Workspace source resolution alone is not publication verification.

The root package version continues to drive the existing engine version header and GitHub release flow. Private foundations are excluded from Changesets release planning. Public ecosystem packages will need independent semver and npm publication checks when enabled; do not repurpose the engine release predicate for them.

## Deferred application work

The [playground README](../apps/playground/README.md) records its goal and validation questions. There is no application package, browser SDK, compiler worker, CDN resolver, runner, bootstrap project, or engine asset distribution implementation in this architecture foundation.
