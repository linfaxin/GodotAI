# @godot-js/react

React 19.3.1 renderer for GodotJS. The default `createRoot(nativeContainer,
options?)` renders directly into the Godot engine. React supplies components,
Hooks, context, Suspense and reconciliation; GodotJS supplies native constructors,
methods, signals, resources and engine systems. Adding a Godot class does not
require a React host schema or a per-class C++ bridge.

## Direct native renderer

```tsx
import * as React from "react";
import * as G from "godot";
import { EngineNode, createNativeComponent } from "@godot-js/react";

const VBox = createNativeComponent(G.VBoxContainer);

export default function App() {
  const [count, setCount] = React.useState(0);
  return <VBox native={{ name: "Counter" }}>
    <EngineNode ctor={G.Label} native={{ text: `Count: ${count}` }} />
    <EngineNode ctor={G.Button} native={{ text: "Add" }}
      on={{ pressed: () => setCount(n => n + 1) }} />
  </VBox>;
}
```

`EngineNode` accepts any native **Node** constructor through `ctor`, optional
constructor `args`, declarative property values in `native`, signals in `on`, and a
real native `ref`. `createNativeComponent(ctor)` binds a constructor while
preserving its property, signal argument and ref types. Resources and other
non-Node objects are constructed or loaded through `godot` and passed directly
as native values. Resource identity is preserved; value variants such as
`Vector2` are compared by their captured components. Packed arrays also retain
independent value snapshots, so mutating a packed value and rerendering updates
the native property. Unsetting it restores the original snapshot. Godot Array
and Dictionary retain their native reference semantics. Native property/signal
names and the binding's public names are accepted at runtime.

JSX infers property, signal and ref types from `ctor`, or from `object` when
adopting an existing node. Native values and refs cannot widen that inferred
instance type. React's `createElement(EngineNode, props)` erases the unspecialized
component's generic relationship; use `createNativeComponent(ctor)` to retain
constructor inference, or explicitly select the props type when adopting:

```ts
import { EngineNode, type AdoptedNodeProps } from '@godot-js/react';
React.createElement<AdoptedNodeProps<G.Label>>(EngineNode, {
  object: existingLabel, ownership: 'adopt', native: { text: 'Existing label' },
});
```

Removing a `native` property, or setting it to `undefined`, restores the native
value captured when that property first became declared. Values reconcile at actual
host commits; they are not continuously forced back each frame. Leave a property
out of `native` when frame callbacks or native engine systems should manage it.
Signals enqueue the current committed callback and are delivered after their native
callback stack returns. Removing a handler disconnects it. Constructor, constructor
argument or adopted-object changes require a new React key.

### Native refs and frame callbacks

```tsx
import * as React from "react";
import * as G from "godot";
import { EngineNode, useFrame } from "@godot-js/react/engine";

function Spinner() {
  const ref = React.useRef<G.Node2D>(null);
  useFrame("process", delta => {
    const node = ref.current;
    if (node && G.is_instance_valid(node)) node.rotation += delta;
  });
  return <EngineNode ctor={G.Node2D} ref={ref} />;
}
```

`useFrame("process", callback)` and `useFrame("physics", callback)` run
synchronously and receive the frame delta. Refs expose actual GodotJS objects,
so physics queries, movement and other native methods use the engine's own API.
React state changes from a physics callback commit during a later safe pump.
Cancel asynchronous work in effect cleanup; React does not await async cleanup.

### Root lifecycle and ownership

Create a root on an existing native Node. By default the mount must already be
in SceneTree: the root connects to `process_frame` and `physics_frame` and
disconnects on shutdown. For a native bootstrap that owns frame forwarding:

```tsx
import * as G from "godot";
import { createRoot, type EngineRoot } from "@godot-js/react/engine";
import App from "./App";

export default class ReactMount extends G.Node {
  private reactRoot?: EngineRoot;
  _ready() {
    this.reactRoot = createRoot(this, { autoProcess: false });
    this.reactRoot.render(<App />);
    this.reactRoot.flush(); // Explicit initial safe-point commit.
  }
  _process(delta: number) { this.reactRoot?.process(delta); }
  _physics_process(delta: number) { this.reactRoot?.physics(delta); }
  _exit_tree() { this.reactRoot?.shutdown(); this.reactRoot = undefined; }
}
```

