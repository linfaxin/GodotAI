<p align="center">
<picture>
  <source media="(min-width: 720px)" srcset="docs/header.svg">
  <img src="docs/header-mobile.svg" width="900" height="330" alt="GodotJS Logo">
</picture>
</p>

# **GodotJS**

<p align="center">
  TypeScript/JavaScript support for Godot 4.x, including the browser's JavaScript runtime and a complete Godot Web engine.
</p>

<p align="center">
    <a href="https://github.com/godotjs/GodotJS/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License"></a>
</p>

## Documentation

For full documentation, visit [godotjs.github.io](https://godotjs.github.io/documentation/getting-started/).

The [engine goals and platform boundaries](docs/engine-goals.zh-CN.md) define the AI game creation platform use case, engine responsibilities and reusable integration contracts.
The [reviewed runtime properties and Summer API plan V2](docs/design/runtime-properties-and-summer-api-v2.zh-CN.md) defines typed exported scalar access, the Summer operation subset, implementation contracts, parallel work packages and real Playground validation gates.
The [next-stage proposal](docs/engine-next-stage.zh-CN.md) prioritizes independent platform integration, runtime observation and interaction, with concrete acceptance criteria.
The [minimum engine contracts and core regression plan V4](docs/design/engine-minimum-contracts-v4.zh-CN.md) defines the engine prerequisites for adding the Playground AI assistant. The [implementation and integration record](docs/engine-minimum-contracts-delivery.zh-CN.md) documents the completed SDK/Playground/Node integration and passing core regression scope.

For the React / TSX renderer and scene migration workflow, see the [React / TSX guide](docs/react-tsx.zh-CN.md).
The [implementation and support matrix](docs/react-tsx-implementation.zh-CN.md) lists the available profiles and their limits.
The [browser Worker engine guide](docs/browser-worker-engine.zh-CN.md) describes the complete-engine Worker candidate, neutral engine/project tools, compatibility paths, HTTPS isolation and activation gates. React is an optional reactive syntax layer over the same engine.

## Repository development

This repository uses a pnpm workspace for embedded engine scripts and ecosystem packages. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and build commands, [the architecture guide](docs/architecture.md) for module boundaries, and [packages/README.md](packages/README.md) for package conventions.

Run the relevant checks locally when contributing. CI is no longer needed for this repository. [Local verification policy](CONTRIBUTING.md#local-verification)

The [TSX package](packages/tsx/README.md) currently contains a private buildable foundation, separate from the existing React renderer. The [playground](apps/playground/README.md) provides a static Monaco workbench, browser TSX compilation and isolated Godot WASM execution with fixed built-in dependencies.

---

See [Breaking Changes](https://godotjs.github.io/misc/breaking-changes/) if upgrading from old versions.

> [!NOTE]
> The core functionality is implemented and essentially usable but still under testing.

![typescript_intellisence](https://godotjs.github.io/images/typescript_intellisence.png)

## Features

- [x] Godot ScriptLanguage integration
- [x] Debug with Chrome/VSCode (with v8) and Safari (with JavaScriptCore)
- [x] REPL in Editor
- [x] Hot-reloading
- [x] Support for multiple javascript engines ([v8](https://github.com/v8/v8), [quickjs](https://github.com/bellard/quickjs), [quickjs-ng](https://github.com/quickjs-ng/quickjs), [JavaScriptCore](https://developer.apple.com/documentation/javascriptcore), the host Browser JS)
- [x] [Worker threads](https://godotjs.github.io/documentation/experimental/worker/) (limited support) (**experimental**)
- [x] Asynchronously loaded modules (limited support) (_temporarily only available in v8.impl, quickjs.impl_)

## Examples

The default Playground in [`apps/playground`](apps/playground) contains eight interactive Godot showcase demos in the original IDE layout. Its build uses a matching GodotJS editor and Web template; see its README for commands.

The native Playground runs Godot, GodotJS and scene React together in an ordinary Worker using transferable ArrayBuffers. Normal build/dev/test commands use Worker; legacy preview pages, build/dev commands and execution switches have been removed. Both 2D and full profiles support direct presentation by default and explicit bitmap presentation. Browser compatibility, capability and performance evidence still gate publication; see the [Worker delivery contract](docs/browser-worker-runtime.zh-CN.md).

The browser SDK conformance workbench is also available in that directory for local browser and release verification. It builds separately with `pnpm --filter @godot-js/playground build:conformance` into `dist-conformance/`.
It compiles and type-checks projects in browser Workers and runs the generated
PCK in actual Godot WASM. See the [implementation and local verification guide](docs/browser-playground.zh-CN.md)
and [engine release workflow](scripts/release/README.web.md).

For more information on how to use `GodotJS` in a project, check out [GodotJSExample](https://github.com/ialex32x/GodotJSExample.git) for examples written in typescript.  
**And, don't forget to run `npm install` and `npx tsc` before opening the example project.**

[![Example: Snake](https://godotjs.github.io/images/snake_01.gif)](https://github.com/ialex32x/GodotJSExample.git)
[![Example: Jummpy Bird](https://godotjs.github.io/images/jumpybird.gif)](https://github.com/ialex32x/GodotJSExample.git)
