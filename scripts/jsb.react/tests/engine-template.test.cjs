const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const React=require('react');
const fixture=require('./engine-native-fixture.cjs');
const C=require('../dist/engine-components');
const {getHostSchema}=require('../dist/schema');
const h=React.createElement;
let resourceScopes;
const originalLoad=Module._load;
Module._load=function(name,...args){return name==='godot-jsb'?{internal:{resource_scopes:resourceScopes}}:originalLoad.call(this,name,...args);};

function plan(profile='template-local-v1'){
 const source={source:'res://templates/Panel.tscn',line:1,column:1};
 const material={kind:'asset',id:'panel-material',type:'CanvasItemMaterial',scope:'shared'};
 return {schemaVersion:1,assetId:'panel',source:source.source,sourceHash:'a'.repeat(64),snapshotHash:'b'.repeat(64),profile,rootId:'root',
  nodes:[{nodeId:'root',nativeType:'Node2D',parentId:null,siblingOrder:0,name:'Panel',initial:{material,position:{x:2,y:3}},ownerId:null,source},
   {nodeId:'caption',nativeType:'Label',parentId:'root',siblingOrder:0,name:'Caption',initial:{material,text:'caption'},ownerId:'root',source}],
  resources:[{resourceId:material.id,type:material.type,uri:'res://assets/panel-material.tres',sha256:'c'.repeat(64),dependencies:[],sharingPolicy:profile==='template-local-v1'?'instance':'shared'}]};
}
function setup(options={}){
 const f=fixture(),opened=[],closed=[],finished=[];let serial=10000;
 f.setAutoPump(false);
 f.godot.Color=class Color{constructor(r,g,b,a){Object.assign(this,{r,g,b,a});}};
 class Resource{constructor(){this.id=++serial;}get_instance_id(){return this.id;}get_class(){return 'CanvasItemMaterial';}is_class(name){return ['Resource','CanvasItemMaterial'].includes(name);}}
 const source=new Resource();
 f.godot.ResourceLoader={load(path){assert.equal(path,'res://assets/panel-material.tres');return source;}};
 const set=f.Node.prototype.set;f.Node.prototype.set=function(name,value){if(name==='owner'){assert(!this.is_inside_tree());this.owner=value;}return set.call(this,name,value);};
 for(const type of ['Node2D','Label']){
  const Host=class extends f.Node{constructor(){super();for(const p of Object.values(getHostSchema(type).properties))if(!Object.hasOwn(this.properties,p.nativeName))this.properties[p.nativeName]=p.defaultValue;}};
  Object.defineProperty(Host,'name',{value:type});f.godot[type]=Host;
 }
 resourceScopes={abi:1,
  open(root){assert.equal(root.parent,null);assert.equal(root.is_inside_tree(),false);const value={root,mappings:new Map(),finished:false,closed:false};opened.push(value);return value;},
  remap(scope,resource){assert(!scope.closed);if(scope.mappings.has(resource))return scope.mappings.get(resource);assert(!scope.finished);const local=new Resource();local.localScene=scope.root;scope.mappings.set(resource,local);return local;},
  finish(scope){assert.equal(scope.root.parent,null);assert.equal(scope.root.children.length,1);assert.equal(scope.root.children[0].owner,scope.root);assert.equal(scope.root.get('material'),scope.root.children[0].get('material'));scope.finished=true;finished.push(scope);return true;},
  close(scope){assert(!scope.closed);scope.closed=true;closed.push(scope);return true;},
 };
 const root=f.setup({onError(){}}),services=C.configureEngineComponents(root,{mode:'development',...options});
 return {...f,root,services,source,opened,closed,finished};
}
async function close(f){f.root.requestShutdown();await f.flushDeletes();assert.deepEqual(f.root.getErrors(),[]);assert.equal((await f.root.close()).status,'complete');}

