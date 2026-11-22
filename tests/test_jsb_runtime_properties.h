#ifndef GODOTJS_TEST_RUNTIME_PROPERTIES_H
#define GODOTJS_TEST_RUNTIME_PROPERTIES_H
#include "../bridge/jsb_runtime_properties.h"
#include "../bridge/jsb_native_world.h"
#include "core/io/json.h"
#include "scene/2d/node_2d.h"
#include "scene/main/scene_tree.h"
#include "scene/main/window.h"
#include "tests/test_macros.h"
#include <cstring>
namespace jsb::tests {
namespace {
class PropertiesWorld {
    bool owns_ = !NativeWorld::current();
    std::shared_ptr<NativeWorld> world_ = NativeWorld::begin();
public:
    ~PropertiesWorld() { if (owns_) NativeWorld::end(world_); }
};
Dictionary property_reply(const String& source, uint32_t budget = 5000000, RuntimePropertyClock clock = nullptr) {
    const CharString bytes = source.utf8();
    const CharString response = execute_runtime_properties(bytes.get_data(), bytes.length(), budget, clock);
    REQUIRE(response.length() > 0);
    JSON parser;
    REQUIRE(parser.parse(String::utf8(response.get_data(), response.length())) == OK);
    return parser.get_data();
}
String native_command(const char* kind, const Node* node, const String& extra = String()) {
    return vformat(R"({"kind":"%s","path":"/root/PropertyTarget","expectedInstanceId":"%s","outputBudgetBytes":65536%s})",
        kind, uitos(static_cast<uint64_t>(node->get_instance_id())), extra);
}
Dictionary property_data(const Dictionary& reply) { REQUIRE(bool(reply["ok"])); return reply["result"]; }
String property_error(const Dictionary& reply) { REQUIRE_FALSE(bool(reply["ok"])); const Dictionary error = reply["error"]; CHECK(error["source"] == "native"); return error["code"]; }
uint64_t property_clock_value = 0;
uint64_t property_clock() { return property_clock_value++; }
class PropertyNotificationTarget : public Node2D {
    GDCLASS(PropertyNotificationTarget, Node2D)
protected:
    void _notification(int what) {
        if (what != NOTIFICATION_LOCAL_TRANSFORM_CHANGED) return;
        if (reenter_after_write) {
            reenter_after_write = false;
            const Dictionary reply = property_reply(native_command("read", this,
                R"(,"properties":[{"name":"position","expectedType":"vector2"}])"));
            reentry_code = Dictionary(reply["error"])["code"];
        }
        if (remove_after_write) queue_free();
        else if (clamp_after_write) { clamp_after_write = false; set_position(Vector2(12, 34)); }
    }
public:
    bool reenter_after_write = false;
    String reentry_code;
    bool remove_after_write = false;
    bool clamp_after_write = false;
};
}
TEST_CASE("[jsb][SceneTree] runtime properties describe read and write native fields") {
    PropertiesWorld world;
    Node2D* target = memnew(Node2D);
    target->set_name("PropertyTarget");
    SceneTree::get_singleton()->get_root()->add_child(target);
    target->set_position(Vector2(64, 256));
    Dictionary description = property_data(property_reply(native_command("describe", target)));
    CHECK(description["mode"] == "enumerate");
    const Array properties = description["properties"];
    REQUIRE(properties.size() == 3);
    CHECK(Dictionary(properties[0])["name"] == "position");
    CHECK(Dictionary(Dictionary(properties[0])["writeAccess"])["status"] == "supported");
    CHECK(bool(Dictionary(properties[0])["writeMayExecuteScript"]));
    Dictionary sampled = property_data(property_reply(native_command("read", target,
        R"(,"properties":[{"name":"position","expectedType":"vector2"},{"name":"visible","expectedType":"bool"}])")));
    CHECK(sampled["outcome"] == "completed");
    REQUIRE(Array(sampled["properties"]).size() == 2);
    const Dictionary position = Dictionary(Array(sampled["properties"])[0])["value"];
    CHECK(position["type"] == "vector2");
    CHECK(double(Dictionary(position["value"])["x"]) == 64);
    const String change = native_command("write", target, R"(,"property":"position","value":{"type":"vector2","value":{"x":192,"y":256}})" );
    Dictionary applied = property_data(property_reply(change));
    CHECK(applied["outcome"] == "applied");
    CHECK(bool(applied["writeEntered"]));
    CHECK(double(Dictionary(Dictionary(applied["beforeValue"])["value"])["x"]) == 64);
    CHECK(double(Dictionary(Dictionary(applied["observedValue"])["value"])["x"]) == 192);
    CHECK(Dictionary(applied["frame"])["process"].get_type() == Variant::STRING);
    CHECK(target->get_position() == Vector2(192, 256));
    CHECK(property_error(property_reply(native_command("read", target,
        R"(,"properties":[{"name":"position","expectedType":"float"}])"))) == "type_mismatch");
    CHECK(property_error(property_reply(native_command("write", target,
        R"(,"property":"visible","value":{"type":"bool","value":false})"))) == "unsupported");
    memdelete(target);
}
TEST_CASE("[jsb][SceneTree] runtime properties bind identity and reject malformed unicode before access") {
    PropertiesWorld world;
    Node2D* target = memnew(Node2D); target->set_name("PropertyTarget");
    SceneTree::get_singleton()->get_root()->add_child(target);
    const String old = native_command("write", target, R"(,"property":"position","value":{"type":"vector2","value":{"x":192,"y":256}})" );
    memdelete(target);
    target = memnew(Node2D); target->set_name("PropertyTarget");
    SceneTree::get_singleton()->get_root()->add_child(target);
    CHECK(property_error(property_reply(old)) == "node_changed");
    CHECK(target->get_position() == Vector2());
    CHECK(property_error(property_reply(native_command("write", target,
        R"(,"property":"text","value":{"type":"string","value":"\ud800"})"))) == "invalid_input");
    Dictionary names = property_data(property_reply(native_command("describe", target, R"(,"names":["unknown","position"])")));
    CHECK(Dictionary(Array(names["properties"])[0])["name"] == "position");
    CHECK(Dictionary(Array(names["properties"])[1])["status"] == "absent");
    memdelete(target);
}
TEST_CASE("[jsb][SceneTree] runtime properties preserve native mutation and phase deadlines") {
    PropertiesWorld world;
    PropertyNotificationTarget* target = memnew(PropertyNotificationTarget); target->set_name("PropertyTarget");
    SceneTree::get_singleton()->get_root()->add_child(target);
    target->set_position(Vector2(64, 256)); target->set_notify_local_transform(true);
    const String command = native_command("write", target, R"(,"property":"position","value":{"type":"vector2","value":{"x":192,"y":256}})" );
    property_clock_value = 0;
    Dictionary before_expired = property_data(property_reply(command, 3, property_clock));
    CHECK(before_expired["outcome"] == "not_written");
    CHECK_FALSE(bool(before_expired["writeEntered"]));
    CHECK(target->get_position() == Vector2(64, 256));
    property_clock_value = 0;
    Dictionary after_expired = property_data(property_reply(command, 5, property_clock));
    CHECK(after_expired["outcome"] == "unconfirmed");
    CHECK(bool(Dictionary(after_expired["evidence"])["writeEntered"]));
    CHECK(target->get_position() == Vector2(192, 256));
    target->set_position(Vector2(64, 256));
    property_clock_value = 0;
    Dictionary readback_expired = property_data(property_reply(command, 7, property_clock));
    CHECK(readback_expired["outcome"] == "unconfirmed");
    CHECK(Dictionary(readback_expired["evidence"])["phase"] == "readback");
    CHECK(target->get_position() == Vector2(192, 256));
    property_clock_value = 0;
    Dictionary final_read_expired = property_data(property_reply(native_command("read", target,
        R"(,"properties":[{"name":"position","expectedType":"vector2"}])"), 3, property_clock));
    CHECK(final_read_expired["outcome"] == "unconfirmed");
    const Dictionary expired_item = Array(Dictionary(final_read_expired["evidence"])["properties"])[0];
    CHECK(expired_item["status"] == "unavailable");
    CHECK(bool(expired_item["readEntered"]));
    target->set_position(Vector2(64, 256));
    target->reenter_after_write = true;
    Dictionary outer = property_data(property_reply(command));
    CHECK(outer["outcome"] == "applied");
    CHECK(target->reentry_code == "not_ready");
    target->set_position(Vector2(64, 256));
    target->clamp_after_write = true;
    Dictionary clamped = property_data(property_reply(command));
    CHECK(clamped["outcome"] == "not_applied");
    CHECK(target->get_position() == Vector2(12, 34));
    target->remove_after_write = true;
    Dictionary removed = property_data(property_reply(command));
    CHECK(removed["outcome"] == "unconfirmed");
    CHECK(removed["reason"] == "target_changed");
}
}
#endif
