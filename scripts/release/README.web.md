# Browser engine release workflow

Node.js is a build/CI tool here. The resulting Playground is static and performs
compilation, type checking and PCK generation in the browser.

The root scripts provide the same entry points used by CI:

```sh
pnpm test:browser:unit
pnpm browser:prepare --engine-report /artifacts/browser-engine-report.json --out /artifacts/playground
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM=/path/to/chromium pnpm test:browser:real --site /artifacts/playground --out /artifacts/browser-results
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM=/path/to/chromium pnpm test:browser:real --authenticated-gate --site /artifacts/playground --out /artifacts/authenticated-results
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM=/path/to/chromium pnpm test:browser:stress --site /artifacts/playground --out /artifacts/browser-stress --iterations 100 --failures 20
```

`test:browser:unit` checks the bridge, compiler/resolver/types/runner contracts,
release integrity and a real external npm-pack consumer. `test:browser:real`
launches actual WASM from two local origins and records the actual on-disk hashes
of all release files and static preview/worker templates. It additionally checks
browser-generated source maps against their manifest hashes. The stress command
reuses a compiled artifact for 100 actual engine lifetimes, checks native label
behavior after a code edit, then exercises failed compilation and startup
cancellation. Its heap/DOM samples cover the parent page; they do not certify a
zero-leak native allocator. The CI workflow pins and installs Playwright and its
Chromium, so it does not depend on a developer's global browser tool directory.

Build from real source trees in an independent directory. Build the workspace
first so the bridge's generated JavaScript is present. Source commits, actual
copied input hashes, tool versions, the executed SCons recipe, generated version
header and resulting archive bytes are recorded together:

```sh
export PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs
export CHROMIUM=/path/to/chromium
pnpm build
node scripts/test/build-browser-engine.mjs --godot-source /path/to/godot --build-dir /independent/browser-build --out /artifacts/browser-engine-report.json --target template_debug
node scripts/test/prepare-browser-playground.mjs --engine-report /artifacts/browser-engine-report.json --out /artifacts/playground
node scripts/test/browser-playground.mjs --site /artifacts/playground --out /artifacts/browser-results
node scripts/test/browser-playground.mjs --authenticated-gate --site /artifacts/playground --out /artifacts/authenticated-results
node scripts/test/browser-stress.mjs --site /artifacts/playground --out /artifacts/browser-stress --iterations 100 --failures 20
GODOT_SOURCE=/independent/browser-build GODOT_WEB_TEMPLATE=/independent/browser-build/bin/godot.web.template_debug.wasm32.nothreads.zip node tests/browser-preflight/prepare.mjs /artifacts/native-site
ENGINE_BUILD_REPORT=/artifacts/browser-engine-report.json node tests/browser-preflight/verify-source-maps.mjs /artifacts/native-site /artifacts/native-source-maps
node scripts/release/collect-browser-evidence.mjs --site /artifacts/playground --engine-report /artifacts/browser-engine-report.json --integration /artifacts/browser-results/report.json --authenticated-report /artifacts/authenticated-results/report.json --stress /artifacts/browser-stress/report.json --source-maps /artifacts/native-source-maps/report.json --out /artifacts/acceptance.json
node scripts/release/build-web-release.mjs --engine-report /artifacts/browser-engine-report.json --assets /artifacts/playground/release-assets.json --out scripts/jsb.web-engine/dist --validation-report /artifacts/acceptance.json --version 0.1.0
node scripts/release/pin-web-release.mjs --site /artifacts/playground --release scripts/jsb.web-engine/dist
node scripts/release/verify-web-release.mjs --dir scripts/jsb.web-engine/dist --require-certified --pack-out /artifacts/npm --report /artifacts/pack-report.json
```

The assets JSON uses paths relative to that JSON file:

```json
{
  "sdk": {"development": "sdk/development.js", "production": "sdk/production.js"},
  "contracts": "contracts.mjs",
  "bootstrap": "bootstrap.json",
  "types": "types",
  "compiler": {"js": "compiler/esbuild-browser.js", "wasm": "compiler/esbuild.wasm", "typescript": "compiler/typescript.js"},
  "metadata": {
    "runtimeAbi": "godot-react/1",
    "nativeBridgeAbi": "godot-react-native/1",
    "react": {"react": "19.3.1", "reconciler": "0.34.0", "scheduler": "0.28.0"},
    "profiles": [{"id": "core-ui-v1", "version": 1, "hash": "actual-schema-hash"}],
    "specifiers": {}
  }
}
```

