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
and manifest. See [project usage and migration](../../docs/react-tsx.zh-CN.md).
Importing the SDK in Node does not import Godot. `@godot-js/react/testing`
provides a mock private backend for tests with the real reconciler.

## Host values and refs

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

The two extension profiles each include core. Selecting `ui-media-v1` does not
enable physics hosts, and selecting `behavior-physics-v1` does not enable media
hosts. `G.TextureRect` and named `TextureRect` imports refer to the same host and
have the same profile checks. The renderer validates the active profile even
when author code is JavaScript or casts away TypeScript types.

`MarginContainer` adds integer `marginLeft`, `marginRight`, `marginTop` and
`marginBottom` values from 0 to 16384. They map to controlled native theme
constants; removing a controlled margin restores its immutable initial value.
`PanelContainer`, `MarginContainer` and `ScrollContainer` own their children's
layout position and size, as the existing row and column containers do.

`ScrollContainer` supports `horizontalScrollMode` and `verticalScrollMode`
(Godot values 0–4) and `followFocus`. Scroll offsets remain native layout state.
`TextureRect` accepts `texture`, `expandMode` (0–5), `stretchMode` (0–6),
`flipH` and `flipV`. `Sprite2D` adds `texture`, `centered`, `offset`, `flipH`
and `flipV` to the checked Node2D properties. Texture props accept immutable
AssetRefs for the three listed texture types, or `null`.

`ProgressBar` uses a fixed 0–100 range with `step={0}`. It supports `value`,
`showPercentage`, `fillMode` (0–3) and `onValueChanged`. Native setter echoes
are suppressed; actual native value changes reach the committed handler.
Removing `value` restores the initial baseline. `minValue`, `maxValue` and
`step` only accept the fixed values 0, 100 and 0 respectively.

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

`defineNativeInterface` declares a static certified NativeScript/RPC schema;
`nativeInterface={token}` selects construction before the Node enters the tree.
`useNativeInterface(ref, token, handlers)` installs committed callbacks. RPC send
returns the local Godot Error status, never a remote return value. Identity,
schema, argument codecs, Root lifetime and queued callback validity are checked.

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
