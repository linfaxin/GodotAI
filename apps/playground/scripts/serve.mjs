import {createServer} from "node:http";
import {promises as fs} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../dist"),port=Number(process.env.PORT??4173);
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".css":"text/css; charset=utf-8",".wasm":"application/wasm",".pck":"application/octet-stream",".map":"application/json"};
export function createStaticServer(directory=root){return createServer(async(req,res)=>{
  try{const url=new URL(req.url,"http://localhost"),name=decodeURIComponent(url.pathname),file=path.resolve(directory,`.${name==="/"?"/index.html":name}`);if(!file.startsWith(`${directory}${path.sep}`)){res.writeHead(403).end();return;}
    const data=await fs.readFile(file);res.writeHead(200,{"Content-Type":mime[path.extname(file)]??"application/octet-stream","Access-Control-Allow-Origin":"*","Cache-Control":"no-cache","X-Content-Type-Options":"nosniff"});res.end(data);
  }catch{res.writeHead(404,{"Content-Type":"text/plain"}).end("Not found");}
});}
if(process.argv[1]===fileURLToPath(import.meta.url))createStaticServer().listen(port,"0.0.0.0",()=>console.log(`GodotJS Playground: http://localhost:${port}`));
