# Project tools

`@godot-js/project-tools` owns the shared, browser-neutral project emitter, native
UID cache handling, module paths, scene-text parser, source maps and PCK writer.
Its neutral entries have no React, Godot runtime, DOM host or filesystem imports.
Node filesystem integration has a separate entry. TypeScript and esbuild are tool
dependencies; bundler execution is injected.

`createSourceSnapshot` → `createBuildPlan` → `prepareBuildPlan` → `packBuildPlan`
keeps source bytes separate from the artifact overlay. Overlay records include
input/output hashes and why a file changed. A plan's `inputs` must include the
actual engine/optional extension identity, tool/options/resolution identities and
resource conversion inputs used by its caller. UI revisions are not content
identity. Pack hashes remain in the outer receipt, avoiding self-referential IDs.

The internal source snapshot is version 2. It owns typed bytes within one build;
`SourceFile.bytes` and public file-map reads return isolated `Uint8Array` copies.
The emitter, overlay and PCK writer reuse private owned bytes, including through
React startup adapters. `snapshotFiles()` and the project-document writer are
explicit JSON boundaries and retain legacy `number[]` serialization. Changing
the in-memory representation does not migrate stored projects or change the
path/encoding/content inputs of `sourceHash`. PCK layout and byte budgets are
checked before file copies and final allocation; directory hashes cover each
view's exact byte range.

Schema 4 has a single engine runtime and an explicit scene or script launch.
`readProjectDocument` adapts schemas 1–3 without writing them. The writer accepts
only explicit schema 4 documents; existing editor storage continues using its
existing schema until migration is deliberately enabled. Legacy React requires
an explicit preparation adapter from `@godot-js/react-build/core`.

Import receipts are created only after successful conversions. Their source and
dependency hashes, parameters, converter version, target resource ABI/features,
and output hashes determine freshness. Scanning legacy imported bytes does not
create proof of a converter run: missing receipts remain `unverified`.

The old `@godot-js/react-build` helper subpaths re-export this implementation.
Framework-specific bootstrap/registry code remains in that compatibility package.

`resource-formats` records native API routes separately from ResourceLoader and
browser producer support. TSCN/TRES load natively with their dependencies.
PNG/JPEG can use native Image APIs or the registered RGBA browser converter;
WAV has a PCM8/16 mono/stereo converter. SVG, GLTF/GLB and OGG have native API
routes recorded, but no generic browser ResourceLoader converter. Blender,
FBX and other editor producers remain separate format-specific work.

Schema 4 can opt into `resourceImports: [{resource: "res://audio/tone.wav",
converter: "godotjs/wav-pcm"}]`. `prepareBuildPlan` requires an executable
`resourceConverters` registry and an actual engine `resourceTarget`. It places
the generated TRES and `.import` remap in the artifact overlay, preserves source
bytes/UIDs, and attaches converter receipts to the outer artifact receipt.
The PNG/JPEG converter accepts an injected decoder with an explicit identity;
the converter captures its identity and decode function when created, so replacing
fields on the registration object cannot change an existing converter. Stateful
decoders retain their receiver and own the versioning of internal mutable state.
The product compiler provides createImageBitmap/OffscreenCanvas in its Worker.
Only mipmaps=false is supported; editor compression/resampling presets fail
explicitly. A registry reexecutes imported receipt claims before trusting them;
only outputs it has executed itself can be reused after all current input,
parameter, dependency, target and output hashes match. Unknown cached producers
remain unverified, and changed cached contents require reimport.

Image and WAV producers use the native Godot 4.6.1
`PackedByteArray("base64...")` text-resource encoding, retaining `ImageTexture`
and `AudioStreamWAV` types. Encoding writes ASCII directly to the TRES buffer
without spreading pixels into JavaScript arrays. `resourceLimits` bounds generated
bytes and decoded pixels; `packBuildPlan` also applies the requested PCK limit.
A 2048² RGBA payload becomes approximately 21.3 MiB before the other project
files and PCK overhead. A 4096² RGBA payload still exceeds the default 64 MiB
encoded budget and is rejected. This is not a compressed-resource importer.

Converter versions and receipts change with the encoding. Existing source and
unknown imported caches are preserved. If an older receipt identifies a previous
output that remains alongside the new output, preparation reports
`W_RESOURCE_PREVIOUS_OUTPUT_RETAINED`; those bytes still count toward the PCK
budget. Native headless loading verifies the generated resource format, while
real browser decoding, rendering and audio remain separate checks.

## Shared compiler and Node adapter

`compiler-policy` defines `godotjs-engine-compiler/1`. The same policy derives the
checking and native CommonJS emit options; checking deliberately uses `noEmit`
and retains source extensions. `createProjectTypeEnvironment` provides an owned
virtual declaration/module view for both compiler checks and editor language
services. It never reads host `node_modules`, Node ambient types or system libs.

`createCompilerEnvironment` captures declarations, module routes, runtime modules
and vendor bytes before hashing them. Its identity includes their actual content,
the TypeScript/policy version and the adapter-validated target. `compileBuildPlan`
owns preparation, overlay verification, PCK and artifact receipt generation.
`compileProject` checks that same plan's source snapshot before building. Existing
`BuildPlan.compatibility` remains intact: old Node classes keep their constructor
bootstrap, and old component documents use an explicitly supplied current React
startup adapter. The neutral compiler imports no React or application code.

The Node entry and `godotjs` CLI require Node.js 22.14.0 or later, including
`node:module.findPackageJSON()` for import-only startup adapter resolution.
Repository builds and CI use Node.js 24 or later.

The separate `@godot-js/project-tools/node` entry reads local files and a matching
`engine-release.json`, validates descriptor and asset bytes, then calls the shared
compiler. The `godotjs` command supports:

```sh
godotjs check --project project.json --release /path/to/engine-release.json
godotjs build --project /path/to/native-project --release /path/to/engine-release.json --output work/game.pck
godotjs export-pck --project /path/to/native-project --entry src/start.ts --release /path/to/engine-release.json --output work/script.pck
```

A project input can be a Schema 1–4 JSON document or a directory. Directory inputs
use the configured main scene unless `--entry` (ordinary `start(ctx)`) or
`--main-scene` is supplied. Source resources, import sidecars and imported caches
are retained; editor state, generated GodotJS outputs, `.git`, `node_modules`,
toolchain assets and the selected output are excluded. Symlink inputs fail
explicitly. Build/export writes the PCK and its adjacent `.receipt.json` and
`.manifest.json`, including the matched target IDs and final pack hash. Browser
transport still supplies its own pinned site/release context when launching it.

Old React component documents need the optional matching React build adapter;
it can be resolved from the project or passed as `--startup-adapter MODULE`.
Native projects do not load the React vendor. The Node entry supplies the PCM WAV
producer. Image conversion requires an explicitly supplied decoder through the
shared API; Node does not claim the browser decoder's identity or silently use
another producer. Same-target parity requires matching declaration/runtime bytes,
resolution, startup adapter, resource producer and PCK options.

The Playground uses the same type environment and artifact facade. Its editor
completion/hover protocol remains application-owned. Persisted document formats
and default new-project selection are unchanged by compiler extraction.
