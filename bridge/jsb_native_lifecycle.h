#ifndef GODOTJS_NATIVE_LIFECYCLE_H
#define GODOTJS_NATIVE_LIFECYCLE_H

// Native Main::iteration hooks. The pinned source producer installs these
// before Main::cleanup destroys ScriptLanguages and their contexts.
bool jsb_native_lifecycle_is_closing();
bool jsb_native_lifecycle_begin_exit();
bool jsb_native_lifecycle_step();
// Called by the actual Web owner-loop begin-exit hook before JS cleanup jobs.
void jsb_web_native_lifecycle_begin_exit();
void jsb_web_native_lifecycle_cleanup_tick();

#endif