test('expanded templates seal native aliases and owners before attachment and retain instance DTOs',async()=>{
 const f=setup(),Panel=C.createTemplateComponent(plan()),a=React.createRef(),b=React.createRef();
 f.root.render(h(React.Fragment,null,h(Panel,{key:'a',name:'A',ref:a}),h(Panel,{key:'b',name:'B',ref:b})));
 assert.deepEqual(f.root.getErrors(),[]);assert.equal(f.opened.length,2);assert.equal(f.finished.length,2);
 const an=C.engineHandleNode(a.current,f.root),bn=C.engineHandleNode(b.current,f.root),material=an.get('material');
 assert.equal(material,an.children[0].get('material'));assert.notEqual(material,bn.get('material'));assert.notEqual(material,f.source);assert.equal(material.localScene,an);
 const dto=a.current.read('material');assert.deepEqual(dto,{kind:'asset',id:'panel-material',type:'CanvasItemMaterial',scope:'instance'});assert(Object.isFrozen(dto));assert.equal(typeof dto.get_instance_id,'undefined');
 f.root.render(h(React.Fragment,null,h(Panel,{key:'a',name:'A',ref:a,initial:{position:{x:99,y:99}}}),h(Panel,{key:'b',name:'B',ref:b})));
 assert.deepEqual(a.current.readPosition(),{x:2,y:3});assert.equal(an.get('material'),material);assert.equal(f.opened.length,2);
 const old=a.current,oldB=b.current;
 f.root.render(h(React.Fragment,null,h(Panel,{key:'new-a',name:'A',ref:a}),h(Panel,{key:'b',name:'B',ref:b})));await f.flushDeletes();
 assert.equal(old.isValid(),false);assert.equal(b.current,oldB);assert.equal(bn.get('material'),f.opened[1].mappings.get(f.source));assert.notEqual(C.engineHandleNode(a.current,f.root).get('material'),material);assert.equal(f.closed.length,1);
 await close(f);assert.equal(f.closed.length,3);
});

test('shared template resources preserve source identity without requiring local-resource native ABI',async()=>{
 const f=setup(),Panel=C.createTemplateComponent(plan('template-t0')),ref=React.createRef();resourceScopes=undefined;
 f.root.render(h(Panel,{ref}));assert.deepEqual(f.root.getErrors(),[]);assert.equal(C.engineHandleNode(ref.current,f.root).get('material'),f.source);assert.deepEqual(ref.current.read('material'),{kind:'asset',id:'panel-material',type:'CanvasItemMaterial',scope:'shared'});assert.equal(f.opened.length,0);await close(f);
});

test('manifest template resources use the real asset service once and validate manifest type and URI',async()=>{
 const assets={'panel-material':{type:'CanvasItemMaterial',uri:'res://assets/panel-material.tres'}},f=setup({assets}),Panel=C.createTemplateComponent(plan());
 f.root.render(h(React.Fragment,null,h(Panel,{name:'A'}),h(Panel,{name:'B'})));assert.deepEqual(f.root.getErrors(),[]);
 assert.deepEqual(f.services.assetStatus(),{requested:['panel-material'],ready:['panel-material'],failures:[]});assert.equal(f.opened.length,2);assert.notEqual(f.opened[0].mappings.get(f.source),f.opened[1].mappings.get(f.source));await close(f);
 for(const resource of [{type:'Resource',uri:assets['panel-material'].uri},{type:'CanvasItemMaterial',uri:'res://assets/other.tres'}]){
  const g=setup({assets:{'panel-material':resource}});g.root.render(h(Panel));assert(g.root.getErrors().some(error=>String(error).includes('differs from the registered manifest')));assert.deepEqual(g.services.assetStatus().requested,[]);g.root.requestShutdown();await g.flushDeletes();
 }
});

test('template creation snapshots its plan and rejects unsupported children before native allocation',async()=>{
 const f=setup(),input=plan(),Panel=C.createTemplateComponent(input),ref=React.createRef();input.nodes[0].initial.position.x=500;input.nodes[1].name='Changed';
 f.root.render(h(Panel,{ref}));assert.deepEqual(ref.current.readPosition(),{x:2,y:3});assert.equal(C.engineHandleNode(ref.current,f.root).children[0].get('name'),'Caption');await close(f);
 const g=setup(),before=g.root.getStats().created;g.root.render(h(Panel,null,h(C.Label,{text:'unexpected'})));assert(g.root.getErrors().some(error=>String(error).includes('E_TEMPLATE_CHILDREN')));assert.equal(g.root.getStats().created,before);g.root.requestShutdown();await g.flushDeletes();
});
