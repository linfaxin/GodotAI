# GodotAI Playground

A static Monaco workbench that compiles and type-checks editable TSX projects in the browser, creates Godot PCK artifacts and runs the real single-threaded WASM engine in an isolated preview. It requires no runtime Node.js server or WebContainers.

The default project is an interactive mining outpost. Other examples cover crew composition, pixel textures, real 2D physics, a basic counter and type diagnostics. Ordinary page loads, restored projects, example switching, resets and imports run automatically; shared links initially require a manual run.

React, the Godot SDK, scheduler and clsx are fixed built-ins shown in a read-only panel. Projects do not expose a dependency manifest or install npm packages at runtime. Assets, the compiler and matching declarations can all be served locally.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build:playground
```

This builds the UI and workspace dependencies. Use `pnpm browser:engine` and `pnpm browser:prepare` to prepare a runnable site with matching engine/release assets; `pnpm playground:serve` then serves the editor and separate preview origin. Engine preparation and deployment are documented in the [implementation guide](../../docs/browser-playground.zh-CN.md) and [Web release guide](../../scripts/release/README.web.md).

Supported profiles are `core-ui-v1`, `ui-media-v1` and `behavior-physics-v1`. The media and physics extensions each include core UI and remain separate capability sets. Full arbitrary Godot scene/script imports and audible output are outside the current supported surface.

See the [repository architecture](../../docs/architecture.md) for build boundaries and the [browser library](../../scripts/jsb.react-browser/README.md) for compiler, asset and runner contracts.
