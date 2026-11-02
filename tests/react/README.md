# React integration conformance

These tests use the published renderer/compiler interfaces and a Godot binary
built from an isolated snapshot of the current native sources. An existing SDK
binary with unknown source provenance is insufficient for this gate.
The `.mts` runners use Node's built-in TypeScript support (Node 22.18 or newer).

The complete matrix runs both engines against the same native source snapshot,
including native tests and all three application fixtures in development and
production mode:

The additional [review regression gates](review-regressions/README.md) exercise
forwarded refs, NativeReady cleanup, Suspense visibility and real watch restart
against each source-certified binary, including an empty-directory PCK.

```sh
node scripts/test/react-matrix.mts \
  --qjs-report /tmp/godot-react-qjs/react-native-build.json \
  --v8-report /tmp/godot-react-v8/react-native-build.json \
  --out /tmp/godot-react-matrix --jobs 1
```

It builds the SDK packages once and writes `react-matrix.json` plus every child
report/log. Changed, added or removed native inputs reject a stale build before
testing and are rechecked after testing. `--collect-only` explicitly collects existing reports with matching
source/binary/fixture/mode tuples; it does not claim a fresh test execution.

```sh
node scripts/test/react-native-build.mts \
  --godot-source /path/to/godot-4.6.1 \
  --out /tmp/godot-react-qjs --engine qjs --scons /path/to/scons
node scripts/test/react-native-test.mts \
  --native-report /tmp/godot-react-qjs/react-native-build.json
node scripts/test/react-integration.mts \
  --godot /tmp/godot-react-qjs/bin/godot.linuxbsd.editor.x86_64 \
  --native-report /tmp/godot-react-qjs/react-native-build.json \
  --out /tmp/godot-react-integration --mode production
```

The build command copies the engine source/cache and the module into a separate
tree, records source hashes and compiler flags, and hashes the resulting binary.
It enables native tests, Multiplayer/ENet and GodotPhysics2D/3D. For a V8 build,
use `--engine v8 --deps /path/to/directory-containing-v8-and-lws`.
Fontconfig remains enabled through Godot's dynamic system-library wrapper;
`libfontconfig.so.1` must be available for editor imports/exports to produce a
clean diagnostic log.

The isolated engine copy uses an explicit Godot 4.6.1 **build recipe change**:
`FONTCONFIG_ENABLED` is defined on the Linux/BSD platform compilation environment
instead of globally. Before applying this optimization, the script scans all
native source files and requires the macro to occur only in `os_linuxbsd.h/cpp`,
with exactly the three known translation units including that header. A changed
scope or engine version fails the build. Fontconfig remains genuinely enabled;
the engine's C/C++ implementation and this module's product code retain their
original contents. The
native build attestation contains the complete before/after contents and SHA256
of both modified recipe files, and every QA report references that attestation.
The shared SDK source tree is never modified.

The native test command checks the binary hash, executes the module's registered
native tests, and requires nonzero passing cases/assertions and doctest's success
marker. It writes `react-native-tests.json` and the complete log beside the build
attestation.

Run the same command with `--mode development` to exercise React's development
bundle and StrictMode replay. `fixture` explicitly uses `React.StrictMode`; the
renderer also creates a strict root in development mode. Use a separate output
directory for each engine/mode combination.

The fixtures disable the optional runtime inspector, and each integration run
uses its own editor settings with the inspector port disabled. Inspector
transport errors are explicitly rejected, including LWS errors embedded in
debug-prefixed log lines. Inspector connectivity is outside this conformance
gate. Use `--jobs 1` when running alongside other V8 verifiers: the compiler's
short-lived binary descriptor probes use the engine's runtime defaults.

The integration command builds the SDK packages, copies `fixture` to its output
directory, runs the standard compiler and doctor, and verifies:

- Actual Godot GUI key input updates a React component's state and retains the
  native object.
- Controlled button state recovers without a React state update, setter echoes
  remain suppressed, and uncontrolled native button state persists.
- Context and prop updates preserve independent scene state and HUD identity.
- Changing a key reconstructs only the targeted component subtree.
- One hundred additional key resets retain a native node plateau and preserve
  the sibling scene and HUD; each retirement runs cleanup before freeing.
- An imported read-only TSCN becomes React-owned nodes, with no hidden business
  envelope or runtime template file in the PCK.
- Startup assets complete through the renderer's asset/Suspense path.
- Passive cleanup can still read the retiring native node.
- The SDK emits a valid boot report, the driver emits an independent behavior
  report, and the runtime log contains no script/native errors.
- External native injection of a public SceneTree sibling fails explicitly.
- An actual TSX signal-handler exception maps back to its original throw line.
- The official `exportProject` production command selects only the generated
  entry scene and export hub, produces a PCK that
  includes the sealed manifest and native resource closure, then passes the same
  checks when launched from an empty directory.

`--fixture physics` selects the separate `behavior-physics-v1` fixture. Its React
physics hook applies gravity through a synchronous field lease and calls the
real CharacterBody2D `move_and_slide`. Capsule and rectangle resources form an
actual character/static-floor collision. Independent native SceneTree checks
require the character to fall, then remain on the floor. The renderer also
reports its collision results and proves that a saved frame command is rejected
after its dispatch ends. The same checks run from the exported PCK.

`--fixture local-resources` selects a `template-local-v1` import with two template
instances referencing the same local-to-scene material. Native checks require
alias preservation inside each instance, distinct clones across instances,
correct `get_local_scene()` and `owner` identities, and twenty key resets that
replace only the first instance and its resource. The source TSCN must remain
absent from the PCK, whose isolated execution repeats these checks.

`verify.gd` runs as an external SceneTree test harness. It creates no application
nodes and is not part of the exported application. Success always requires the
positive structured reports as well as a clean process exit. Complete stage
logs and `react-integration.json` remain in the output directory on failure.
