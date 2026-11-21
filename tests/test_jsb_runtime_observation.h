#ifndef GODOTJS_TEST_RUNTIME_OBSERVATION_H
#define GODOTJS_TEST_RUNTIME_OBSERVATION_H

#include "../bridge/jsb_native_world.h"
#include "../bridge/jsb_runtime_observation.h"
#include "core/io/json.h"
#include "scene/2d/node_2d.h"
#include "scene/main/scene_tree.h"
#include "scene/main/window.h"
#include "tests/test_macros.h"
#include <cstring>

namespace jsb::tests {
namespace {

class ObservationTestWorld {
    bool owns_world = !NativeWorld::current();
    std::shared_ptr<NativeWorld> world = NativeWorld::begin();

public:
    ~ObservationTestWorld() { if (owns_world) NativeWorld::end(world); }
};

Dictionary observation_reply(const char* request, uint32_t size) {
    const CharString response = sample_runtime_observation(request, size);
    REQUIRE(response.length() > 0);
    REQUIRE(static_cast<uint32_t>(response.length()) <= RUNTIME_OBSERVATION_RESULT_BYTES);
    JSON json;
    REQUIRE(json.parse(String::utf8(response.get_data(), response.length())) == OK);
    REQUIRE(json.get_data().get_type() == Variant::DICTIONARY);
    return json.get_data();
}

Dictionary observation_reply(const char* request) {
    return observation_reply(request, std::strlen(request));
}

String observation_error(const Dictionary& reply) {
    REQUIRE_FALSE(bool(reply["ok"]));
    const Dictionary error = reply["error"];
    return error["code"];
}

Dictionary observation_result(const Dictionary& reply) {
    REQUIRE(bool(reply["ok"]));
    return reply["result"];
}

Dictionary write_reply(const CharString& input) {
    const CharString reply = execute_runtime_write(input.get_data(), input.length());
    JSON json;
    REQUIRE(json.parse(String::utf8(reply.get_data(), reply.length())) == OK);
    REQUIRE(json.get_data().get_type() == Variant::DICTIONARY);
    return json.get_data();
}

Dictionary write_reply(const Node* target, const String& path, const Variant& x, const Variant& y, const String& id = String()) {
    Dictionary value;
    value["x"] = x;
    value["y"] = y;
    Dictionary request;
    request["path"] = path;
    request["expectedInstanceId"] = id.is_empty() ? uitos(static_cast<uint64_t>(target->get_instance_id())) : id;
    request["property"] = "position";
    request["value"] = value;
    return write_reply(JSON::stringify(request, "", false, true).utf8());
}

class RuntimeWriteTestNode : public Node2D {
    GDCLASS(RuntimeWriteTestNode, Node2D)

protected:
    void _notification(int notification) {
        if (notification != NOTIFICATION_LOCAL_TRANSFORM_CHANGED) return;
        if (retire_on_write) {
            queue_free();
        } else if (rewrite_position) {
            rewrite_position = false;
            set_position(Vector2(12, 34));
        }
    }

public:
    bool rewrite_position = false;
    bool retire_on_write = false;
};

} // namespace

TEST_CASE("[jsb][SceneTree] runtime observation reads current public nodes and typed values") {
    ObservationTestWorld world;
    Node* root = SceneTree::get_singleton()->get_root();
    Node2D* level = memnew(Node2D);
    level->set_name("Level");
    root->add_child(level);
    level->hide();
    Node2D* player = memnew(Node2D);
    player->set_name("Player");
    player->set_position(Vector2(64, 42));
    player->set_rotation(0.5);
    level->add_child(player);
    Node* internal = memnew(Node);
    internal->set_name("Internal");
    level->add_child(internal, false, Node::INTERNAL_MODE_BACK);
    Node* hidden_child = memnew(Node);
    hidden_child->set_name("PublicChild");
    internal->add_child(hidden_child);
    Node* retiring = memnew(Node);
    retiring->set_name("Retiring");
    level->add_child(retiring);
    Node* retiring_child = memnew(Node);
    retiring_child->set_name("PublicChild");
    retiring->add_child(retiring_child);
    retiring->queue_free();

    const Dictionary tree = observation_result(observation_reply(R"({"kind":"tree","path":"/root/Level","depth":2})"));
    REQUIRE_FALSE(bool(tree["truncated"]));
    const Array nodes = tree["nodes"];
    REQUIRE(nodes.size() == 2);
    const Dictionary parent = nodes[0];
    const Dictionary child = nodes[1];
    CHECK(parent["path"] == "/root/Level");
    CHECK(parent["parentPath"].get_type() == Variant::NIL);
    CHECK(child["path"] == "/root/Level/Player");
    CHECK(child["parentPath"] == "/root/Level");
    CHECK(child["type"] == "Node2D");
    const String first_id = child["instanceId"];
    CHECK_FALSE(first_id.is_empty());

    const Dictionary inspected = observation_result(observation_reply(R"({"kind":"node","path":"/root/Level/Player","properties":["visible","position","rotation"]})"));
    const Array observations = inspected["properties"];
    REQUIRE(observations.size() == 3);
    CHECK(Dictionary(observations[0])["name"] == "visible");
    CHECK(bool(Dictionary(observations[0])["value"])); // local flag despite hidden parent
    CHECK_FALSE(player->is_visible_in_tree());
    const Dictionary position = Dictionary(observations[1])["value"];
    CHECK(double(position["x"]) == 64.0);
    CHECK(double(position["y"]) == 42.0);
    CHECK(double(Dictionary(observations[2])["value"]) == 0.5);

    CHECK(observation_error(observation_reply(R"({"kind":"tree","path":"/root/Level/Internal/PublicChild"})")) == "node_not_found");
    CHECK(observation_error(observation_reply(R"({"kind":"node","path":"/root/Level/Retiring/PublicChild","properties":["visible"]})")) == "node_not_found");
    const Dictionary base = observation_result(observation_reply(R"({"kind":"node","path":"/root","properties":["position"]})"));
    CHECK(Dictionary(Array(base["properties"])[0])["unavailable"] == "unsupported_node_type");

    level->remove_child(player);
    memdelete(player);
    CHECK(observation_error(observation_reply(R"({"kind":"tree","path":"/root/Level/Player"})")) == "node_not_found");
    Node2D* replacement = memnew(Node2D);
    replacement->set_name("Player");
    replacement->set_position(Vector2(128, 42));
    level->add_child(replacement);
    const Dictionary replaced = observation_result(observation_reply(R"({"kind":"node","path":"/root/Level/Player","properties":["position"]})"));
    CHECK(String(Dictionary(replaced["node"])["instanceId"]) != first_id);
    CHECK(double(Dictionary(Dictionary(Array(replaced["properties"])[0])["value"])["x"]) == 128.0);
}

TEST_CASE("[jsb][SceneTree] runtime observation reports traversal limits and validates requests") {
    ObservationTestWorld world;
    Node* root = SceneTree::get_singleton()->get_root();
    Node* wide = memnew(Node);
    wide->set_name("Wide");
    root->add_child(wide);
    for (int index = 0; index < 513; ++index) {
        Node* child = memnew(Node);
        child->set_name(String("Child") + itos(index));
        wide->add_child(child);
    }

    const Dictionary only_root = observation_result(observation_reply(R"({"kind":"tree","path":"/root/Wide","depth":0,"limit":1})"));
    CHECK_FALSE(bool(only_root["truncated"]));
    CHECK(Array(only_root["nodes"]).size() == 1);
    const Dictionary limited = observation_result(observation_reply(R"({"kind":"tree","path":"/root/Wide","depth":1,"limit":500})"));
    CHECK(bool(limited["truncated"]));
    CHECK(limited["truncationReason"] == "work_budget");
    CHECK(Array(limited["nodes"]).size() == 1);

    Node* long_names = memnew(Node);
    long_names->set_name("Long");
    root->add_child(long_names);
    const String long_prefix = String("a").repeat(1500);
    for (int index = 0; index < 32; ++index) {
        Node* child = memnew(Node);
        child->set_name(long_prefix + itos(index));
        long_names->add_child(child);
    }
    const Dictionary byte_limited = observation_result(observation_reply(R"({"kind":"tree","path":"/root/Long","depth":1})"));
    CHECK(bool(byte_limited["truncated"]));
    CHECK(byte_limited["truncationReason"] == "byte_budget");
    CHECK(Array(byte_limited["nodes"]).size() < 33);
    const Dictionary node_limited = observation_result(observation_reply(R"({"kind":"tree","path":"/root/Long","depth":1,"limit":2})"));
    CHECK(node_limited["truncationReason"] == "node_limit");
    CHECK(Array(node_limited["nodes"]).size() == 2);

    CHECK(observation_error(observation_reply(R"({"kind":"node","path":"/root/Wide/..","properties":["visible"]})")) == "invalid_input");
    CHECK(observation_error(observation_reply(R"({"kind":"tree","path":"/root//Wide"})")) == "invalid_input");
    CHECK(observation_error(observation_reply(R"({"kind":"tree","path":"/root/Wide/"})")) == "invalid_input");
    CHECK(observation_error(observation_reply(R"({"kind":"tree","path":"/root/%Wide"})")) == "invalid_input");
    CHECK(observation_error(observation_reply(R"({"kind":"tree","path":"/root/Wide:visible"})")) == "invalid_input");
    CHECK(observation_error(observation_reply(R"({"kind":"tree","depth":1.5})")) == "invalid_input");
    CHECK(observation_error(observation_reply(R"({"kind":"node","path":"/root/Wide","properties":["visible","visible"]})")) == "invalid_input");
    CHECK(observation_error(observation_reply(R"({"kind":"node","path":"/root/Wide","properties":["script"]})")) == "invalid_input");
    CHECK(observation_error(observation_reply("{}\0{}", 5)) == "invalid_input");
}

TEST_CASE("[jsb][SceneTree] runtime write validates the exact node and reads back native coordinates") {
    ObservationTestWorld world;
    Node* root = SceneTree::get_singleton()->get_root();
    Node2D* player = memnew(Node2D);
    player->set_name("WritePlayer");
    root->add_child(player);
    player->set_position(Vector2(64, 42));
    const String path = "/root/WritePlayer";
    const String old_id = uitos(static_cast<uint64_t>(player->get_instance_id()));
    CHECK(observation_error(write_reply(player, path, 9, "no")) == "invalid_input");
    CHECK(observation_error(write_reply(player, path, 9, 1e100, "18446744073709551616")) == "invalid_input");
    if constexpr (sizeof(real_t) == sizeof(float)) {
        CHECK(observation_error(write_reply(player, path, 1e100, 0)) == "invalid_input");
    }
    CHECK(observation_error(write_reply(player, "/root/../WritePlayer", 9, 42)) == "invalid_input");
    CHECK(player->get_position() == Vector2(64, 42));
    const Dictionary applied = observation_result(write_reply(player, path, 192.1, 42));
    CHECK(applied["outcome"] == "applied");
    CHECK(player->get_position() == Vector2(192.1, 42));
    CHECK(real_t(double(Dictionary(applied["observedValue"])["x"])) == player->get_position().x);

    root->remove_child(player);
    CHECK(observation_error(write_reply(player, path, 9, 42)) == "node_not_found");
    memdelete(player);
    Node2D* replacement = memnew(Node2D);
    replacement->set_name("WritePlayer");
    root->add_child(replacement);
    CHECK(observation_error(write_reply(replacement, path, 9, 42, old_id)) == "node_changed");
    CHECK(replacement->get_position() == Vector2());
    CHECK(observation_error(write_reply(root, "/root", 9, 42)) == "unsupported_node_type");
}

TEST_CASE("[jsb][SceneTree] runtime write rechecks the target after synchronous transform notifications") {
    ObservationTestWorld world;
    RuntimeWriteTestNode* player = memnew(RuntimeWriteTestNode);
    player->set_name("WritePlayer");
    SceneTree::get_singleton()->get_root()->add_child(player);
    player->set_notify_local_transform(true);
    player->rewrite_position = true;
    const Dictionary changed = observation_result(write_reply(player, "/root/WritePlayer", 192, 42));
    CHECK(changed["outcome"] == "not_applied");
    CHECK(double(Dictionary(changed["observedValue"])["x"]) == 12.0);
    player->retire_on_write = true;
    const Dictionary retired = observation_result(write_reply(player, "/root/WritePlayer", 192, 42));
    CHECK(retired["outcome"] == "unconfirmed");
    CHECK(retired["reason"] == "target_changed");
    CHECK_FALSE(retired.has("observedValue"));
}

TEST_CASE("[jsb][SceneTree] runtime write parses coordinates at real_t rounding boundaries") {
    ObservationTestWorld world;
    Node2D* player = memnew(Node2D);
    player->set_name("Player192");
    SceneTree::get_singleton()->get_root()->add_child(player);
    const String id = uitos(static_cast<uint64_t>(player->get_instance_id()));
    const auto request = [&](const char* value) {
        return write_reply(vformat(R"({"value":{"y":-0.10000007227063179,"x":%s},"expectedInstanceId":"%s","path":"/root/Player\u003192","property":"position"})",
            value, id).utf8());
    };
    const Dictionary midpoint = observation_result(request("0.10000002011656761"));
    CHECK(midpoint["outcome"] == "applied");
    CHECK(player->get_position() == Vector2(real_t(0.10000002011656761), real_t(-0.10000007227063179)));
    if constexpr (sizeof(real_t) == sizeof(float)) {
        const Dictionary boundary = observation_result(request("3.4028234663852886e+38"));
        CHECK(boundary["outcome"] == "applied");
        CHECK(player->get_position().x == real_t(3.4028234663852886e+38));
        CHECK(observation_error(request("3.402823466385289e+38")) == "invalid_input");
    }
    CHECK(observation_error(request("\"0.1\"")) == "invalid_input");
    CHECK(observation_error(request("1e")) == "invalid_input");
}

} // namespace jsb::tests

#endif