| Method | Behavior |
| --- | --- |
| `render(element)` | Enqueue the latest element; allocate native Nodes only at a safe commit. |
| `flush()` | Explicitly pump the session at an allowed point; physics cannot be overridden. |
| `pump()` | Advance scheduled React work and deferred signal callbacks. |
| `process(delta)` / `physics(delta)` | Forward frame callbacks; `process` also pumps. |
| `unmount()` | Enqueue removal of rendered children and keep the root reusable. |
| `shutdown()` | Unmount, release owned Nodes and subscriptions, and close the root; repeated calls are safe. |
| `portal(element, nativeTarget, key?)` | Render into a borrowed native mount. |
| `getStats()` / `getErrors()` | Inspect lifecycle counters and captured errors. |

Root and portal mounts are borrowed: React does not directly free the mount or
its external siblings. A portal beneath an opaque native owner still follows that
owner's lifetime; its React content cleans up before the owner destroys the mount. Nodes created by `EngineNode` are owned and released by
React. To transfer a detached native Node into React ownership, use
`<EngineNode object={existingNode} ownership="adopt" />`; React will release
that object on removal. Native allocation waits for commit, including under
StrictMode and abandoned Suspense renders. External deletion, reparenting or
identity replacement invalidates the affected records so later reconciliation
cannot write to or release a foreign object. Native refs should be checked with
Godot's validity API when retained outside a component's lifetime.

Multiple direct native roots can coexist on distinct mounts. They share React's
scheduler ingress, and each root retains its own subscriptions and ownership.
`@godot-js/react/engine` exports only this renderer and avoids loading the legacy
runtime. The package root exports exactly the same native API. Legacy applications
import the explicit `/legacy` entry. Importing the SDK in Node does not import Godot until a native root is
created; tests can inject a native implementation with `options.godot`.

### Shared session, structure and cleanup

Every root in one native world shares an `EngineSession`. Its stage gate covers
all roots, the pinned reconciler, scheduler and signal queues. `render()` queues;
`flush()`/`pump()` perform work only when the session and native
`Engine.is_in_physics_frame()` allow it. A host can inject
`new EngineSession(G, { canCommit, requestPump })` via `options.session` and call
`session.pump()` at its engine safe point. `runSafe()` cannot override physics.
This permission governs React work; arbitrary direct Godot calls still follow
Godot's own phase rules. The default browser integration requests a microtask
pump after native JS/WASM callbacks return.

`childScope` defaults to `react-managed`: public children are tracked by React.
Composite native constructors/scripts that create public children use
`childScope="native-owned-opaque"`; their internal public subtrees follow the
native parent's lifetime. Opaque hosts do not accept React `children`. Insert
React content through `root.portal(element, borrowedChildMount)`; the mount is
registered against its opaque owner and its React content cleans up before that
owner is destroyed. Unregistered nested roots are rejected. Borrowed mounts
preserve external siblings. Godot internal children retain native lifecycle.

Unregistered changes to managed public children/order, native reparenting or
identity replacement fault and close the affected root. The entire affected
ownership island is retained, including foreign nodes; React does not seize or
free it. `cleanExit` is false and `orphaned`/errors explain that session-level
recovery is needed. Changes inside opaque native subtrees are allowed.

Host removal first retires the record. Ref/layout/passive cleanup runs while the
native object is alive. The fixed reconciler's `detachDeletedInstance` callback
marks a deletion receipt; destruction waits for that receipt, the complete
reconciler/native callback stack to return, and a session safe point. The callback
itself never frees a node. StrictMode effect replay and Suspense hiding do not
retire hosts. Hiding propagates through nonvisual nodes and opaque subtrees.
`flush()`, `pump()` and `shutdown()` may synchronously commit React cleanup, but
native destruction runs only at the session's private asynchronous checkpoint.
This also protects raw Godot signal connections that do not use React's `on`
handlers. A custom `requestPump` hook is a wakeup notification and cannot bypass
that barrier. A rejected or unconfirmed immediate free retains the ownership
island and reports a non-clean exit for session teardown; it is never counted as
an accepted release request or retried as if nothing happened.
`releaseRequested` counts native free requests, `pendingReleases` counts queued
objects awaiting native destruction, and `freed` counts observed destruction.

