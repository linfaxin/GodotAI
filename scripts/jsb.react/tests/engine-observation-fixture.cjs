const fixture=require('./engine-native-fixture.cjs');

module.exports=function observationFixture(){
 const f=fixture(),scopes=new Set(),claims=new Map();let revision=0,sequence=0,depth=0,reads=0;
 const id=node=>String(node?.id??0);
 const push=(parent,node,kind='structure')=>{
  const change={kind,objectId:id(node),parentId:id(parent),sequence:String(++sequence)};revision++;
  for(const scope of scopes)if(scope.active&&(scope.watched.has(node)||scope.watched.has(parent)||scope.ancestors.has(node))){
   if(scope.changes.length>=4096)scope.overflow=true;else scope.changes.push(change);
  }
 };
 for(const name of ['add_child','remove_child','move_child']){
  const original=f.Node.prototype[name];f.Node.prototype[name]=function(node,...args){
   depth++;push(this,node);try{return original.call(this,node,...args);}finally{depth--;push(this,node);}
  };
 }
 const children=f.Node.prototype.get_children;f.Node.prototype.get_children=function(...args){reads++;return children.apply(this,args);};
 const free=f.Node.prototype.free;f.Node.prototype.free=function(...args){const result=free.apply(this,args);claims.delete(id(this));push(null,this,'native-retired');return result;};
 const native={abi:1,observationAbi:1,checkpointAbi:1,worldId:'fixture-world',
  openScope(){const scope={active:true,watched:new Set(),ancestors:new Set(),changes:[],overflow:false};scopes.add(scope);return scope;},
  watch(scope,node){scope.watched.add(node);for(let parent=node.parent;parent;parent=parent.parent)scope.ancestors.add(parent);return true;},
  claim(scope,node){const previous=claims.get(id(node));if(previous&&previous.scope!==scope)throw Error('E_NATIVE_CLAIM');native.watch(scope,node);claims.set(id(node),{scope,node,state:'live'});return true;},
  requestRelease(scope,node){const claim=claims.get(id(node));if(claim?.scope!==scope||claim.state==='quarantined')throw Error('E_NATIVE_CLAIM');claim.state='retiring';return true;},
  relinquish(scope,node){const claim=claims.get(id(node));if(claim?.scope!==scope)throw Error('E_NATIVE_CLAIM');claim.state='quarantined';return true;},
  closeScope(scope){const owned=[...claims.values()].filter(item=>item.scope===scope),result={pending:owned.length,retiring:owned.filter(item=>item.state==='retiring').length,quarantined:owned.filter(item=>item.state==='quarantined').length,sealed:false};if(!owned.length){scope.active=false;scope.changes.length=0;}return result;},
  takeChanges(scope){const changes=scope.changes.splice(0),overflow=scope.overflow;scope.overflow=false;return {revision:String(revision),sequence:String(sequence),mutationInProgress:depth>0,overflow,sealed:false,wrongThread:false,changes};},
  checkpoint(){return {canCommitStructure:depth===0,canDestroy:depth===0};},
 };
 return {...f,native,claims,scopes,enableBatch(before){native.requestReleaseBatch=(scope,descriptors,frontier)=>{
  before?.(descriptors,frontier);const byNode=new Map(descriptors.map(item=>[item.node,item]));
  for(const item of descriptors){const claim=claims.get(id(item.node));if(claim?.scope!==scope||claim.state!=='live'||!item.node.alive||item.node.parent!==item.parent)throw Error('E_NATIVE_RELEASE_BATCH');if(!item.opaque){const actual=item.node.get_children();if(actual.length!==item.children.length||actual.some((node,index)=>node!==item.children[index]))throw Error('E_NATIVE_RELEASE_BATCH');}}
  const visited=new Set(),visit=node=>{const item=byNode.get(node);if(!item||visited.has(node))throw Error('E_NATIVE_RELEASE_BATCH');visited.add(node);for(const child of item.children)visit(child);};for(const node of frontier)visit(node);if(visited.size!==descriptors.length)throw Error('E_NATIVE_RELEASE_BATCH');
  for(const item of descriptors)claims.get(id(item.node)).state='retiring';for(const node of frontier)node.queue_free();return true;
 };},resetReads(){reads=0;},get reads(){return reads;},overflow(){for(const scope of scopes)scope.overflow=true;}};
};
