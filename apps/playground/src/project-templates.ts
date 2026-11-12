import {parseProject,type EditorProject} from './project-model.ts';

/** New projects opt into the engine runtime; imported v1 projects never use these defaults. */
export function defaultProject(runtime:'godot'|'react'='godot',engineProfile='full-engine-v1'):EditorProject {
 const native=runtime==='godot';
 const entry=native?'/src/Main.ts':'/src/App.tsx';
 const source=native?`import {Node2D,Label,Vector2} from "godot";

export default class Main extends Node2D {
  _ready() {
    const label=new Label();
    label.text="Hello Godot";
    label.position=new Vector2(32,32);
    this.add_child(label);
  }
}
`:`import React from "react";
import {EngineNode} from "@godot-js/react/engine";
import {Label} from "godot";

export default function App() {
  return <EngineNode ctor={Label} native={{text:"Hello React + Godot"}} />;
}
`;
 return parseProject({schemaVersion:3,engineProfile,runtime,demoId:native?'native':'react',entry,selected:entry,files:{
  [entry]:source,
  ...(native?{'/main.tscn':'[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://src/Main.ts" id="1_main"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1_main")\n'}:{}),
  '/project.godot':`config_version=5\n\n[application]\nconfig/name="${native?'Godot':'React + Godot'} Playground"\n${native?'run/main_scene="res://main.tscn"\n':''}\n[display]\nwindow/size/viewport_width=960\nwindow/size/viewport_height=640\nwindow/stretch/mode="canvas_items"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n`,
  '/package.json':JSON.stringify({private:true,...(native?{}:{dependencies:{react:'19.3.1','@godot-js/react':'0.1.0'}})},null,2),
  '/README.md':native?'# Godot Playground\n\nEdit src/Main.ts and run the native Godot scene. Add .tscn, .tres and binary assets as normal project files.\n':'# React + Godot Playground\n\nEdit src/App.tsx. React renders into the same native Godot engine.\n',
 },controls:{},mode:'production'});
}

export function demoProject(demo:{id:string;file:string;source:string;name:string;hint:string;controls:readonly {key:string;value:number;min?:number;max?:number}[]},engineProfile='full-engine-v1'):EditorProject {
 const project=defaultProject('react',engineProfile);project.demoApiVersion=1;project.demoId=demo.id;delete project.files[project.entry];project.entry=project.selected='/src/'+demo.file;project.files[project.entry]=demo.source;
 project.controls=Object.fromEntries(demo.controls.map(control=>[control.key,control.value]));
 project.files['/README.md']='# '+demo.name+'\n\n'+demo.hint+'\n\nUses the native React renderer and Godot resources.\n';
 return parseProject(project);
}

/** Upgrade a bundled example once, keeping its complete original document. */
export function migrateDemoProject(project:EditorProject,demo:Parameters<typeof demoProject>[0]):EditorProject {
 if(!project.migration?.removedRenderer||project.entry!=='/src/'+demo.file)return project;
 const next=demoProject(demo,project.engineProfile);next.controls={...next.controls,...project.controls};next.mode=project.mode;
 for(const control of demo.controls)next.controls[control.key]=Math.max(control.min??-Infinity,Math.min(control.max??Infinity,next.controls[control.key]));
 next.migration={...project.migration,removedRenderer:false};return next;
}
