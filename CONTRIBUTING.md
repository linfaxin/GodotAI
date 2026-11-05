# Contributing

## Installation

- Clone the source code of [godot](https://github.com/godotengine/godot):
    - `git clone git@github.com:godotengine/godot.git` or
    - `git clone https://github.com/godotengine/godot.git`
- This branch uses version `4.5` so checkout the version with: `git checkout 4.5`
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

## Pre-release as maintainer

If you want to create a pre-release to test build targets you need to [draft a new release](https://github.com/godotjs/GodotJS/releases/new):

- Create a new tag like `v1.2.3-test-xyz` and use the same name for the release title.
- Next you can select a target branch - you don't have to pick `main`.
- Make sure to check the `Set as a pre-release` checkbox.
- Release notes are optional

![Overview how to create pre release](docs/create-pre-release.png)
