# Project tools

`@godot-js/project-tools` owns the shared, browser-neutral project emitter, native
UID cache handling, module paths, scene-text parser, source maps and PCK writer.
It has no React, Godot runtime, DOM or filesystem imports. TypeScript and esbuild
are tool dependencies; bundler execution is injected.

`createSourceSnapshot` → `createBuildPlan` → `prepareBuildPlan` → `packBuildPlan`
keeps source bytes separate from the artifact overlay. Overlay records include
input/output hashes and why a file changed. A plan's `inputs` must include the
actual engine/optional extension identity, tool/options/resolution identities and
resource conversion inputs used by its caller. UI revisions are not content
identity. Pack hashes remain in the outer receipt, avoiding self-referential IDs.

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
the product compiler provides createImageBitmap/OffscreenCanvas in its Worker.
Only mipmaps=false is supported; editor compression/resampling presets fail
explicitly. A registry reexecutes imported receipt claims before trusting them;
only outputs it has executed itself can be reused after all current input,
parameter, dependency, target and output hashes match. Unknown cached producers
remain unverified, and changed cached contents require reimport.
