const test=require('node:test');const assert=require('node:assert/strict');const {createGodotPort}=require('../dist/godot');
test('quaternion and full transforms cross the private bridge as typed immutable values',()=>{
 let args;const bridge={abi:1,openRoot:()=>({cap:{},key:{slot:1,revision:1}}),audit(){},quiesceRoot(){},closeRoot(){},takeInvalidations:()=>[],call(_cap,_key,_name,value){args=value;return {kind:'Transform3D',basis:{x:{kind:'Vector3',x:1,y:0,z:0},y:{kind:'Vector3',x:0,y:1,z:0},z:{kind:'Vector3',x:0,y:0,z:1}},origin:{kind:'Vector3',x:2,y:3,z:4}};}};
 const {port}=createGodotPort({}, {rootId:'codec',rootInstance:'codec',bridge});const result=port.command({slot:1,revision:1},'pose',[{x:0,y:0,z:0,w:1}]);assert.equal(args[0].kind,'Quaternion');assert.deepEqual(result.origin,{x:2,y:3,z:4});assert.equal(Object.isFrozen(result.basis.x),true);
});
