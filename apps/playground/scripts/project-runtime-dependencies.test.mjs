import test from 'node:test';
import assert from 'node:assert/strict';
import {projectRuntimeDependencies as inspect} from '../src/project-runtime-dependencies.ts';

test('plain engine text, declarations and erased type imports require no React runtime',()=>{
 const files={
  '/start.ts':'import type {ReactNode} from "react"; import {EngineRoot} from "@godot-js/react"; type R=EngineRoot; console.log("react", "@playground/api"); // require("react")\nexport function start(){}',
  '/types.d.ts':'import "react";',
  '/settings.json':'{"react":"@godot-js/react", "module":"@playground/api"}',
 };
 const result=inspect(files);assert.equal(result.react,false);assert.equal(result.demo,false);assert.equal(result.modules.size,0);
});

test('actual runtime imports, reexports and lazy modules select the optional extension',()=>{
 for(const source of ['import React from "react";console.log(React);','export {EngineNode} from "@godot-js/react";','export const lazy=()=>import("@godot-js/react/engine");','const React=require("react");console.log(React);','import SDK=require("@godot-js/react");console.log(SDK);','import "react/jsx-runtime";']){
  assert.equal(inspect({'/module.ts':source}).react,true,source);
 }
 const nested=inspect({'/start.ts':'export function start(){}','/scene.ts':'export {EngineNode} from "@godot-js/react/engine";'});assert.equal(nested.react,true);
 for(const suffix of ['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'])assert.equal(inspect({['/entry'+suffix]:'import React from "react";console.log(React);'}).react,true,suffix);
});

test('module detection honors require shadowing and demo type erasure',()=>{
 for(const source of ['function f(require:any){return require("react")}','const require=(name:string)=>name;require("react");','function require(name:string){return name}require("@playground/api");','import type {Demo} from "@playground/api";export type T=Demo;']){
  const result=inspect({'/start.ts':source});assert.equal(result.react,false,source);assert.equal(result.demo,false,source);
 }
 const result=inspect({'/start.ts':'import {useDemo} from "@playground/api";export function start(){useDemo()}'});assert.equal(result.demo,true);assert.equal(result.react,true);
 const types=inspect({'/start.ts':'export type API=import("@playground/api").Demo;'});assert.equal(types.demoTypes,true);assert.equal(types.demo,false);assert.equal(types.react,false);
});
