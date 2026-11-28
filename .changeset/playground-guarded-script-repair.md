---
"@godot-js/playground": patch
"@godot-js/engine": patch
---

Add Summer-style project script reads and guarded writes to the Playground. The startup recovery lesson uses those calls to repair the script, check the new revision, and verify the running game.

Support a single 50 ms InputMap action hold in the frame-clock input script when the Worker advertises that capability and the native simulation runs at 60 Hz and 1× time scale.
