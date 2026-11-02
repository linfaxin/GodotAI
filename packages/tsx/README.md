# @godot-js/tsx

Private package foundation for a future GodotJS scene declaration layer shared by native and browser hosts.

## Current state

The package has an empty entry point, a CommonJS build, declaration output, and a type-check command. It exports no runtime API. It is private and excluded from Changesets release planning.

From the repository root:

```sh
pnpm --filter @godot-js/tsx build
pnpm --filter @godot-js/tsx typecheck
```

Build output goes to `dist/`. The package selects ECMAScript libraries explicitly and does not inherit Node or DOM ambient types. Its source currently requires no Godot runtime or generated Godot declarations to compile.

## Intended boundary

The TSX layer will own JSX descriptions, host node wrappers, scene mounting, and lifecycle management. It must remain independent of a browser editor, DOM rendering, CDN loading, or the playground application.

Future native binding code should consume engine-provided modules through the supported library API. The engine's private runtime bundle is not an npm dependency of this package.

## Implementation sequence

1. Define JSX descriptors, synchronous function components, children semantics, and host wrapper types.
2. Implement a limited native Node renderer with typed properties, signals, explicit ownership, rollback on mount failure, and idempotent disposal.
3. Validate generated host types against a declared engine and binding profile.
4. Add `jsx-runtime`, `jsx-dev-runtime`, and any additional module-format entry points together with their implementations and consumer checks.
5. Evaluate reactivity and framework adapters after the basic lifecycle is established.

None of these runtime features is implemented by the current foundation. There are no placeholder `mount`, JSX runtime, or browser APIs.
