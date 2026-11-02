#ifndef GODOTJS_REACT_LOCAL_RESOURCES_H
#define GODOTJS_REACT_LOCAL_RESOURCES_H

#include "core/io/resource.h"
#include "core/templates/hash_map.h"
#include "scene/main/node.h"

namespace jsb::internal
{
    // One instance is owned by one expanded React template root. Its native
    // remap cache is deliberately shared by every property in that instance.
    // No PackedScene is instantiated and no business Node is created here.
    class ReactLocalResources
    {
        ObjectID scene_root_;
        HashMap<Ref<Resource>, Ref<Resource>> remap_;
        bool finished_ = false;
        bool finishing_ = false;

    public:
        explicit ReactLocalResources(Node* p_scene_root);
        Ref<Resource> remap(const Ref<Resource>& p_resource, String& r_error);
        Error finish(String& r_error);
        bool is_finished() const { return finished_; }
        // Safe after the native scene root has already disappeared.
        void clear();
    };
}

#endif
