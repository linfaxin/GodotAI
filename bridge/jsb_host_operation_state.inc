// Local domain state. Never owns a Node or a VM wrapper.
            Ref<Resource> prefab;
            ObjectID prefab_root;
#if !defined(_3D_DISABLED)
            Ref<SkeletonProfile> skeleton_profile;
#else
            Ref<Resource> skeleton_profile;
#endif
            Ref<MultiMesh> multimesh_source;
            Ref<ParticleProcessMaterial> particle_source,particle_instance;
            Ref<ButtonGroup> group_source;
            Ref<Tween> tween;
            HashMap<StringName,Ref<Tween>> property_tweens;
            Variant gravity_direction,gravity_point_center;
            HashMap<int,Ref<ShaderMaterial>> shader_sources,shader_instances;
            Vector<NativeObjectID> exceptions;
            HashMap<uint64_t,RID> exception_rids;
            HashMap<StringName,NodePath> focus_paths;
            NodePath joint_a, joint_b;
            bool joint_bound = false;
            Array layout;
            Array surface_materials;
            String viewport_path, audio_bus;
            String search_text;
            int search_flags=0;
            Ref<CodeHighlighter> highlighter_source;
            int rich_images=0;
            Callable text_limit;
