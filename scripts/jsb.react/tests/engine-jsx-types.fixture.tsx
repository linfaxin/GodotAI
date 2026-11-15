import * as React from 'react';
import {EngineNode,createNativeComponent} from '../dist/engine';

class NativeNode {
  text='';
  readonly immutable=1;
  readonly pressed!: {emit:(count:number)=>void};
  set_text(_text:string):void {}
}
class Other {other='';}
const object=new NativeNode(),ref=React.createRef<NativeNode>();
const constructed=<EngineNode ctor={NativeNode} native={{text:'native'}} ref={ref} on={{pressed:count=>{count.toFixed();}}}/>;
const adopted=<EngineNode object={object} ownership="adopt" native={{text:'adopted'}} ref={ref} on={{pressed:count=>{count.toFixed();}}}/>;
// @ts-expect-error JSX constructor native values retain their declared types
const wrongConstructor=<EngineNode ctor={NativeNode} native={{text:1}}/>;
// @ts-expect-error JSX adoption derives its native types from object
const wrongAdopted=<EngineNode object={object} ownership="adopt" native={{text:1}}/>;
// @ts-expect-error native values cannot add fields to the adopted object type
const unknownAdopted=<EngineNode object={object} ownership="adopt" native={{absent:true}}/>;
// @ts-expect-error JSX adoption cannot assign readonly native fields
const readonlyAdopted=<EngineNode object={object} ownership="adopt" native={{immutable:2}}/>;
// @ts-expect-error JSX adoption cannot assign native methods
const methodAdopted=<EngineNode object={object} ownership="adopt" native={{set_text:()=>{}}}/>;
// @ts-expect-error JSX ref does not widen the adopted object type
const wrongRef=<EngineNode object={object} ownership="adopt" ref={React.createRef<Other>()}/>;
// @ts-expect-error JSX event does not widen the adopted object type
const wrongEvent=<EngineNode object={object} ownership="adopt" on={{pressed:(_count:string)=>{}}}/>;
// @ts-expect-error JSX constructor and adoption identities are mutually exclusive
const mixedIdentity=<EngineNode ctor={NativeNode} object={new Other()} ownership="adopt" native={{text:'wrong target'}}/>;
// @ts-expect-error JSX adopted nodes do not accept constructor arguments
const adoptedArgs=<EngineNode object={object} ownership="adopt" args={[]}/>;
const Label=createNativeComponent(NativeNode);
const bound=<Label native={{text:'bound'}} ref={ref}/>;
// @ts-expect-error JSX bound factory preserves native property types
const wrongBound=<Label native={{text:1}}/>;
void constructed;void adopted;void bound;
