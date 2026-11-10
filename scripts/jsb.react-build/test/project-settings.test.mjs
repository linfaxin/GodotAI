import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeProjectText,readProjectBooleanSetting,readProjectStringSetting as read,writeProjectStringSetting as write} from '@godot-js/react-build/project-settings';

test('project settings use the final assignment across repeated sections',()=>{
 const source='[application]\nrun/main_scene="res://First.tscn"\nrun/main_scene="res://Second.tscn" ; comment\n[other]\nkeep=42\n[application] # repeated\nrun/main_scene="res://Last.tscn"\n';
 assert.equal(read(source,'application','run/main_scene'),'res://Last.tscn');
 const changed=write(source,'application','run/main_scene','res://Next.tscn');
 assert.equal(read(changed,'application','run/main_scene'),'res://Next.tscn');
 assert.equal(changed.match(/run\/main_scene="res:\/\/Next.tscn"/g).length,3);
 assert.match(changed,/\[other\]\nkeep=42/);
 assert.equal(read(source+'run/main_scene=42\n','application','run/main_scene'),undefined);
 assert.equal(read(source+'run/main_scene=""\n','application','run/main_scene'),'');
});
test('text and UTF-8 byte configurations share boolean and string setting semantics',()=>{
 const source='[GodotJS]\nruntime/core/camel_case_bindings_enabled=false\n[GodotJS]\nruntime/core/camel_case_bindings_enabled=true ; last\n[application]\nrun/main_scene="res://世界.tscn"\n';
 for(const value of [source,new TextEncoder().encode(source),[...new TextEncoder().encode(source)]]){
  const text=decodeProjectText(value);assert.equal(readProjectBooleanSetting(text,'GodotJS','runtime/core/camel_case_bindings_enabled'),true);
  assert.equal(read(text,'application','run/main_scene'),'res://世界.tscn');
 }
 assert.equal(readProjectBooleanSetting(source+'[GodotJS]\nruntime/core/camel_case_bindings_enabled=false\n','GodotJS','runtime/core/camel_case_bindings_enabled'),false);
 assert.throws(()=>decodeProjectText([255]),/UTF-8/);assert.throws(()=>decodeProjectText([256]),/UTF-8/);
});
test('missing settings are inserted into the final matching section, preserving CRLF',()=>{
 const source='[application]\r\nname="a"\r\n[other]\r\nkeep=42\r\n[application]\r\nname="b"\r\n';
 const changed=write(source,'application','run/main_scene','res://世界.tscn');
 assert.equal(read(changed,'application','run/main_scene'),'res://世界.tscn');
 assert.equal(changed.replaceAll('\r\n','').includes('\n'),false);
 assert.match(changed,/name="b"\r\n\r\nrun\/main_scene=/);
 assert.equal(read(write('[other]\nkeep=42\n','application','run/main_scene','res://main.tscn'),'application','run/main_scene'),'res://main.tscn');
});
