---
"@godot-js/editor": patch
---

Separate embedded-script and ecosystem-package builds, add a private TSX package foundation, and document the workspace boundaries. Install JavaScript dependencies explicitly with `pnpm install --frozen-lockfile` in the GodotJS module directory before running SCons; SCons now builds only the embedded scripts. Run ecosystem CI checks independently of engine artifact production while keeping both in the final validation gate.
