import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {catalog} from '../src/catalog.ts';
import {buildFrontend} from './build-frontend.mjs';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function writeTypeSnapshot(dist){
 const types={};
 async function collect(directory,prefix,filter){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const p=path.join(directory,entry.name),key=`${prefix}/${entry.name}`;if(entry.isDirectory())await collect(p,key,filter);else if(filter(entry.name))types[key]=await fs.readFile(p,'utf8');}}
 await collect(path.resolve(app,'../../scripts/jsb.react/dist'),'/sdk',name=>name.endsWith('.d.ts'));
 await collect(path.dirname(fileURLToPath(import.meta.resolve('@types/react/package.json'))),'/react',name=>name.endsWith('.d.ts'));
 await collect(path.dirname(fileURLToPath(import.meta.resolve('typescript/lib/typescript.js'))),'/lib',name=>/^lib\..*\.d\.ts$/.test(name));
 types['/api.d.ts']=await fs.readFile(path.join(app,'src/editor-api.d.ts'),'utf8');
 await fs.writeFile(path.join(dist,'types.json'),JSON.stringify(types));
}
export async function buildShell(dist=path.join(app,'dist')){
 await fs.mkdir(dist,{recursive:true});await fs.cp(path.join(app,'web'),dist,{recursive:true});
 const demos=await Promise.all(catalog.map(async demo=>({...demo,source:await fs.readFile(path.join(app,'src/demos',demo.file),'utf8')})));
 await fs.writeFile(path.join(dist,'catalog.json'),JSON.stringify(demos));
 await writeTypeSnapshot(dist);await buildFrontend(dist);
}
if(process.argv[1]===fileURLToPath(import.meta.url))await buildShell();