The type mirror input contains `node_modules/@godot-js/react/package.json` and its
declarations, `node_modules/@types/react`, `node_modules/csstype`, and
`typescript/lib`. Each release file has its own SHA-256; each type file additionally
has a virtual path beginning with `/`. TypeScript's UMD source is preserved and
also wrapped as an ESM asset with `export default ts`.

Declaration and package-metadata files are served as `types/<path-sha256>.txt`.
Their `virtualPath` retains the original npm/TypeScript layout. Do not put
`node_modules` directories in deployed static URLs: hosting asset pipelines may
filter them even when they are present in the source commit and upload archive.

The engine WASM is distributed as `assets/godot.wasm.gz`, compressed at build
time. Its file SHA-256 binds the gzip bytes; `decodedSha256` and `decodedBytes`
bind the original WebAssembly module. The browser verifies both and decompresses
with a bounded stream before using Godot's loader. It does not rely on hosting
rewriting `Content-Encoding`. `--raw-wasm` is available only with `--development`.

`sourceCertified` requires identified Git source trees and a successful actual
build. `certified` additionally requires a passing validation report matching
the exact `runtimeRelease` and binding every non-attestation release asset hash.
This also prevents an unchanged file list from reusing evidence after profile,
ABI, target or other descriptor metadata changes. The checks and their scope remain in
the descriptor: a Chromium/Dummy UI certification does not imply audio, physics
or other browser support. Certification evidence can be attached to the same
immutable byte identity after testing; it does not silently change those bytes.
The static application additionally pins the full final descriptor SHA-256 so
that the certification label and its evidence cannot be altered independently.
The PWA and AudioWorklet lifecycle patches are applied before hashing and their
identifiers and original/resulting hashes remain in the recipe and descriptor.
The evidence collector checks that integration and lifecycle reports name the
same runtime release and static templates. The native source-map probe must bind
the actual archive, raw WASM, recorded JS-glue transforms, source snapshots and
build recipe; caught, compressed-first-line and uncaught errors must all map
correctly. Specialist report hashes are retained in the aggregate certificate.
Keep the prepared site unchanged until these checks finish, then attach
certification and repin it. If preparing a version other than `0.1.0`, pass that
same `--version` to both preparation and final release construction.
The optional `--authenticated-report` additionally binds a synthetic HttpOnly
cookie gate: same-origin release/compiler/engine assets receive their session
cookie, while a separate-origin CDN request omits it. This fixture provides no
credentials or bypass for a hosted private Site, and its same-site topology does
not add an iframe preemption guarantee.

For an existing local template, record it honestly and pass `--development` to
both preparation and release construction. It can be packed and tested but
cannot be officially published:

```sh
node scripts/test/build-browser-engine.mjs --existing-template /path/to/template.zip --development --godot-version 4.6.1.stable.custom_build --target template_debug --out /artifacts/development-engine.json
node scripts/test/prepare-browser-playground.mjs --engine-report /artifacts/development-engine.json --out /artifacts/playground --development
```

Publication is separate from candidate creation and CI does not publish PR
code. It needs a publish-capable npm identity from the usual npm configuration
or environment. No token is printed. The command validates and packs first,
checks `npm whoami`, rejects an existing exact version, actually runs
`npm publish`, then downloads the exact version from jsDelivr and verifies every
file. A registry or CDN failure exits nonzero and preserves a truthful report,
including whether the irreversible npm publication already succeeded:

```sh
node scripts/release/publish-web-release.mjs --dir scripts/jsb.web-engine/dist --report /artifacts/publish-report.json --tag next
```

If the npm upload succeeds but CDN propagation fails, the report records
`published: true, cdnVerified: false`. Do not upload the same version again;
verify that exact version's bytes after propagation. Public sharing additionally
depends on the Playground's cross-origin preview gate, independently of engine
audio or physics certification.

```sh
node scripts/release/verify-web-release.mjs --dir scripts/jsb.web-engine/dist --require-certified --cdn-base https://cdn.jsdelivr.net/npm/@godot-js/web-engine@0.1.0/dist/
```
