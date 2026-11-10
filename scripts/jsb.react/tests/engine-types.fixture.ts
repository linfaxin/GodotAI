import * as React from 'react';
import {EngineNode, createNativeComponent, type NativeProperties, type NativeEvents} from '../dist/engine';
import {createRoot, type EngineRoot, type ReactRoot} from '../dist';
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
const nativeRoot:EngineRoot=createRoot(new Label(),{godot:{},autoProcess:false});
const port=new MockNativePort();
const legacyRoot:ReactRoot=createRoot(port,port.createContainer(),{generation:'typed-legacy'});
// @ts-expect-error native options do not accept legacy profile configuration
createRoot(new Label(),{profileId:'showcase-v1'});
// @ts-expect-error the three-argument legacy overload requires a NativePort
createRoot(new Label(),port.createContainer(),{generation:'wrong-port'});
void nativeRoot;void legacyRoot;
