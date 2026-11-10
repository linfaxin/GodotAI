#include "jsb_react_local_resources.h"

#include "core/object/object.h"
#include "core/templates/hash_set.h"

namespace jsb::internal
{
    namespace
    {
        bool inspect(const Variant& p_value, HashSet<ObjectID>& p_seen, String& r_error, int p_depth)
        {
            if (p_depth > 64)
            {
                r_error = "E_LOCAL_RESOURCE_GRAPH: resource graph exceeds the certified depth";
                return false;
            }
            if (p_value.get_type() == Variant::CALLABLE || p_value.get_type() == Variant::SIGNAL
                || p_value.get_type() == Variant::RID)
            {
                r_error = "E_LOCAL_RESOURCE_GRAPH: callable, signal and server-handle references are unsupported";
                return false;
            }
            if (p_value.get_type() == Variant::ARRAY)
            {
                const Array values = p_value;
                for (int i = 0; i < values.size(); ++i)
                    if (!inspect(values[i], p_seen, r_error, p_depth + 1)) return false;
                return true;
            }
            if (p_value.get_type() == Variant::DICTIONARY)
            {
                const Dictionary values = p_value;
                for (const KeyValue<Variant, Variant>& pair : values)
                    if (!inspect(pair.key, p_seen, r_error, p_depth + 1)
                        || !inspect(pair.value, p_seen, r_error, p_depth + 1)) return false;
                return true;
            }
            if (p_value.get_type() != Variant::OBJECT) return true;
            Object* object = p_value.get_validated_object();
            if (!object) return true;
            Resource* resource = Object::cast_to<Resource>(object);
            if (!resource)
            {
                r_error = "E_LOCAL_RESOURCE_GRAPH: Node and arbitrary Object references are unsupported";
                return false;
            }
            if (p_seen.has(resource->get_instance_id())) return true;
            p_seen.insert(resource->get_instance_id());
            const StringName type = resource->get_class_name();
            if (type != StringName("Resource") && type != StringName("CanvasItemMaterial")
                && type != StringName("RectangleShape2D") && type != StringName("CircleShape2D")
                && type != StringName("CapsuleShape2D"))
            {
                r_error = "E_LOCAL_RESOURCE_PROFILE: unsupported resource class " + String(type);
                return false;
            }
            if (!resource->get_script().is_null())
            {
                r_error = "E_LOCAL_RESOURCE_SCRIPT: scripted resources cannot be duplicated by this profile";
                return false;
            }
            List<PropertyInfo> properties;
            resource->get_property_list(&properties);
            for (const PropertyInfo& property : properties)
            {
                if (!(property.usage & PROPERTY_USAGE_STORAGE) || property.name == StringName("script")) continue;
                if (!inspect(resource->get(property.name), p_seen, r_error, p_depth + 1)) return false;
            }
            return true;
        }
    }

    ReactLocalResources::ReactLocalResources(Node* p_scene_root)
        : scene_root_(p_scene_root ? p_scene_root->get_instance_id() : ObjectID()) {}

    Ref<Resource> ReactLocalResources::remap(const Ref<Resource>& p_resource, String& r_error)
    {
        r_error = String();
        if (p_resource.is_null())
        {
            r_error = "E_LOCAL_RESOURCE: a source resource is required";
            return Ref<Resource>();
        }
        if (const Ref<Resource>* existing = remap_.getptr(p_resource)) return *existing;
        // A shared dependency keeps precisely the same identity as a native
        // PackedScene instance; a plain duplicate(true) would change this.
        if (!p_resource->is_local_to_scene())
        {
            r_error = "E_LOCAL_RESOURCE_POLICY: the instance descriptor requires resource_local_to_scene";
            return Ref<Resource>();
        }
        if (finished_ || finishing_)
        {
            r_error = "E_LOCAL_RESOURCE_SCOPE: the template resource scope is sealed";
            return Ref<Resource>();
        }
        Node* scene_root = Object::cast_to<Node>(::ObjectDB::get_instance(scene_root_));
        if (!scene_root || scene_root->is_inside_tree())
        {
            r_error = "E_LOCAL_RESOURCE_TIMING: clone before attaching the expanded template root";
            return Ref<Resource>();
        }
        HashSet<ObjectID> inspected;
        if (!inspect(p_resource, inspected, r_error, 0)) return Ref<Resource>();
        const Ref<Resource> result = p_resource->duplicate_for_local_scene(scene_root, remap_);
        if (result.is_null() || result == p_resource || result->get_local_scene() != scene_root)
        {
            r_error = "E_LOCAL_RESOURCE_DUPLICATE: native local-scene duplication failed";
            return Ref<Resource>();
        }
        remap_.insert(p_resource, result);
        return result;
    }

    Error ReactLocalResources::finish(String& r_error)
    {
        r_error = String();
        if (finished_) return OK;
        if (finishing_)
        {
            r_error = "E_LOCAL_RESOURCE_REENTRY: setup cannot recursively seal a scope";
            return ERR_BUSY;
        }
        Node* scene_root = Object::cast_to<Node>(::ObjectDB::get_instance(scene_root_));
        if (!scene_root || scene_root->is_inside_tree())
        {
            r_error = "E_LOCAL_RESOURCE_TIMING: seal before attaching the expanded template root";
            return ERR_INVALID_PARAMETER;
        }
        finishing_ = true;
        // The engine performs this pass only after all instance properties and
        // owners have been restored. Invoke it once for each clone, including
        // nested local resources materialized by the native remap algorithm.
        HashSet<ObjectID> configured;
        for (const KeyValue<Ref<Resource>, Ref<Resource>>& item : remap_)
        {
            if (configured.has(item.value->get_instance_id())) continue;
            configured.insert(item.value->get_instance_id());
            item.value->setup_local_to_scene();
        }
        finishing_ = false;
        finished_ = true;
        return OK;
    }

    void ReactLocalResources::clear()
    {
        remap_.clear();
        scene_root_ = ObjectID();
        finished_ = true;
        finishing_ = false;
    }
}