Property writes use `godot-jsb.internal.try_set_property` when available and retain
its stored value for normalized comparisons. Its acceptance flag proves native
field/readback validity, not arbitrary business effects. Older engines fall back
to set/get without claiming that validity receipt.

Native mutation is not transactional. A partially failed commit faults the root
and performs teardown rather than attempting rollback. Unpublished allocations
can be reclaimed after the stack/safe-point barrier; published hosts require
deletion cleanup receipts. If safe cleanup cannot be established the root remains
non-clean for the owning session to terminate; an empty queue is not a receipt.
Asynchronous effect cleanup is not awaited. Construct/load resources outside
render or through application caches; the allocation guarantee covers renderer
host creation, not arbitrary user `new G.Resource()` calls during render.

See [the usage and migration guide](../../docs/react-tsx.zh-CN.md) for native
integration and the existing compiler workflow.

### Error reporting

`onError(error, info)` distinguishes `uncaught`, `caught`, `recoverable` and
`runtime` failures. `info.stack` maps project module frames back to authored
source through the project's existing source maps. Uncaught render/commit and
frame callback failures terminate the default Playground preview and show that
stack in the editor. ErrorBoundary failures retain their fallback and appear as
warnings. Standalone roots log errors by default and retain them in `getErrors()`.

## Legacy renderer compatibility

The remaining profile, facade and CLI sections describe the legacy renderer.
Existing named hosts such as `Label`, `Button` and `VBoxContainer`, `useNodeRef`,
`initial`, `engineOwned`, checked commands, templates and profile hashes belong
to that API. Import it explicitly as `@godot-js/react/legacy` for existing apps:

```ts
import { createRoot, Label } from "@godot-js/react/legacy";
const root = createRoot(port, containerKey, {
  generation: "my-build", mode: "production",
});
```

The package root has no NativePort overload or legacy host exports. Legacy projects
retain their single-active-root rule and private ABI/profile checks. The existing
legacy toolchain owns its bootstrap, templates and generation manifest;
`@godot-js/react/testing` supplies its mock NativePort. Legacy templates and module
aliases must explicitly resolve to `/legacy`, including their declaration inputs.

## Legacy host values and refs

Core hosts: Node, Node2D, Control, VBoxContainer, HBoxContainer, Label, Button,
CanvasLayer. Text is supplied through `Label.text` or `Button.text`.
Host properties and commands are a checked whitelist; unknown fields fail.

### Profiles

Choose `profileId` in the compiler project configuration. Custom integrations
pass the same `profileId` to `createRoot`; generated launchers obtain it from
the sealed manifest. Profiles bind an exact schema hash and resource whitelist.

| Profile | Hosts beyond core | Resource types |
| --- | --- | --- |
| `core-ui-v1` (default) | The eight core hosts listed above | `Resource`, `CanvasItemMaterial` |
| `ui-media-v1` | `PanelContainer`, `MarginContainer`, `ScrollContainer`, `TextureRect`, `ProgressBar`, `Sprite2D` | Core plus `Texture2D`, `ImageTexture`, `CompressedTexture2D` |
| `behavior-physics-v1` | `CharacterBody2D`, `StaticBody2D`, `CollisionShape2D` | Core plus `CircleShape2D`, `RectangleShape2D`, `CapsuleShape2D` |
| `game-2d-v1` | All six media and three physics hosts, 17 hosts including core | The union of core, media and physics resources |

