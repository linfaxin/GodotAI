const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');
const {EngineNode,useFrame}=require('../dist/engine');
const fixture=require('./engine-native-fixture.cjs');
const h=React.createElement;

test('uncaught render and commit failures retain their error and component context',()=>{
 for(const phase of ['render','commit']){
  const f=fixture(),reports=[],failure=new Error('expected '+phase),root=f.setup({onError:(error,info)=>reports.push({error,info})});
  function Broken(){if(phase==='render')throw failure;React.useLayoutEffect(()=>{throw failure;},[]);return h(EngineNode,{ctor:f.Label});}
  root.render(h(Broken));
  assert(reports.some(item=>item.error===failure&&item.info.kind==='uncaught'&&item.info.componentStack.includes('Broken')));
  root.shutdown();f.flushDeletes();assert.equal(f.container.children.length,0);
 }
});

test('ErrorBoundary recovery is caught and frame callback failures are runtime errors',()=>{
 const f=fixture(),reports=[],root=f.setup({onError:(error,info)=>reports.push({error,info})});
 class Boundary extends React.Component{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?h(EngineNode,{ctor:f.Label,native:{text:'recovered'}}):this.props.children;}
 }
 function Broken(){throw Error('caught failure');}
 root.render(h(Boundary,null,h(Broken)));
 assert.equal(f.container.children[0].get('text'),'recovered');
 assert(reports.some(item=>item.info.kind==='caught'));assert(!reports.some(item=>item.info.kind==='uncaught'));
 function Framed(){useFrame('process',()=>{throw Error('frame failure');});return h(EngineNode,{ctor:f.Label});}
 root.render(h(Framed));root.process(.016);
 assert(reports.some(item=>item.info.kind==='runtime'&&String(item.error).includes('frame failure')));
 root.shutdown();f.flushDeletes();assert.equal(f.container.children.length,0);
});
