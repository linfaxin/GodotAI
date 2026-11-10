#ifndef GODOTJS_INTEGER_H
#define GODOTJS_INTEGER_H

#include <cmath>
#include <cstdint>

namespace jsb::impl
{
    // Preserve the existing truncation of finite, safe fractional Numbers while
    // rejecting values whose precision is already lost or whose cast is undefined.
    inline bool number_to_int64(double p_value, int64_t& r_value, int64_t p_max_safe)
    {
        if (!std::isfinite(p_value) || p_value < -double(p_max_safe) || p_value > double(p_max_safe)) return false;
        r_value = static_cast<int64_t>(p_value);
        return true;
    }
}

#endif
