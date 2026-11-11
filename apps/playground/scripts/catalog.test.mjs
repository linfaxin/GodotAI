import test from "node:test";
import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {catalog} from "../src/catalog.ts";
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
test("all upstream inputs are pinned and retain their recorded checksums",async()=>{
 const sources=JSON.parse(await fs.readFile(path.join(app,"third-party/sources.json"),"utf8"));
 assert.ok(sources.length>10);
 for(const source of sources){assert.match(source.commit,/^[a-f0-9]{40}$/);assert.equal(createHash("sha256").update(await fs.readFile(path.join(app,source.local))).digest("hex"),source.sha256);}
});
test("every catalog demo has source and bounded default controls",async()=>{
 assert.equal(new Set(catalog.map(d=>d.id)).size,8);
 for(const demo of catalog){assert.match(await fs.readFile(path.join(app,"src/demos",demo.file),"utf8"),/export default (?:function|withDemo)/);for(const control of demo.controls)assert.ok(control.min<=control.value&&control.value<=control.max&&control.step>0);}
});
