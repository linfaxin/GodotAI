#include "jsb_runtime_script_properties.h"
#include "jsb_environment.h"
#include "jsb_runtime_access_common.h"
#include "core/math/math_funcs.h"
#include <cmath>

namespace jsb {
namespace {
constexpr double MAX_SAFE_INTEGER = 9007199254740991.0;

bool valid_scalar_string(const String& string) {
    for (int i = 0; i < string.length(); ++i) {
        const char32_t code = string[i];
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
    }
    return string.utf8().length() <= 1024;
}
}

bool runtime_scalar_from_js(Environment* env, const v8::Local<v8::Value>& value,
        Variant::Type type, Variant& out, const char*& reason) {
    reason = nullptr;
    v8::Isolate* isolate = env->get_isolate();
    if (type == Variant::BOOL) {
        if (!value->IsBoolean()) { reason = "type_mismatch"; return false; }
#if JSB_WITH_WEB
        out = jsbi_RuntimeBooleanValue(isolate->rt(), value->stack_pos_);
#else
        out = value.As<v8::Boolean>()->Value();
#endif
        return true;
    }
    if (type == Variant::INT || type == Variant::FLOAT) {
        if (!value->IsNumber()) { reason = "type_mismatch"; return false; }
#if JSB_WITH_WEB
        const double number = jsbi_RuntimeNumberValue(isolate->rt(), value->stack_pos_);
#else
        const double number = value.As<v8::Number>()->Value();
#endif
        if (!Math::is_finite(number)) { reason = "out_of_range"; return false; }
        if (type == Variant::INT) {
            if (std::floor(number) != number || number < -MAX_SAFE_INTEGER || number > MAX_SAFE_INTEGER) {
                reason = "out_of_range"; return false;
            }
            out = static_cast<int64_t>(number);
        } else out = number;
        return true;
    }
    if (type != Variant::STRING || !value->IsString()) { reason = "type_mismatch"; return false; }
    if (value.As<v8::String>()->Length() > 1024) { reason = "value_too_large"; return false; }
    String string;
#if JSB_WITH_WEB
    int32_t size = 0;
    char* bytes = jsbi_RuntimeToCStringLen(isolate->rt(), &size, value->stack_pos_);
    if (size < 0) { reason = size == -2 ? "value_too_large" : "encoding_failed"; return false; }
    const bool decoded = runtime_access::decode_utf8_exact(bytes ? bytes : "", size, string);
    if (bytes) jsbi_free(bytes);
    if (!decoded) { reason = "encoding_failed"; return false; }
#elif JSB_WITH_QUICKJS
    size_t size = 0;
    const char* bytes = JS_ToCStringLen(isolate->ctx(), &size, (JSValue) value);
    if (!bytes) { reason = "encoding_failed"; return false; }
    if (size > 1024) { JS_FreeCString(isolate->ctx(), bytes); reason = "value_too_large"; return false; }
    const bool decoded = runtime_access::decode_utf8_exact(bytes, size, string);
    JS_FreeCString(isolate->ctx(), bytes);
    if (!decoded) { reason = "encoding_failed"; return false; }
#elif JSB_WITH_V8
    const v8::String::Value utf16(isolate, value);
    const uint16_t* data = *utf16;
    for (int i = 0; i < utf16.length(); ++i) {
        const uint16_t code = data[i];
        if (code >= 0xd800 && code <= 0xdbff) {
            if (++i == utf16.length() || data[i] < 0xdc00 || data[i] > 0xdfff) { reason = "encoding_failed"; return false; }
        } else if (code >= 0xdc00 && code <= 0xdfff) { reason = "encoding_failed"; return false; }
    }
    Vector<char32_t> codes;
    for (int i = 0; i < utf16.length(); ++i) {
        uint32_t code = data[i];
        if (code >= 0xd800 && code <= 0xdbff) code = 0x10000 + ((code - 0xd800) << 10) + (data[++i] - 0xdc00);
        codes.push_back(code);
    }
    string = String::utf32_unchecked(Span<char32_t>(codes.ptr(), codes.size()));
#else
    // JavaScriptCore is not an enabled runtimeProperties target, but keep the
    // ordinary native package buildable without widening its capability.
    reason = "type_mismatch";
    return false;
#endif
    if (!valid_scalar_string(string)) { reason = "value_too_large"; return false; }
    out = string;
    return true;
}

bool runtime_scalar_to_js(Environment* env, const Variant& value,
        v8::Local<v8::Value>& out, const char*& reason) {
    reason = nullptr;
    v8::Isolate* isolate = env->get_isolate();
    switch (value.get_type()) {
        case Variant::BOOL: out = v8::Boolean::New(isolate, value); return true;
        case Variant::INT: {
            const int64_t integer = value;
            if (integer < -MAX_SAFE_INTEGER || integer > MAX_SAFE_INTEGER) { reason = "out_of_range"; return false; }
            out = v8::Number::New(isolate, static_cast<double>(integer)); return true;
        }
        case Variant::FLOAT: {
            const double number = value;
            if (!Math::is_finite(number)) { reason = "out_of_range"; return false; }
            out = v8::Number::New(isolate, number); return true;
        }
        case Variant::STRING: {
            const String string = value;
            if (!valid_scalar_string(string)) { reason = "value_too_large"; return false; }
#if JSB_WITH_WEB
            const CharString bytes = string.utf8();
            const auto position = jsbi_RuntimeNewString(isolate->rt(), bytes.get_data(), bytes.length());
            if (position == impl::StackBase::Error) { reason = "encoding_failed"; return false; }
            out = v8::Local<v8::String>(v8::Data(isolate, position));
#else
            out = impl::Helper::new_string(isolate, string);
#endif
            return true;
        }
        default: reason = "type_mismatch"; return false;
    }
}
} // namespace jsb
