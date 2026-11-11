import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
const require=createRequire(new URL('../package.json',import.meta.url));
async function load(name){const text=await fs.readFile(new URL(`../src/demos/${name}.tsx`,import.meta.url),'utf8');const {code}=await transform(text,{loader:'tsx',format:'cjs',target:'es2022'});const module={exports:{}};new Function('module','exports','require',code)(module,module.exports,id=>id==='@playground/api'?{withDemo:component=>component}:id==='godot'?{}:require(id));return module.exports;}
const match=await load('Match3'),dungeon=await load('Dungeon'),city=await load('CityBuilder');
test('match boards are deterministic, start without matches and always have a valid move',()=>{
 for(const n of [6,8,9])for(const types of [3,4,5])for(const seed of [1,17,42,999]){
  const board=match.createBoard(n,types,seed);assert.deepEqual(board,match.createBoard(n,types,seed));assert.deepEqual(match.findMatches(board),[]);
  const [x,y,xx,yy]=match.legalMove(board);[board[y][x],board[yy][xx]]=[board[yy][xx],board[y][x]];assert.ok(match.findMatches(board).length>=3);
 }
});
test('match detection merges intersecting horizontal and vertical runs',()=>{
 const board=[[0,1,0],[1,1,1],[2,1,2]];assert.deepEqual(match.findMatches(board).sort((a,b)=>a-b),[1,3,4,5,7]);
 assert.throws(()=>match.createBoard(200,5,1));
});
test('BSP rooms stay inside bounds, never overlap, and the corridor graph is connected',()=>{
 for(const size of [18,26,40])for(const seed of [1,17,99]){
  const map=dungeon.generateDungeon(size,5,seed);assert.deepEqual(map,dungeon.generateDungeon(size,5,seed));assert.ok(map.rooms.length>1);assert.equal(map.corridors.length,map.rooms.length-1);
  for(const a of map.rooms){assert.ok(a.width>0&&a.height>0&&a.x>=0&&a.y>=0&&a.x+a.width<size&&a.y+a.height<size);for(const b of map.rooms)if(a!==b)assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y);}
  const visited=new Set([0]);for(let i=0;i<map.rooms.length;i++)for(const c of map.corridors){if(visited.has(c.from))visited.add(c.to);if(visited.has(c.to))visited.add(c.from);}assert.equal(visited.size,map.rooms.length);
 }
});
test('city import round-trips valid data and rejects duplicate or out-of-bounds cells',()=>{
 const cells=[{x:0,z:1,type:2,rotation:3}];assert.deepEqual(city.validateCityMap(JSON.parse(JSON.stringify({version:1,cells}))),cells);
 for(const data of [{version:2,cells},{version:1,cells:[...cells,...cells]},{version:1,cells:[{x:99,z:0,type:0,rotation:0}]},{version:1,cells:[{x:0,z:0,type:6,rotation:0}]}])assert.throws(()=>city.validateCityMap(data));
});
