#ifndef GODOTJS_RUNTIME_CALL_H
#define GODOTJS_RUNTIME_CALL_H

#include "../jsb.gen.h"
#include "jsb_runtime_properties.h"

#if !JSB_WITH_JAVASCRIPTCORE
namespace jsb {
CharString execute_runtime_call(const char* request, uint32_t size, uint32_t remaining_budget_micros,
    RuntimePropertyClock clock = nullptr);
}
#endif

#endif
