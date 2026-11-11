/** Included as an ordinary GodotJS script so native virtual input callbacks bind normally. */
export const DEMO_INPUT_SOURCE=`declare const require:(name:string)=>any;
const G=require('godot'),api=require('@playground/api');
export default class PlaygroundInput extends G.Node {
 // Godot runs this Node after the bootstrap's process/physics dispatch. Input
 // cleanup therefore stays last even when React adds frame subscribers later.
 _ready(){this.set('process_priority',2147483647);this.set('process_physics_priority',2147483647);}
 _process(){api.finishDemoInput('process');}
 _physics_process(){api.finishDemoInput('physics');}
 _input(event:any){api.forwardDemoInput(event);}
 _notification(what:number){if(what===1005||what===2017)api.clearDemoInput();}
}
`;
