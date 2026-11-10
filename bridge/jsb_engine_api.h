#pragma once

#include "core/variant/dictionary.h"

namespace jsb {
// A target-derived, identity-free description. Reading it never constructs a user
// object, runs a project method or changes the engine's registered API.
Dictionary describe_engine_api();
}