The two extension profiles each include core. Selecting `ui-media-v1` does not
enable physics hosts, and selecting `behavior-physics-v1` does not enable media
hosts. Select `game-2d-v1` to combine both extensions in one root. Its protocol
`version` remains 1; capability revisions use a new profile ID. Existing profile
descriptors and hashes remain unchanged. `G.TextureRect` and named `TextureRect` imports refer to the same host and
have the same profile checks. The renderer validates the active profile even
when author code is JavaScript or casts away TypeScript types.

`MarginContainer` adds integer `marginLeft`, `marginRight`, `marginTop` and
`marginBottom` values from 0 to 16384. They map to controlled native theme
constants; removing a controlled margin restores its immutable initial value.
`PanelContainer`, `MarginContainer` and `ScrollContainer` own their children's
layout position and size, as the existing row and column containers do.

`ScrollContainer` supports `horizontalScrollMode` and `verticalScrollMode`
(Godot values 0–4) and `followFocus`. Scroll offsets remain native layout state; `showcase-v1` additionally exposes
scoped process commands to read and set them.
`TextureRect` accepts `texture`, `expandMode` (0–5), `stretchMode` (0–6),
`flipH` and `flipV`. `Sprite2D` adds `texture`, `centered`, `offset`, `flipH`
and `flipV` to the checked Node2D properties. Texture props accept immutable
AssetRefs for the three listed texture types, or `null`.

In `ui-media-v1`, `ProgressBar` uses a fixed 0–100 range with `step={0}`. It supports `value`,
`showPercentage`, `fillMode` (0–3) and `onValueChanged`. Native setter echoes
are suppressed; actual native value changes reach the committed handler.
Removing `value` restores the initial baseline. `minValue`, `maxValue` and
`step` only accept the fixed values 0, 100 and 0 respectively in that certified
profile. The application `showcase-v1` profile additionally supports configurable
ranges and quantized steps.

For browser PNG/JPEG inputs, configure an asset as
`{ source: "assets/logo.png", type: "Texture2D" }` and select `ui-media-v1`.
The browser compiler decodes bounded RGBA pixels and emits an ImageTexture
text resource into the sealed pack. It needs no runtime Godot importer.

```tsx
import * as React from "react";
import { MarginContainer, TextureRect, asset } from "@godot-js/react";

export default function ImagePanel() {
  return <React.Suspense fallback={null}>
    <MarginContainer marginLeft={12} marginTop={12}>
      <TextureRect texture={asset("logo", "Texture2D")}
        customMinimumSize={{ x: 128, y: 128 }} expandMode={1} stretchMode={5} />
    </MarginContainer>
  </React.Suspense>;
}
```

Profile availability describes the SDK contract. Native/browser evidence must
match the selected engine, SDK mode and profile; a mock or another backend
does not establish those results. The Node builder retains its own narrower
resource-import whitelist. Text editing/IME is outside these profiles.

### UI helpers

`@godot-js/react/ui` provides ordinary React compositions over core hosts:
`Stack` (`direction="row"` or `"column"`), `Row`, `Column`, `Text`,
`ActionButton`, `Toggle`, and `useToggle`. They use the same typed host props,
ownership rules and refs. Layout is expressed through Godot properties such
as `customMinimumSize` and size flags.

```tsx
import { Stack, Text, Toggle, useToggle } from "@godot-js/react/ui";

export default function Settings() {
  const [enabled, , setEnabled] = useToggle(false);
  return <Stack direction="column">
    <Text text={enabled ? "Enabled" : "Disabled"} />
    <Toggle text="Enable" checked={enabled} onCheckedChange={setEnabled} />
  </Stack>;
}
```

`useNodeRef<"Label">()` supplies a stable, frozen read facade with `isValid()`,
`read("text")` and a two-field NativeKey. It exposes no raw native object,
mutable Resource, scene mutation or free method. Captured handles stay readable
through synchronous layout/passive cleanup, then become invalid after free.

