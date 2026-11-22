#ifndef JSB_RUNTIME_PROPERTIES_H
#define JSB_RUNTIME_PROPERTIES_H
#include "jsb_runtime_observation.h"
namespace jsb {
using RuntimePropertyClock = uint64_t (*)();
CharString execute_runtime_properties(const char* request, uint32_t size, uint32_t remaining_budget_micros,
    RuntimePropertyClock clock = nullptr);
}
#endif
