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

} // namespace jsb::tests

#endif