Top-level props are controlled. `initial` establishes the immutable materialized
baseline. Removing a controlled prop restores that baseline. `engineOwned`
reserves canonical alias groups for the whole host lifetime. Change the React
key to change construction identity or reservation modes.
Development builds report ignored `initial` changes as non-fatal
`GODOT_REACT_DIAGNOSTIC` warnings. Integrations can receive immutable records
through Root `onDiagnostic` and inspect them with `getDiagnostics()`.

## Legacy frame work and resources

`useProcess(ref, { writes: ["position"] }, callback)` registers a synchronous
callback; the Node must reserve those fields with `engineOwned`. The callback
receives short-lived `FrameCommands`; storing them or using them after an await
fails. Commands validate codecs, execution phase and property ownership.
Callbacks dispatch by priority, current committed host preorder, then Hook
ordinal. Registration options are copied at publication.
Refs are rebound at the publication barrier even when an independent child
changes its host key without rendering the Hook's parent. Ownership is checked
again before the new target becomes active. Each host supports at most one
active writing frame registration; additional read-only registrations are allowed.
`useNativeReady` cleans up a retired target before native free, including when
the component containing the Hook remains mounted.

`behavior-physics-v1` and `game-2d-v1` explicitly enable CharacterBody2D, StaticBody2D and
CollisionShape2D. `usePhysicsProcess` permits checked `setVelocity` and
`moveAndSlide` commands. This does not enable arbitrary Godot methods.
Reserve `engineOwned={["position", "velocity"]}` on a moving body and declare
the same fields in the physics hook's `writes`. Supply initial position and
velocity through `initial`, then update them through synchronous frame commands.
Commands expire when the callback returns. Collision behavior requires an
engine with the real GodotPhysics2D driver; a Dummy physics engine cannot
validate movement or collision. The full fixture is
[`tests/react/physics`](../../tests/react/physics).

`asset(id, type)` produces an immutable logical AssetRef. `useAsset(ref)` loads
through the manifest resource table and suspends until ready; it returns no raw
Resource. Compiled `template-local-v1` plans can request per-instance native
local-to-scene copies. Source load, detached-root cloning, setup, publication and
release are separate gated operations.

In a browser `game-2d-v1` project, put `CollisionShape2D` and `Sprite2D` under a
`CharacterBody2D`; the native scene tree makes the sprite inherit the body's
transform. Preload the textures and shapes with `useAsset` before mounting the
world, and switch textures without changing the body's key. PNG/JPEG config and
AssetRefs both use `Texture2D`, even though the browser emits an ImageTexture.
Suspense hiding changes visibility; it does not disable collisions. Skipping a
motion callback pauses authored movement, not the entire Godot SceneTree.
Shared assets stay cached until root shutdown; resetting a keyed actor releases
its nodes and callbacks but reuses those assets.

The Node builder recognizes the same host profile, but its existing resource
pipeline still accepts only the documented `.tres` subset. Browser PNG/JPEG
compilation is not a new Node image-import capability. `CompressedTexture2D`
remains an accepted SDK resource type, not a browser source-file format.

`defineNativeInterface` declares a static certified NativeScript/RPC schema;
`nativeInterface={token}` selects construction before the Node enters the tree.
`useNativeInterface(ref, token, handlers)` installs committed callbacks. RPC send
returns the local Godot Error status, never a remote return value. Identity,
schema, argument codecs, Root lifetime and queued callback validity are checked.

## Legacy browser showcase profile

`profileId: "showcase-v1"` opts into the canvas, lighting, 3D mesh/camera,
character/rigid-body physics, ground rays and audio hosts used by the [playground](../../apps/playground/README.md).
Vector3 values use explicit `{x,y,z}` DTOs. `setPosition3D`, `setVelocity3D`,
`isOnFloor`, `setShaderFloat` and the other frame commands remain phase-checked
and require matching `engineOwned` reservations for their writes. Impulses/forces
reserve both `linearVelocity` and `sleeping`; ray refreshes reserve `rayQuery`.
Camera projection queries return Vector3 DTOs without a write reservation. Shader floats use per-instance
uniforms, so changing one canvas item's parameters does not mutate a shared
ShaderMaterial. The profile's own schema descriptor includes its Vector3 codec;
the existing default profile descriptors and hashes are unchanged.

