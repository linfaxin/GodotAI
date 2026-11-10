import type {HostSchema,PropertySchema,CommandSchema} from './core';
import type {CodecName,CodecValue} from './codecs';
const p=(publicName:string,nativeName:string,codec:CodecName,defaultValue:CodecValue,extra:Partial<PropertySchema>={}):PropertySchema=>Object.freeze({publicName,nativeName,accessName:nativeName,codec,defaultValue,aliases:Object.freeze([publicName]),...extra});
const command=(publicName:string,nativeName:string,args:CodecName[],effects:string[]=[],result?:CodecName):CommandSchema=>Object.freeze({publicName,nativeName,arguments:Object.freeze(args),effects:Object.freeze(effects),phase:'process',...(result?{result}:{})});
const resource=(name:string,native:string,types:string[])=>p(name,native,'assetRef',null,{resourceTypes:Object.freeze(types)});
function host(type:string,base:HostSchema,properties:Record<string,PropertySchema>,commands:Record<string,CommandSchema>):HostSchema{return Object.freeze({...base,type,nativeType:type,properties:Object.freeze({...base.properties,...properties}),commands:Object.freeze({...base.commands,...commands})});}
const sceneCommands={
 listSceneNodes:command('listSceneNodes','__react_scene_nodes',[],[],'stringArray'),
 getSceneAnimations:command('getSceneAnimations','__react_scene_animations',['string'],[],'stringArray'),
 playSceneAnimation:command('playSceneAnimation','__react_scene_play',['string','stringName','number','number','boolean'],['prefabPlayback']),
 stopSceneAnimation:command('stopSceneAnimation','__react_scene_stop',['string','boolean'],['prefabPlayback']),
 advanceSceneAnimation:command('advanceSceneAnimation','__react_scene_advance',['string','number'],['prefabPlayback']),
 getScenePosition2D:command('getScenePosition2D','__react_scene_position2d',['string'],[],'vector2'),
 getSceneState:command('getSceneState','__react_scene_state',['string'],[],'stringName'),
 startSceneState:command('startSceneState','__react_scene_start',['string','stringName'],['prefabPlayback']),
 setSceneParameterInteger:command('setSceneParameterInteger','__react_scene_parameter_integer',['string','string','integer'],['prefabPlayback']),
 setSceneParameterBoolean:command('setSceneParameterBoolean','__react_scene_parameter_boolean',['string','string','boolean'],['prefabPlayback']),
 setSceneParameterVector2:command('setSceneParameterVector2','__react_scene_parameter_vector2',['string','string','vector2'],['prefabPlayback']),
 getScenePosition:command('getScenePosition','__react_scene_position',['string'],[],'vector3'),
 isSceneAnimationPlaying:command('isSceneAnimationPlaying','__react_scene_is_playing',['string'],[],'boolean'),
 getSceneAnimationPosition:command('getSceneAnimationPosition','__react_scene_animation_position',['string'],[],'number'),
 setSceneBonePosition:command('setSceneBonePosition','__react_scene_bone_set_position',['string','integer','vector3'],['prefabPose']),
 setSceneBoneRotation:command('setSceneBoneRotation','__react_scene_bone_set_rotation',['string','integer','quaternion'],['prefabPose']),
 setSceneBoneScale:command('setSceneBoneScale','__react_scene_bone_set_scale',['string','integer','vector3'],['prefabPose']),
 resetSceneBonePoses:command('resetSceneBonePoses','__react_scene_bone_reset',['string'],['prefabPose']),
 getSceneBoneCount:command('getSceneBoneCount','__react_scene_bone_count',['string'],[],'integer'),
 getSceneBonePosition:command('getSceneBonePosition','__react_scene_bone_position',['string','integer'],[],'vector3'),
 getSceneBoneRotation:command('getSceneBoneRotation','__react_scene_bone_rotation',['string','integer'],[],'quaternion'),
 setSceneParameter:command('setSceneParameter','__react_scene_parameter',['string','string','number'],['prefabPlayback']),
 travelSceneState:command('travelSceneState','__react_scene_travel',['string','stringName'],['prefabPlayback']),
};
export function extendAdvancedScenes(base:Readonly<Record<string,HostSchema>>):Readonly<Record<string,HostSchema>>{
 return Object.freeze({...base,
 MeshInstance3D:host('MeshInstance3D',base.MeshInstance3D!,{skin:resource('skin','skin',['Skin']),skeleton:p('skeleton','skeleton','string','..')},{}),
 AnimationPlayer:host('AnimationPlayer',base.AnimationPlayer!,{library:p('library','__react_animation_library','assetRef',null,{resourceTypes:Object.freeze(['AnimationLibrary']),aliases:Object.freeze(['animationLibraries'])})},{}),
 Node2D:host('Node2D',base.Node2D!,{packedScene:resource('packedScene','__react_packed_scene',['PackedScene'])},sceneCommands),
 Node3D:host('Node3D',base.Node3D!,{packedScene:resource('packedScene','__react_packed_scene',['PackedScene'])},sceneCommands),
 BoneAttachment3D:Object.freeze({...host('BoneAttachment3D',base.Node3D!,{boneName:p('boneName','bone_name','stringName','')},{}),intrinsicEngineOwned:Object.freeze(['transform3d'])}),
 Skeleton3D:host('Skeleton3D',base.Node3D!,{profile:p('profile','__react_skeleton_profile','assetRef',null,{resourceTypes:Object.freeze(['SkeletonProfile']),aliases:Object.freeze(['bones'])}),showRestOnly:p('showRestOnly','show_rest_only','boolean',false)}, {
 getBoneCount:command('getBoneCount','get_bone_count',[],[],'integer'),
 getBonePosePosition:command('getBonePosePosition','get_bone_pose_position',['integer'],[],'vector3'),
 getBonePoseRotation:command('getBonePoseRotation','get_bone_pose_rotation',['integer'],[],'quaternion'),
 getBoneGlobalPose:command('getBoneGlobalPose','get_bone_global_pose',['integer'],[],'transform3d'),
 setBonePosePosition:command('setBonePosePosition','set_bone_pose_position',['integer','vector3'],['bones']),
 setBonePoseRotation:command('setBonePoseRotation','set_bone_pose_rotation',['integer','quaternion'],['bones']),
 setBonePoseScale:command('setBonePoseScale','set_bone_pose_scale',['integer','vector3'],['bones']),
 resetBonePoses:command('resetBonePoses','reset_bone_poses',[],['bones']),
 }),
 AnimationTree:host('AnimationTree',base.Node!,{treeRoot:resource('treeRoot','tree_root',['AnimationNodeBlendTree','AnimationNodeStateMachine','AnimationNodeBlendSpace1D','AnimationNodeBlendSpace2D']),animPlayer:p('animPlayer','anim_player','string',''),active:p('active','active','boolean',false),callbackModeProcess:p('callbackModeProcess','callback_mode_process','integer',1,{minimum:0,maximum:2})},{
 setParameterNumber:command('setParameterNumber','__react_tree_number',['string','number'],['animationParameters']),
 setParameterInteger:command('setParameterInteger','__react_tree_integer',['string','integer'],['animationParameters']),
 setParameterBoolean:command('setParameterBoolean','__react_tree_boolean',['string','boolean'],['animationParameters']),
 setParameterVector2:command('setParameterVector2','__react_tree_vector2',['string','vector2'],['animationParameters']),
 travel:command('travel','__react_tree_travel',['stringName'],['playback']),startState:command('startState','__react_tree_start',['stringName'],['playback']),getCurrentState:command('getCurrentState','__react_tree_state',[],[],'stringName'),advance:command('advance','advance',['number'],['playback']),
 })});
}
