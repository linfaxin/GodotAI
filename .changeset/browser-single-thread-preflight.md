---
"@godot-js/editor": patch
---

Guard Emscripten pthread globals omitted by single-thread Web builds so the
browser JavaScript bridge can initialize with `threads=no`.
Release outstanding native Variant storage at browser isolate shutdown and
unregister finalizers before the WASM isolate is freed.
