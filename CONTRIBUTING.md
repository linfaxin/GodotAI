# Contributing

## Framework development stage and reviews

The React/browser Worker framework and its Playground have yet to launch. The architecture is changing frequently during this phase.

> 方案设计和实现以可维护性为优先。按当前需求划分模块职责和接口，避免过度细分边界而增加系统复杂度和维护成本。

Apply this review standard until the framework explicitly enters stabilization or the user changes these priorities:

- Prioritize core flows such as build, startup, rendering, input, stop/restart and error isolation. Review execution ownership, module responsibilities and the cost of further refactoring.
- Introduce module boundaries, abstractions and compatibility layers where current requirements justify their cost. Let internal structure and interfaces evolve, updating their callers and relevant checks together.
- Run validation proportional to the change. Rare edge cases, exhaustive browser/device matrices, strict performance budgets and release-evidence hardening can follow once the affected design settles; they are not prerequisites for every framework iteration.
- Keep known gaps and deferred work visible. Defer nonblocking acceptance-tool issues without declaring them fixed or marking unverified behavior as passed.

Problems that break ordinary development or core execution, corrupt data, or undermine the chosen architecture still need to be addressed promptly.

## Local verification

This repository uses local verification. Continuous integration (CI) is unnecessary for future work. Keep build and test commands runnable locally and leave CI workflows and required CI status checks out of the contribution process. Run the checks relevant to your change and include the results in the PR.

## Installation

- Clone the source code of [godot](https://github.com/godotengine/godot):
    - `git clone git@github.com:godotengine/godot.git` or
    - `git clone https://github.com/godotengine/godot.git`
- The browser engine recipes target Godot `4.6.1-stable`; use the source revision recorded in the candidate's build report. See the [Worker build guide](docs/browser-worker-engine.zh-CN.md) for its fixed Web toolchain and independent build directory.
- Clone this module and put it into `godot/modules/GodotJS`:
    - `git clone git@github.com:godotjs/GodotJS.git godot/modules/GodotJS` or
    - `git clone https://github.com/godotjs/GodotJS.git godot/modules/GodotJS`
- Use the Node.js version in `.node-version` and the pnpm version declared in `package.json`. From `godot/modules/GodotJS`, prepare JavaScript dependencies explicitly:

    ```sh
    pnpm install --frozen-lockfile
    pnpm build:engine-js
    ```

- [Recompile the godot engine](https://docs.godotengine.org/en/4.4/development/compiling/index.html)
    - Windows: `scons platform=windows`
    - MacOS: `scons platform=macos arch=arm64`

### Hints

- To enable unit tests you need to add `tests=true` to `scons` arguments
- To debug C++ code in [CLion](https://docs.godotengine.org/en/4.4/contributing/development/configuring_an_ide/clion.html#importing-the-project) you might need to add `compiledb=yes` to `scons` arguments once

SCons invokes `pnpm build:engine-js` when `skip_js_runtime` is disabled. It does not install dependencies or build ecosystem packages. To consume previously built or downloaded embedded scripts, use `skip_js_runtime=yes`; the files must still be present in `scripts/out` and, for the browser backend, `impl/web/js`.

## JavaScript workspace commands

Run these commands from the GodotJS module directory:

| Command | Scope |
| --- | --- |
| `pnpm build:engine-js` | The existing `jsb.runtime`, `jsb.editor`, and `web-bridge` packages |
| `pnpm build:packages` | Ecosystem packages in `packages/` plus React, Node and browser build tools |
| `pnpm build:playground` | Static Playground and its workspace dependencies; engine assets are prepared separately |
| `pnpm typecheck:packages` | Type-check ecosystem packages without emitting files |
| `pnpm build` | Build embedded scripts, then ecosystem packages |
| `pnpm test` | The existing engine runtime matrix; requires its Godot build environment |
| `pnpm test:react` | React renderer contracts and build-tool tests |
| `pnpm test:engine` | Neutral engine and project-tools packages |
| `pnpm test:project /path/to/godot` | Generate types and run the native smoke project with a local Godot build |
| `pnpm test:playground` | Playground type checks and tests |
| `pnpm test:browser:unit` | Bridge, browser SDK, execution identities, release and evidence validators |
| `pnpm browser:engine:worker` | Build the opt-in complete-engine `proxy-pthread` candidate |
| `pnpm test:browser:worker --engine-report /path/report.json --out /path/results` | Real isolated HTTPS Worker runtime probe; requires a prepared Web toolchain and browser |

The [architecture guide](docs/architecture.md) explains the build and dependency boundaries. Follow [the package conventions](packages/README.md) when adding an ecosystem package. `tests/project` remains outside the workspace; install its dependencies with `pnpm -C tests/project install --ignore-workspace` when following the engine test workflow.

## Project Structure

```
┗━ godot
    ┗━ modules
        ┣━ ...
        ┣━ gltf
        ┣━ GodotJS
        ┃    ┣━ bridge
        ┃    ┣━ apps
        ┃    ┣━ compat
        ┃    ┣━ configs
        ┃    ┣━ docs
        ┃    ┣━ impl
        ┃    ┣━ internal
        ┃    ┣━ lws
        ┃    ┣━ packages
        ┃    ┣━ quickjs
        ┃    ┣━ quickjs-ng
        ┃    ┣━ scripts
        ┃    ┣━ tests
        ┃    ┣━ v8
        ┃    ┃   ┣━ include
        ┃    ┃   ┣━ linux.x86_64.release
        ┃    ┃   ┣━ macos.arm64.release
        ┃    ┃   ┣━ windows_x86_64_release
        ┃    ┃   ┗━ ...
        ┃    ┣━ weaver
        ┃    ┗━ weaver-editor
        ┣━ gridmap
        ┣━ ...
```

## Preparing your PR

Before submitting your PR add a [Changeset](https://github.com/changesets/changesets) entry:

- From the root, run `pnpm run changeset` and follow the CLI instructions
- You can add a full description of your change in Markdown format

## Releases

Run `pnpm release:version` to apply Changesets and update the native version header. Build release targets locally and attach their verified artifacts to the [release draft](https://github.com/godotjs/GodotJS/releases/new) before publishing.

For a pre-release to test build targets:

- Create a new tag like `v1.2.3-test-xyz` and use the same name for the release title.
- Next you can select a target branch - you don't have to pick `main`.
- Make sure to check the `Set as a pre-release` checkbox.
- Release notes are optional

![Overview how to create pre release](docs/create-pre-release.png)
