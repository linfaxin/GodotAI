/** Shared source-module contract for checking, preparation and rename planning. */
export const ENGINE_MODULE_ROOT='res://.godot/GodotJS/';
export const projectScript=/\.(?:[cm]?ts|tsx|jsx|js|cjs|mjs)$/i;
export const projectDeclaration=/\.d\.[cm]?ts$/i;

export function moduleCandidates(base:string):string[]{
 const clean=base.replace(/\.[cm]?[jt]sx?$/i,'');
 return [...new Set([base,...['.ts','.tsx','.js','.jsx','.mts','.mjs','.cts','.cjs','.d.ts','.d.mts','.d.cts'].map(ext=>clean+ext),...['.ts','.tsx','.js','.jsx','.mts','.mjs','.cts','.cjs','.d.ts','.json'].map(ext=>base+'/index'+ext),base+'.json'])];
}
export function projectModulePath(specifier:string,from:string):string|undefined {
 let path:string;
 if(specifier.startsWith('res://'))path=specifier.slice(6);
 else if(specifier.startsWith('/'))path=specifier;
 else if(specifier.startsWith('.'))path=from.slice(0,from.lastIndexOf('/')+1)+specifier;
 else return undefined;
 if(path.startsWith('res://'))path=path.slice(6);
 const parts:string[]=[];
 for(const part of path.split('/')){
  if(part==='..'){if(!parts.length)return undefined;parts.pop();}
  else if(part&&part!=='.')parts.push(part);
 }
 return '/'+parts.join('/');
}
export function emittedModulePath(source:string):string {
 const path=source.startsWith('res://')?source.slice(6):source.replace(/^\//,'');
 return ENGINE_MODULE_ROOT+path.replace(/\.(?:[cm]?ts|tsx|jsx|mjs)$/i,'.js');
}
