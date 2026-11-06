# @godot-js/react

React 19.3.1 renderer for GodotJS. Author ordinary function components with
Hooks, context, Suspense and keyed children. Every public business Node belongs
to the React tree; the renderer materializes and audits it through the private
native ABI. A template is expanded into React host elements, never mounted as
an opaque runtime PackedScene.

```tsx
import * as React from "react";
import { VBoxContainer, Label, Button } from "@godot-js/react";

export default function App() {
  const [count, setCount] = React.useState(0);
  return <VBoxContainer name="Counter">
    <Label text={`Count: ${count}`} />
    <Button text="Add" onPressed={() => setCount(n => n + 1)} />
  </VBoxContainer>;
}
```

One GodotJS Environment / JavaScript realm supports one active React Root.
Compose multiple scenes as components under that root. Starting another entry
before disposing the current root fails with `E_MULTIPLE_ROOTS_UNSUPPORTED`;
a new root may be created after shutdown. A failed application start releases
its preopened empty native scope.

The compiler owns the bootstrap, entry TSCNs, canonical React/JSX vendor bundle
and manifest. See [project usage and migration](../../docs/react-tsx.md).
Importing the SDK in Node does not import Godot. `@godot-js/react/testing`
provides a mock private backend for tests with the real reconciler.

## Host values and refs

Core hosts: Node, Node2D, Control, VBoxContainer, HBoxContainer, Label, Button,
CanvasLayer. Text is supplied through `Label.text` or `Button.text`.
Host properties and commands are a checked whitelist; unknown fields fail.

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

## Frame work and resources

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

`behavior-physics-v1` explicitly enables CharacterBody2D, StaticBody2D and
CollisionShape2D. `usePhysicsProcess` permits checked `setVelocity` and
`moveAndSlide` commands. This does not enable arbitrary Godot methods.

`asset(id, type)` produces an immutable logical AssetRef. `useAsset(ref)` loads
through the manifest resource table and suspends until ready; it returns no raw
Resource. Compiled `template-local-v1` plans can request per-instance native
local-to-scene copies. Source load, detached-root cloning, setup, publication and
release are separate gated operations.

`defineNativeInterface` declares a static certified NativeScript/RPC schema;
`nativeInterface={token}` selects construction before the Node enters the tree.
`useNativeInterface(ref, token, handlers)` installs committed callbacks. RPC send
returns the local Godot Error status, never a remote return value. Identity,
schema, argument codecs, Root lifetime and queued callback validity are checked.

## Browser showcase profile

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

## Runtime lifecycle

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
