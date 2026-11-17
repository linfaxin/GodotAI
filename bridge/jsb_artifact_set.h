#ifndef JSB_ARTIFACT_SET_H
#define JSB_ARTIFACT_SET_H

#include "core/error/error_list.h"
#include "core/string/ustring.h"

namespace jsb {
// Called by Main::setup before ProjectSettings reads project.godot, UID caches,
// autoloads or the main scene. Any failure aborts this run; mounted PackedData
// is deliberately not rolled back or reused after a partial mount.
Error prepare_artifact_set(const String &p_main_pack);
}
#endif
