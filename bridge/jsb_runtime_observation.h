#ifndef JSB_RUNTIME_OBSERVATION_H
#define JSB_RUNTIME_OBSERVATION_H

#include "core/string/ustring.h"
#include <cstdint>

namespace jsb {

inline constexpr uint32_t RUNTIME_OBSERVATION_REQUEST_BYTES = 4096;
inline constexpr uint32_t RUNTIME_OBSERVATION_RESULT_BYTES = 65536;

// Run after a normal iteration on the SceneTree owner. Results are owned UTF-8
// bytes and contain no engine objects, script values, or executable handles.
CharString sample_runtime_observation(const char* request, uint32_t size);
CharString execute_runtime_write(const char* request, uint32_t size);

} // namespace jsb

#endif
