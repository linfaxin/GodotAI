# @godot-js/react

## 0.2.0

### Minor Changes

-   ff8da42: Add the static TSX Playground with browser compilation, strict type checking,
    fixed built-in dependencies, binary PCK generation and isolated Godot WASM runs.
    Provide a Monaco workbench with editable multi-file demos, automatic startup and
    project switching, and a read-only built-in dependency catalog.
    Share canonical imports and module-loading validation with the Node compiler.
    Add typed UI composition helpers and the explicit ui-media-v1 capability profile,
    correct wrapped Web module source maps, and provide release integrity and real
    browser lifecycle validation tools. Browser scene-template support stays gated.
-   1ecbc8e: Add the opt-in showcase-v1 capability profile with typed canvas lights, shaders,
    3D meshes, cameras, physics, ray queries and audio hosts. Preserve existing profile
    hashes and the browser SDK conformance and release gates.

    Make eight interactive showcase demos the default Playground while retaining its
    original workbench layout. Preserve edits across project switches and independent
    tabs with transactional project updates and explicit same-project conflicts.
    Validate resource batches atomically, support legacy project exports and sharing,
    round-trip large binary attachments, and align JavaScript directory module
    resolution between type checking and execution.
