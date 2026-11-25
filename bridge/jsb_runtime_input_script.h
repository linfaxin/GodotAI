#ifndef JSB_RUNTIME_INPUT_SCRIPT_H
#define JSB_RUNTIME_INPUT_SCRIPT_H

#include "modules/GodotJS/jsb.config.h"

#if JSB_WITH_WEB && !defined(THREADS_ENABLED)
#define GODOTJS_INPUT_SCRIPT_ABI 1
#include <cstdint>

class StringName;

namespace jsb::input_script {
char *buffer();
uint32_t stage(uint32_t sequence, uint32_t size, uint32_t remaining_us);
void cancel(uint32_t sequence, uint32_t reason);
uint32_t take(uint32_t sequence);
void begin_iteration(uint32_t iteration);
void end_iteration(bool exiting);
void before_physics();
void after_physics();
bool pressed(const StringName &action);
void reset();
void release(const StringName &action);
} // namespace jsb::input_script
#endif
#endif
