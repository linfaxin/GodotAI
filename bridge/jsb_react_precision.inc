        Object* managed_live_node(Root& root,Object* object)
        {
            Node* node=Object::cast_to<Node>(object);if(!node||!node->is_inside_tree())return nullptr;const NativeObjectID id=environment->try_get_object_id(node);return root.nodes.has(*id)?node:nullptr;
        }
        template<class T> Object* managed_shape(Root& root,T* body,int index)
        {
            if(!body||index<0||index>65535||!managed_live_node(root,body))return nullptr;
            List<uint32_t> owners;body->get_shape_owners(&owners);int budget=4096;if(owners.size()>budget)return nullptr;
            for(uint32_t owner:owners){const int count=body->shape_owner_get_shape_count(owner);for(int j=0;j<count;++j){if(--budget<0)return nullptr;if(body->shape_owner_get_shape_index(owner,j)==index)return managed_live_node(root,body->shape_owner_get_owner(owner));}}return nullptr;
        }
        Object* shape_owner(Root& root,Node* body,int index)
        {
            if(CollisionObject2D* two=Object::cast_to<CollisionObject2D>(body))return managed_shape(root,two,index);
#if !defined(_3D_DISABLED) && !defined(PHYSICS_3D_DISABLED)
            if(CollisionObject3D* three=Object::cast_to<CollisionObject3D>(body))return managed_shape(root,three,index);
#endif
            return nullptr;
        }
        bool shape_contact_event(Root& root,Node* emitter,const Variant** args,int count,Variant& result)
        {
            if(count!=4||args[2]->get_type()!=Variant::INT||args[3]->get_type()!=Variant::INT)return false;const int64_t other=*args[2],local=*args[3];if(other<0||other>65535||local<0||local>65535)return false;
            Object* object=args[1]->get_type()==Variant::OBJECT?static_cast<Object*>(*args[1]):nullptr;Node* collider=Object::cast_to<Node>(managed_live_node(root,object));Dictionary data;data["collider"]=collider?Variant(collider):Variant();data["colliderShapeIndex"]=other;data["localShapeIndex"]=local;Object* other_shape=shape_owner(root,collider,other);Object* local_shape=shape_owner(root,emitter,local);data["colliderShape"]=other_shape?Variant(other_shape):Variant();data["localShape"]=local_shape?Variant(local_shape):Variant();result=data;return true;
        }
        bool precision_command(Root& root,Node* node,const String& operation,const Array& args,Variant& result)
        {
            if(operation=="ensure_visible"){
                if(root.stage!="process"||args.size()!=1||args[0].get_type()!=Variant::OBJECT)return false;ScrollContainer* scroll=Object::cast_to<ScrollContainer>(node);Control* target=Object::cast_to<Control>(static_cast<Object*>(args[0]));if(!scroll||!target||!managed_live_node(root,target)||!scroll->is_inside_tree()||!scroll->is_ancestor_of(target))return false;scroll->ensure_control_visible(target);return true;
            }
            if(root.stage!="physics")return false;
            if(operation=="shape_owner"){
                if(args.size()!=1||args[0].get_type()!=Variant::FLOAT||double(args[0])!=Math::floor(double(args[0]))||double(args[0])<0||double(args[0])>65535||(!Object::cast_to<CollisionObject2D>(node)&&!node->is_class("CollisionObject3D")))return false;Object* owner=shape_owner(root,node,int(args[0]));if(owner)result=owner;return true;
            }
            if(operation=="ray_shape_owner"){
                if(!args.is_empty()||(!node->is_class("RayCast2D")&&!node->is_class("RayCast3D")))return false;const bool hit=node->call("is_colliding");if(!hit)return true;Node* collider=Object::cast_to<Node>(static_cast<Object*>(node->call("get_collider")));const int index=node->call("get_collider_shape");Object* owner=shape_owner(root,collider,index);if(owner)result=owner;return true;
            }
            if(operation=="velocity_forced"){
                if(args.size()!=1)return false;if(NavigationAgent2D* two=Object::cast_to<NavigationAgent2D>(node)){if(args[0].get_type()!=Variant::VECTOR2)return false;const Vector2 velocity=args[0];if(Math::abs(velocity.x)>1e6||Math::abs(velocity.y)>1e6)return false;two->set_velocity_forced(velocity);return true;}
#if !defined(_3D_DISABLED) && !defined(NAVIGATION_3D_DISABLED)
                if(NavigationAgent3D* three=Object::cast_to<NavigationAgent3D>(node)){if(args[0].get_type()!=Variant::VECTOR3)return false;const Vector3 velocity=args[0];if(Math::abs(velocity.x)>1e6||Math::abs(velocity.y)>1e6||Math::abs(velocity.z)>1e6)return false;three->set_velocity_forced(velocity);return true;}
#endif
                return false;
            }
            return false;
        }
