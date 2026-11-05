# Browser TSX preflight

This probe compiles editable TSX in a browser Worker with `esbuild-wasm`, fetches
one pinned npm package (`clsx@2.1.1`) from jsDelivr, and mounts the result through
the real GodotJS React adapter in a single-thread Godot Web build. It uses no
WebContainers and no runtime compilation server.

`prepare.mjs` is **development-time packaging**: Node builds the SDK vendor
bundle once and copies static files. Engine compilation likewise happens before
deployment. After preparation, any ordinary static HTTP server can serve the
probe. `serve.mjs` provides only GET/HEAD file responses and deliberately omits
COOP/COEP headers.

## Prepare

From the repository root:

```sh
pnpm build
GODOT_SOURCE=/path/to/godot \
GODOT_WEB_TEMPLATE=/path/to/godot.web.template_debug.wasm32.nothreads.zip \
node tests/browser-preflight/prepare.mjs /path/to/site
```

Build Godot 4.6.1 with this module, Emscripten 4.0.11, `platform=web`,
`target=template_debug`, `threads=no`, `dlink_enabled=no`, `skip_js_runtime=yes`,
and the default browser JS backend (no QuickJS/V8). Enable GodotJS, regex,
FreeType, and the fallback text server; retain the GLES3 renderer. Preparation
extracts the engine and audio worklets using `unzip`. Alternatively copy those
four files from the template into `site/assets/` yourself.
`GODOT_SOURCE` supplies the build's version headers; the manifest remains
explicitly uncertified (`sourceCommit: "unknown"`). This probe does not grant
release/export certification.

```sh
node tests/browser-preflight/serve.mjs /path/to/site 8080
```

Open the printed URL and click **Run**. `esbuild-wasm@0.25.12` and `clsx@2.1.1`
are fetched by the browser from jsDelivr over HTTPS. `spark-md5@3.0.2` computes
the PCK directory's MD5 records; manifest integrity still uses SHA-256.
There is no general package resolver yet. The `?local=1` diagnostic mode expects `assets/esbuild-browser.js`
and `assets/esbuild.wasm`, but still fetches clsx from jsDelivr; it is not an
offline mode.

## Verify

Install `playwright-core@1.56.1` in a scratch tools directory and provide its
`index.mjs` path. Chromium must already be installed; the runner uses software
WebGL in headless mode.

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
CHROMIUM=/usr/bin/chromium \
node tests/browser-preflight/verify.mjs /path/to/site /path/to/results
```

If the environment requires an outbound HTTP proxy, set `BROWSER_PROXY`.
The runner disables Playwright's forced proxying of loopback so the local static
server stays local. TLS verification remains enabled.

The report requires a real structured SDK BootReport, native Label reads after
canvas clicks (0→1 and, after editing, 10→11), distinct generations, clean engine
exits, browser compiler diagnostics, source map generation, CDN package input,
sealed-module tamper rejection, no server-provided PCK requests, and
`crossOriginIsolated === false`. Logs, static/network requests, screenshots
and artifact hashes are retained. A Node/mock renderer is not substituted for
the native integration.

## Scope

- Production-mode `core-ui-v1`, dummy audio/physics, one TSX entry and one pinned single-file npm
  package. SDK/React/JSX imports share one canonical vendor runtime.
- Uses the existing genuine NativeScript bootstrap, native generation/manifest
  checks, SDK contracts and artifact hash checks. No native checks are disabled.
- Project files, fresh manifests and a PCK v3 are generated in the browser and
  preloaded through `Engine.preloadFile`. Standard Web templates reject `--path`;
  this uses their supported `--main-pack` entry instead. No server pack builder,
  local Godot process or export command is needed at runtime.
- Each Run creates a fresh iframe/engine after requesting the previous engine's
  exit. This is full restart, without state-preserving HMR.
- Not yet covered: complete TypeScript semantic checking, a virtual multi-file
  author project, general npm resolution, arbitrary resource imports/templates,
  persistent projects, untrusted-code isolation, other browsers, or production
  engine/profile certification. Generated source maps do not by themselves prove
  runtime exception mapping.

After rebuilding the engine with the current Web bridge and preparing the site,
the separate intentional-error fixture checks real native formatting for normal,
compressed first-line CommonJS, and uncaught TSX errors:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
CHROMIUM=/usr/bin/chromium \
ENGINE_BUILD_REPORT=/path/to/engine-build-report.json \
node tests/browser-preflight/verify-source-maps.mjs /path/to/site /path/to/map-results
```

Its `report.json` records raw and mapped stacks, the exact expected
`res://src/SourceMapProbe.tsx:5:11` location, engine hashes, and exit codes. With
`ENGINE_BUILD_REPORT`, it requires a successful build and verifies that both
prepared engine files match that report's archive before launching Chromium.
All three fixtures must exit cleanly with code 0. The intentional uncaught case
additionally requires the native module-load failure log and the exact mapped
location; it is separate from an application's successful boot. This fixture is independent of
the successful application BootReport gate and does not certify another backend.

The probe explicitly selects dummy audio and physics: it does not test those
subsystems. In particular, immediate startup-failure shutdown exposed an
upstream WebAudio worklet initialization/teardown race with the default audio
driver. That remains outside this UI-only gate.
