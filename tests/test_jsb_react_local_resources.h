#ifndef GODOTJS_TESTS_REACT_LOCAL_RESOURCES_H
#define GODOTJS_TESTS_REACT_LOCAL_RESOURCES_H

#include "../internal/jsb_react_local_resources.h"
#include "../compat/jsb_engine_version_comparison.h"
#if GODOT_4_7_OR_NEWER
#include "core/object/callable_mp.h"
#else
#include "core/object/callable_method_pointer.h"
#endif
#include "scene/resources/packed_scene.h"
#include "scene/resources/2d/capsule_shape_2d.h"
#include "tests/test_macros.h"

namespace jsb::tests
{
    class ReactLocalSetupObserver : public Object
    {
    public:
        int count = 0;
        void setup() { ++count; }
    };

    TEST_CASE("[jsb][react] local resource remapping preserves aliases and scene identity")
    {
        Ref<Resource> original;
        original.instantiate();
        original->set_local_to_scene(true);
        Ref<Resource> child;
        child.instantiate();
        child->set_local_to_scene(true);
        Ref<Resource> shared;
        shared.instantiate();
        original->set_meta("first", child);
        original->set_meta("second", child);
        original->set_meta("shared", shared);
        Node* first_root = memnew(Node);
        Node* second_root = memnew(Node);
        internal::ReactLocalResources first(first_root);
        internal::ReactLocalResources second(second_root);
        String reason;
        const Ref<Resource> first_copy = first.remap(original, reason);
        REQUIRE(reason.is_empty());
        REQUIRE(first_copy.is_valid());
        const Ref<Resource> second_copy = second.remap(original, reason);
        REQUIRE(reason.is_empty());
        REQUIRE(second_copy.is_valid());
        CHECK(first_copy != original);
        CHECK(first_copy != second_copy);
        CHECK(first.remap(original, reason) == first_copy);
        const Ref<Resource> first_child = first_copy->get_meta("first");
        const Ref<Resource> second_child = second_copy->get_meta("first");
        CHECK(first_child != child);
        CHECK(first_child != second_child);
        CHECK(Ref<Resource>(first_copy->get_meta("second")) == first_child);
        CHECK(Ref<Resource>(first_copy->get_meta("shared")) == shared);
        CHECK(first.remap(child, reason) == first_child);
        CHECK(first_copy->get_local_scene() == first_root);
        CHECK(first_child->get_local_scene() == first_root);
        CHECK(second_copy->get_local_scene() == second_root);
        CHECK(original->get_local_scene() == nullptr);

        ReactLocalSetupObserver observer;
        first_copy->connect("setup_local_to_scene_requested", callable_mp(&observer, &ReactLocalSetupObserver::setup));
        first_child->connect("setup_local_to_scene_requested", callable_mp(&observer, &ReactLocalSetupObserver::setup));
        CHECK(first.finish(reason) == OK);
        CHECK(observer.count == 2);
        CHECK(first.finish(reason) == OK);
        CHECK(observer.count == 2);
        CHECK(first.is_finished());
        // Reusing an existing alias is allowed after publication; introducing
        // another clone into the sealed scope is not.
        CHECK(first.remap(original, reason) == first_copy);
        Ref<Resource> late;
        late.instantiate();
        late->set_local_to_scene(true);
        CHECK(first.remap(late, reason).is_null());
        CHECK(reason.begins_with("E_LOCAL_RESOURCE_SCOPE"));
        CHECK(second.finish(reason) == OK);
        memdelete(first_root);
        memdelete(second_root);
        first.clear();
        second.clear();
    }

    TEST_CASE("[jsb][react] local resources match PackedScene native remapping")
    {
        Ref<Resource> local;
        local.instantiate();
        local->set_local_to_scene(true);
        Node* source = memnew(Node);
        source->set_name("ResourceRoot");
        source->set_meta("one", local);
        source->set_meta("two", local);
        Ref<PackedScene> packed;
        packed.instantiate();
        REQUIRE(packed->pack(source) == OK);
        Node* native_instance = packed->instantiate();
        REQUIRE(native_instance);
        Node* react_instance = memnew(Node);
        internal::ReactLocalResources scope(react_instance);
        String reason;
        const Ref<Resource> clone = scope.remap(local, reason);
        REQUIRE(clone.is_valid());
        react_instance->set_meta("one", clone);
        react_instance->set_meta("two", scope.remap(local, reason));
        REQUIRE(scope.finish(reason) == OK);
        const Ref<Resource> native_clone = native_instance->get_meta("one");
        CHECK(native_clone != local);
        CHECK(clone != local);
        CHECK(Ref<Resource>(native_instance->get_meta("two")) == native_clone);
        CHECK(Ref<Resource>(react_instance->get_meta("two")) == clone);
        CHECK(native_clone->get_local_scene() == native_instance);
        CHECK(clone->get_local_scene() == react_instance);
        CHECK(native_instance->get_child_count() == react_instance->get_child_count());
        memdelete(native_instance);
        memdelete(react_instance);
        memdelete(source);
        scope.clear();
    }

    TEST_CASE("[jsb][react][SceneTree] local capsule shapes preserve native construction values")
    {
        Ref<CapsuleShape2D> source;
        source.instantiate();
        source->set_radius(7.5);
        source->set_height(31.0);
        source->set_local_to_scene(true);
        Node* owner = memnew(Node);
        internal::ReactLocalResources scope(owner);
        String reason;
        const Ref<CapsuleShape2D> first = scope.remap(source, reason);
        REQUIRE(first.is_valid());
        CHECK(reason.is_empty());
        CHECK(first != source);
        CHECK(first->get_radius() == source->get_radius());
        CHECK(first->get_height() == source->get_height());
        CHECK(first->get_local_scene() == owner);
        CHECK(scope.remap(source, reason) == first);
        CHECK(scope.finish(reason) == OK);
        memdelete(owner);
        scope.clear();
    }

    TEST_CASE("[jsb][react] local resource scope rejects executable and Node references")
    {
        Node* owner = memnew(Node);
        Node* referenced = memnew(Node);
        Ref<Resource> source;
        source.instantiate();
        source->set_local_to_scene(true);
        internal::ReactLocalResources scope(owner);
        String reason;
        source->set_meta("node_reference", referenced);
        CHECK(scope.remap(source, reason).is_null());
        CHECK(reason.begins_with("E_LOCAL_RESOURCE_GRAPH"));
        source->remove_meta("node_reference");
        source->set_meta("callback", Callable());
        CHECK(scope.remap(source, reason).is_null());
        CHECK(reason.begins_with("E_LOCAL_RESOURCE_GRAPH"));
        scope.clear();
        memdelete(referenced);
        memdelete(owner);
    }
}

#endif