The showcase consumes trusted prebuilt assets through a dedicated application
pipeline. It does not certify arbitrary templates, resource graphs, skeletal
animation or additional `godot-react` CLI export targets.

## Legacy runtime lifecycle

Suspense visibility covers descendants below nonvisual Nodes and independent
CanvasLayers. Revealing a subtree restores its saved or latest controlled
visibility, including nodes that were already invisible.

`@godot-js/react/godot` exports `startApplication(nativeRoot, ticket, Component)`
for generated launchers. The native root and root capability stay in the private
adapter. Tickets bind the manifest generation to a run lease before business
Nodes are created. The controller supplies pump, process, physics, input,
render and idempotent shutdown. `createRoot` plus `NativePort` is the backend
integration surface.

The private scheduler uses the pinned Scheduler 0.28 algorithm and its own pump
queue; user global timers are unchanged. React work and native structural
mutations run in the safe pump. Physics callbacks can request React state
updates; their structural commits wait for the next pump.
React development thenable instrumentation also uses this private clock, so
Suspense works without a browser `performance` global and installs no global shim.

Publication has three distinct barriers. `getPublicationReceipts()` reports
NativeApplied before refs/layout and LayoutPublished after the React stack.
`getCleanupReceipts()` reports PassiveSettled for actual retirement batches;
physical free occurs after synchronous passive cleanup. Native invalidation or
a failed ownership/audit check faults the root; shutdown still attempts cleanup.
`getNativeOperationResults()` exposes at most 256 immutable diagnostic results,
with the current commit/operation epoch in each operation ID. Native checks remain
the authority for structural and stored-state verification. Boot reports are emitted after required assets, retry publication and audits.

Input support currently observes immutable event DTOs in the application root
viewport through `useInput`; custom viewport routing, handled/unhandled input
arbitration, text editing/IME certification and portal-style native parenting
are not enabled by the core profile. Audio, animation track ownership, arbitrary
Godot classes, arbitrary runtime PackedScene mounting, and asynchronous frame
callbacks are rejected or outside the certified profile. Runtime tests alone do
not certify native physics, networking, local-to-scene semantics or export;
those require the corresponding current-HEAD Godot integration gates.

## Validation

Run `pnpm --filter @godot-js/react test`. This first rebuilds all strict
TypeScript sources and both development/production reconciler adapters, then
runs contract, real-React/mock and native-interface tests. Current-HEAD Godot
fixtures are under `tests/react/`.

