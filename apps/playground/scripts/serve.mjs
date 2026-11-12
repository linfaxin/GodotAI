import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(process.env.PLAYGROUND_DIRECTORY??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist')),port=Number(process.env.PORT??4173);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm','.pck':'application/octet-stream','.map':'application/json'};
const compressible=new Set(Object.keys(mime));
function encodings(header=''){
 const values=new Map(String(header).split(',').map(value=>{const [name,...parameters]=value.trim().toLowerCase().split(';');const q=parameters.find(p=>p.trim().startsWith('q='));return [name,q?Number(q.trim().slice(2)):1];}));
 return ['br','gzip'].map(name=>({name,q:values.get(name)??values.get('*')??0})).filter(v=>Number.isFinite(v.q)&&v.q>0).sort((a,b)=>b.q-a.q).map(v=>v.name);
}
/** Public immutable caching is explicit and limited to versioned release URLs. */
export function createStaticServer(directory=root,{publicImmutable=false,allowedEncodings=['br','gzip']}={}){
 directory=path.resolve(directory);
 return createServer(async(req,res)=>{
  try{
   if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'}).end();return;}
   const url=new URL(req.url,'http://localhost'),name=decodeURIComponent(url.pathname),file=path.resolve(directory,`.${name==='/'?'/index.html':name}`);
   if(!file.startsWith(`${directory}${path.sep}`)){res.writeHead(403).end();return;}
   const actual=await fs.realpath(file),realDirectory=await fs.realpath(directory);if(!actual.startsWith(`${realDirectory}${path.sep}`)){res.writeHead(403).end();return;}
   let data=await fs.readFile(file),encoding;const modified=(await fs.stat(file)).mtimeMs;
   if(compressible.has(path.extname(file)))for(const preferred of encodings(req.headers['accept-encoding']).filter(name=>allowedEncodings.includes(name))){
    try{const variant=await fs.realpath(file+(preferred==='br'?'.br':'.gz'));if(!variant.startsWith(`${realDirectory}${path.sep}`)||(await fs.stat(variant)).mtimeMs<modified)continue;data=await fs.readFile(variant);encoding=preferred;break;}catch(error){if(error.code!=='ENOENT')throw error;}
   }
   const immutable=publicImmutable&&/^\/releases\/[A-Za-z0-9_-]{8,}\//.test(name)&&!name.endsWith('/');
   const etag='"'+createHash('sha256').update(data).digest('hex')+'"';
   const headers={'Content-Type':mime[path.extname(file)]??'application/octet-stream','Access-Control-Allow-Origin':'*','Cache-Control':immutable?'public, max-age=31536000, immutable':'no-cache','X-Content-Type-Options':'nosniff','Vary':'Accept-Encoding','ETag':etag,...(encoding?{'Content-Encoding':encoding}:{})};
   if(req.headers['if-none-match']===etag){res.writeHead(304,headers).end();return;}
   res.writeHead(200,{...headers,'Content-Length':data.length});res.end(req.method==='HEAD'?undefined:data);
  }catch{res.writeHead(404,{'Content-Type':'text/plain'}).end('Not found');}
 });
}
if(process.argv[1]===fileURLToPath(import.meta.url))createStaticServer(undefined,{publicImmutable:process.env.PLAYGROUND_PUBLIC_IMMUTABLE==='1'}).listen(port,'0.0.0.0',()=>console.log(`GodotJS Playground: http://localhost:${port}`));
