---
"@godot-js/engine": minor
---

Add scoped `Node2D.position` writes to the Dedicated Worker runner and expose them as `runtime_set` in Playground. Write receipts identify the run and node instance and report the value read back by the engine. The Playground demo verifies the write with a separate read and PNG captures, then restarts the same project to confirm the original position.