The showcase also exposes Area2D/3D events, 2D rigid bodies and rays, full
character movement parameters, Camera2D, positional audio, point/spot lights,
CPU particles, Timer, LineEdit and HSlider. It inherits the existing media and
2D physics schemas. See the [capability table and ownership rules](../../apps/playground/README.md#extended-godot-capabilities).
The application profile hash changes with these additions; rebuild the matching
native bridge and Web assets. Existing core/media/physics profile hashes remain
stable. HSlider defaults to an unquantized range (`step=0`) and also supports explicit steps; LineEdit text and slider
values support React-controlled restoration after native input.

The showcase's world extension adds AnimatedSprite2D/3D, AnimationPlayer,
TileMapLayer, GridMap and NavigationRegion/Agent2D/3D. Integer cell arguments
use exact int32 vector codecs; physics-frame navigation commands and process-frame
animation/map commands retain their effect ownership checks. Command AssetRefs
resolve through the registered asset table before crossing the native bridge.
The browser application's structured resource and managed scene pipelines are
documented in [Project resources](../../apps/playground/README.md#project-resources-animation-maps-and-navigation).


The showcase's advanced scene extension adds `Skeleton3D`, `BoneAttachment3D`,
`AnimationTree`, `NativeScene` and `NativeScene2D`. Native scene descendants remain
internal and can be accessed only through typed process commands returning value
DTOs. Replacement is validated before the old instance is freed. Skeleton poses
use vector3/quaternion/transform3d codecs; graph parameters have separate number,
integer, boolean and vector2 commands. Command effect ownership remains mandatory.
`AnimationPlayer.library` binds a default library declaratively before a sibling
AnimationTree activates. See [Skeletons, AnimationTree and native scenes](../../apps/playground/README.md#skeletons-animationtree-and-native-scenes)
for resource formats, supported embedded GLBs, lifecycle tests and restrictions.


The showcase additionally includes scoped input actions (`useInputActions`),
native transform Tweens on Node2D/3D wrappers, five standard UI hosts with
font/style overrides, Curve/Path/PathFollow2D/3D, isolated MultiMesh instances,
ShapeCast2D/3D, bounded physics-space queries and common joints. Default certified
profiles retain their prior hashes. See [Input actions and remaining gameplay contracts](../../apps/playground/README.md#input-actions-and-remaining-gameplay-contracts)
for command ownership, resource formats and the importable comprehensive example.


The showcase parity extension adds NavigationLink/Obstacle2D/3D, scoped AudioBus
controllers, SubViewport/Container and ViewportTexture references. It also adds
canvas ordering/filtering, free Control layout, wrapped labels, quantized ranges,
physics materials/joint parameters, transformed/excluded space queries and motion
casts, nested animation machines, morph tracks and modifier/touch/rebind actions.
See [Additional Godot parity contracts](../../apps/playground/README.md#additional-godot-parity-contracts)
for DTOs, ownership rules, explicit limits and the importable parity example.

The gameplay extension completes raw/unhandled input channels, standard-container
SubViewport GUI, collision DTOs and CCD settings, spatial/screen coordinate
queries, sprite atlases, Line2D/Polygon2D/CollisionPolygon2D, NinePatchRect,
focus/scroll/range controls, bounded ArrayMesh resources, per-instance surface
materials and scoped audio effect parameter commands. See
[Game input, collision results and geometry](../../apps/playground/README.md#game-input-collision-results-and-geometry)
for signatures, resource formats, limits and the importable regression project.


The behavior extension adds AnimatableBody2D/3D, platform following, Area physics
fields, managed collision exceptions, camera/viewport coordinates, render layers,
per-node typed shader parameters, particle Curve/Gradient resources, full navigation
paths and independently owned appearance/value/volume Tweens. It also repairs 3D
convenience vector/command dispatch and ColorRect focus parity. See the
[behavior contracts and example](../../apps/playground/README.md#moving-platforms-effects-and-independent-tweens)
for command phases, ownership groups, limits and validation commands. Rebuild the
native bridge and Web template with the matching showcase descriptor.


The essentials extension completes derived focus/transform commands and native
processing-mode gates. It adds body locks/damping/center-of-mass/persistent forces,
local focus navigation and button styles/icons, native center/aspect containers,
Sprite3D/Label3D and screen notifiers, line/particle curves, bounded PCM loops and
audio polyphony. See the [essentials contracts and regression project](../../apps/playground/README.md#processing-constraints-ui-and-display-essentials)
for phases, native layout ownership, bounded focus paths and renderer-dependent
checks. Existing certified core profile descriptors retain their hashes.


The interaction extension adds bounded GPUParticles2D/3D with private process
materials, CurveTexture and QuadMesh resources, Control transforms/layout Tweens,
TextureButton/TextureProgressBar and Root-local ButtonGroups. It also completes
animation ping-pong/interpolation/easing/blending, SpringArm3D collisions and
managed exceptions, camera projection settings, and sanitized navigation waypoint
and link events. See the [interaction contracts and regression project](../../apps/playground/README.md#gpu-particles-control-animation-and-interaction-parity)
for ownership, limits, native semantics and browser validation.


The presentation extension closes bounded Godot text Curve/Gradient particle
resource graphs, completes AnimatedSprite3D display/appearance inheritance,
LineEdit Unicode caret/selection/edit commands and rejection events, textured
progress geometry and panel shadows. It adds native Parallax2D with scroll
ownership and repeat budgets, CanvasLayer viewport following, and GPU emission
ratio/timing/draw-order settings. See the [presentation contracts and regression project](../../apps/playground/README.md#presentation-text-editing-and-resource-import-completion)
for command phases, native event behavior, supported text-resource subsets and
rendered/interactive regression coverage.


The scene-details extension adds bounded integer map readback, GridMap collision
and cell settings, Label reveal/metrics/outline/shadow controls, PathFollow ratio/
offset/interpolation/tilt/front settings, CanvasItem lighting masks and
DirectionalLight2D. StandardMaterial3D gains bounded UV/sampling/culling and packed
texture-channel controls, with authorable OccluderPolygon2D resources. See the
[scene-details contracts and comprehensive example](../../apps/playground/README.md#map-readback-text-reveal-paths-lighting-and-material-controls)
for ownership, native timing, resource types and rendered regression coverage.


The precision extension adds sanitized shape-level collision DTOs and managed
shape-owner lookup, BaseButton press/release lifecycle and native input settings,
Root-scoped scroll positioning and touch scroll signals, free Curve tangents and
Gradient interpolation color spaces, plus NavigationAgent3D height/vertical
avoidance settings and 2D/3D forced velocity synchronization. See the
[precision contracts and comprehensive example](../../apps/playground/README.md#shape-contacts-input-lifecycle-scrolling-and-avoidance-precision)
for phases, ownership, resource bounds and browser/native coverage.


The fidelity extension completes inherited Control clipping/direction/stretch and
size notifications; bounded AnimationPlayer sections and current-clip events;
Camera2D alignment/limits and Camera3D depth projection; generated GradientTexture2D
and BitMap click masks; CPU/GPU particle forces/color curves; bounded navigation
search and target-arrival queries; Polygon2D vertex colors/texture transforms and
Line2D tessellation controls. See the
[fidelity contracts and comprehensive example](../../apps/playground/README.md#ui-layout-animation-sections-cameras-generated-textures-and-drawing-fidelity)
for ownership, ranges, text import and native/browser regression coverage.


The usability extension adds bounded RichTextLabel text/selection/reveal and
registered images, complete slider/scrollbar Range semantics, form editing and
indeterminate progress, CanvasGroup compositing, SubViewport clearing/logical
size, Root-scoped area audio/reverb and StandardMaterial3D transparency/depth/
billboarding. See the [usability contracts and comprehensive example](../../apps/playground/README.md#rich-text-complete-ranges-grouping-viewport-modes-and-spatial-audio)
for supported markup, ownership, numeric semantics, bounds and browser/native gates.

The composition extension adds bounded native TextEdit and ItemList hosts,
horizontal/vertical split and flow containers, TabContainer metadata commands,
CanvasItem visibility masks, scoped sky/fog resource graphs and hard 3D distance
visibility with hysteresis. It preserves existing layout, resource and command
ownership. See the [composition contract and runnable project](../../apps/playground/README.md#multiline-editing-lists-splitflow-layout-and-scene-visibility).

The workflows extension adds native UI layout import/roundtrip, texture and empty
StyleBoxes, top-level transforms and canvas draw order, root/nested state playback
queries and named conditions, bounded TileMap pattern DTOs and terrain paths,
MenuButton/CheckButton/separators, and CodeEdit with per-editor CodeHighlighter
copies. It uses existing layout, transform, text/selection, playback and cell
ownership; menu commands use `menuState`. See the [workflow contracts and runnable
project](../../apps/playground/README.md#native-ui-layout-texture-skins-state-playback-and-editor-workflows)
for supported fields, bounds, native/browser gates and actual input coverage.

The showcase also includes isolated MultiMesh custom data/visibility/bounds,
CanvasItem alpha masks and parent materials, 2D particle flipbooks, TileMap
lifecycle/sorting, bounded Curve queries, geometry overlays/bounds, native
CodeEdit folding/markers/search/minimap, and structured RichTextLabel tables,
lists and hints. See the [refinements contract and verification project](../../apps/playground/README.md#instance-data-canvas-masks-flipbooks-maps-and-editor-refinements)
for ownership requirements, resource budgets and renderer limits.
