# Browser playground (planned)

This directory is a documentation placeholder. It has no `package.json`, application source, dependencies, or build command and is not an active workspace package.

## Goal

Eventually provide a statically hosted playground where editing, TypeScript/TSX compilation, npm dependency resolution, and Godot execution happen in the browser. CI may prebuild Godot WebAssembly, a bootstrap project, and matching type declarations; running user code should not require local Node.js or a compilation server.

## Candidate boundaries

- The application would own its editor, compile worker, dependency resolver, diagnostics, and preview controls.
- A reusable browser SDK could own engine loading, runner implementation, the bootstrap protocol, and instance disposal.
- The TSX package would remain a host-independent Godot scene library.
- Versioned engine assets and type snapshots could be distributed separately from the application, using pinned npm/jsDelivr resources where supported.

Create these browser-specific packages and runtime projects only when their implementation is scheduled. There are currently no playground SDK, browser compiler, CDN resolver, runner, bootstrap, or engine asset packages. The existing desktop React renderer and scene toolchain remain available separately.

## Validation before implementation

- Verify the actual single-threaded GodotJS browser build, bootstrap readiness, and a minimal scene factory execution path.
- Decide the runner's static HTML deployment, sandbox/origin, CORS, and CSP requirements. A separate JavaScript realm alone does not isolate user code from a same-origin parent.
- Define serializable artifact and message contracts. Godot objects must remain inside the runner.
- Define dependency-lock and supported npm-resolution semantics, including the host-provided module allowlist.
- Match engine assets, bootstrap protocol, and generated types with a versioned manifest.
- Verify repeated instance creation, cleanup, and source-mapped errors. Stopping a normally responding instance does not imply arbitrary synchronous loops can be interrupted.
- Treat dynamic Godot Script classes and editor-imported resources as separate capabilities from creating native nodes.

See the [repository architecture](../../docs/architecture.md) for the current implementation boundaries.
