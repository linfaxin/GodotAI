(module
 (import "env" "memory" (memory 1 4 shared))
 (func (export "read32") (param $p i32) (result i32) (i32.load (local.get $p)))
 (func (export "copy") (param $dst i32) (param $src i32) (param $len i32)
  (memory.copy (local.get $dst) (local.get $src) (local.get $len)))
 (func (export "fill") (param $dst i32) (param $value i32) (param $len i32)
  (memory.fill (local.get $dst) (local.get $value) (local.get $len)))
 (func (export "pages") (result i32) (memory.size))
)
