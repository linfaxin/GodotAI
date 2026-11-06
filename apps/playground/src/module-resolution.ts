/** Shared by TypeScript resolution and the generated CommonJS loader. Keep self-contained. */
export function moduleCandidates(base:string):string[]{
 const clean=base.replace(/\.[jt]sx?$/,'');
 return [base,clean+'.ts',clean+'.tsx',clean+'.js',clean+'.jsx',clean+'.d.ts',base+'.d.ts',base+'/index.ts',base+'/index.tsx',base+'/index.js',base+'/index.jsx',base+'/index.d.ts',base+'.json'];
}
