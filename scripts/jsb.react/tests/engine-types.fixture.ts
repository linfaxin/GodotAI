import * as React from 'react';
import {EngineNode, createNativeComponent, type NativeProperties, type NativeEvents, type AdoptedNodeProps, type EngineNodeProps} from '../dist/engine';
import {createRoot, type EngineRoot} from '../dist';
import {createRoot as createLegacyRoot, type ReactRoot} from '../dist/legacy';
import {MockNativePort} from '../dist/testing';
class Label {
  text='';position={x:0,y:0};readonly immutable=1;
  readonly pressed!: {emit:(count:number)=>void};
  set_text(_text:string):void {}
}
class Other { other=''; }
const ref=React.createRef<Label>();
EngineNode({ctor:Label,native:{text:'works',position:{x:1,y:2}},on:{pressed:count=>{count.toFixed();}},ref});
// @ts-expect-error native ctor props preserve their actual value type
EngineNode({ctor:Label,native:{text:1}});
// @ts-expect-error properties are inferred from the given ctor
EngineNode({ctor:Label,native:{absent:true}});
// @ts-expect-error refs expose the real native instance type
EngineNode({ctor:Label,ref:React.createRef<Other>()});
// @ts-expect-error native methods are not declarative properties
const badMethod:NativeProperties<Label>={set_text:()=>{}};
// @ts-expect-error readonly native fields cannot be declaratively assigned
const readonly:NativeProperties<Label>={immutable:2};
// @ts-expect-error signal payloads preserve native parameter types
const wrongPayload:NativeEvents<Label>={pressed:(_count:string)=>{}};
const Component=createNativeComponent(Label);
React.createElement(Component,{native:{text:'works'},ref});
// @ts-expect-error factory retains constructor property inference
React.createElement(Component,{native:{text:9}});
// @ts-expect-error factory retains native ref inference
React.createElement(Component,{ref:React.createRef<Other>()});
const adopted=new Label();
EngineNode({object:adopted,ownership:'adopt',native:{text:'adopted'},on:{pressed:count=>{count.toFixed();}},ref});
// @ts-expect-error object fixes adopted native property types
EngineNode({object:adopted,ownership:'adopt',native:{text:1}});
// @ts-expect-error adopted instances do not expose unknown native fields
EngineNode({object:adopted,ownership:'adopt',native:{absent:true}});
// @ts-expect-error adopted methods cannot be assigned as properties
EngineNode({object:adopted,ownership:'adopt',native:{set_text:()=>{}}});
// @ts-expect-error adopted readonly fields cannot be assigned
EngineNode({object:adopted,ownership:'adopt',native:{immutable:2}});
// @ts-expect-error ref cannot widen the inferred adopted object type
EngineNode({object:adopted,ownership:'adopt',ref:React.createRef<Other>()});
// @ts-expect-error native event payload cannot widen the adopted object type
EngineNode({object:adopted,ownership:'adopt',on:{pressed:(_count:string)=>{}}});
// @ts-expect-error constructor and adoption identities are mutually exclusive
EngineNode({ctor:Label,object:new Other(),ownership:'adopt',native:{text:'wrong target'}});
// @ts-expect-error adoption does not accept constructor arguments
EngineNode({object:adopted,ownership:'adopt',args:[]});
React.createElement<AdoptedNodeProps<Label>>(EngineNode,{object:adopted,ownership:'adopt',native:{text:'typed createElement'},ref});
// @ts-expect-error createElement can retain adoption types with its explicit props argument
React.createElement<AdoptedNodeProps<Label>>(EngineNode,{object:adopted,ownership:'adopt',native:{text:1}});
// @ts-expect-error explicit adopted props reject unknown native fields
React.createElement<AdoptedNodeProps<Label>>(EngineNode,{object:adopted,ownership:'adopt',native:{absent:true}});
// @ts-expect-error explicit adopted props reject readonly native fields
React.createElement<AdoptedNodeProps<Label>>(EngineNode,{object:adopted,ownership:'adopt',native:{immutable:2}});
// @ts-expect-error explicit adopted props reject native methods as properties
React.createElement<AdoptedNodeProps<Label>>(EngineNode,{object:adopted,ownership:'adopt',native:{set_text:()=>{}}});
// @ts-expect-error createElement retains the explicitly selected adopted native ref
React.createElement<AdoptedNodeProps<Label>>(EngineNode,{object:adopted,ownership:'adopt',ref:React.createRef<Other>()});
React.createElement<EngineNodeProps<typeof Label>>(EngineNode,{ctor:Label,native:{text:'typed constructor'}});
// @ts-expect-error explicitly instantiated createElement retains constructor native types
React.createElement<EngineNodeProps<typeof Label>>(EngineNode,{ctor:Label,native:{text:1}});
const nativeRoot:EngineRoot=createRoot(new Label(),{godot:{},autoProcess:false});
const port=new MockNativePort();
const legacyRoot:ReactRoot=createLegacyRoot(port,port.createContainer(),{generation:'typed-legacy'});
// @ts-expect-error native options do not accept legacy profile configuration
createRoot(new Label(),{profileId:'showcase-v1'});
// @ts-expect-error the three-argument legacy overload requires a NativePort
createRoot(new Label(),port.createContainer(),{generation:'wrong-port'});
void nativeRoot;void legacyRoot;
