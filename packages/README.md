# Ecosystem packages

Use `packages/<name>` for reusable GodotJS libraries. Applications belong in `apps/`. The existing engine-private packages remain in `scripts/jsb.runtime`, `scripts/jsb.editor`, and `impl/web/bridge` because their output is part of the native engine build.

## Current packages

| Package | Status | Output |
| --- | --- | --- |
| [`@godot-js/tsx`](tsx/README.md) | Private package foundation; no runtime API yet | CommonJS and declarations in `dist/` |

## Adding a package

1. Give the package a unique `@godot-js/` name and keep it `private` until its API and release process are ready.
2. Add `build` and `typecheck` scripts. The root `build:packages` and `typecheck:packages` commands select packages by directory.
3. Extend `configs/tsconfig/base.json` for common checks. Set the target, module format, resolution, libraries, ambient types, and output directory in the package itself.
4. Keep implementation in `src/`, build output in `dist/`, and point package entry fields at built files. Do not publish source-only aliases as package entry points.
5. Explain the package's implemented scope, host requirements, and intended consumers in its README.
6. Keep private foundations out of the release plan, as the current packages are listed in `.changeset/config.json`. Review versioning and publication deliberately before enabling a public release.

## Dependency rules

- Declare dependencies between workspace libraries with `workspace:*` and consume their package entry points. Do not import another package's `src/` or use TypeScript path aliases to bypass its build.
- Libraries must not depend on applications. Extract shared code only when it has an implemented responsibility and a real consumer.
- Do not depend on the private embedded-script packages as npm runtime libraries. GodotJS provides virtual modules such as `godot`, `godot-jsb`, and `godot.lib.api` inside the engine.
- When native bindings are introduced, follow `godot.lib.api`'s library naming contract and keep host modules external to bundles. Document the supported engine and binding profile.
- Choose ambient types explicitly. Node tools, browser applications, and Godot libraries have different environments.
- Do not copy the placeholder `scripts/typings/godot.generated.d.ts` into a public type package. Real engine types must be generated against a matching engine; project-specific declarations remain a separate concern.

## Verification and releases

Run `pnpm build:packages` and `pnpm typecheck:packages` from the repository root. Before making a package public, validate its packed tarball in an isolated consumer, including entry points, declaration resolution, declared dependencies, and supported host environments.

The root package version continues to identify the existing engine release. Public ecosystem packages will need their own semver and npm publication process; the current engine release script creates GitHub Releases.
