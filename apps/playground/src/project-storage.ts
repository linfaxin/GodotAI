import {parseProject,type EditorProject} from './project-model';

interface Snapshot {selected?:string;projects:[string,unknown][];versions?:Record<string,number>}
interface Pending {project:EditorProject;revision:number}
/** Each write merges only this tab's edited projects inside one IndexedDB transaction. */
export function createProjectStorage(database:Promise<IDBDatabase|undefined>){
 const versions=new Map<string,number>(),pending=new Map<string,Pending>();
 let revision=0,queue:Promise<unknown>=Promise.resolve();
 return {
  remember(snapshot:Snapshot|undefined){versions.clear();for(const [id] of snapshot?.projects??[])versions.set(id,snapshot?.versions?.[id]??0);},
  stage(id:string,project:EditorProject){pending.set(id,{project,revision:++revision});},
  hasPending(id:string){return pending.has(id);},
  save(selected:string){
   const operation=queue.then(async()=>{
    const db=await database;if(!db)throw Error('无法使用本地存储');
    const valid=new Map<string,{project:EditorProject;revision:number}>(),invalid=new Map<string,string>(),conflicts:string[]=[];
    for(const [id,edit] of pending){try{valid.set(id,{project:parseProject(edit.project),revision:edit.revision});}catch(error){invalid.set(id,String(error));}}
    await new Promise<void>((resolve,reject)=>{
     const tx=db.transaction('projects','readwrite'),store=tx.objectStore('projects'),request=store.get('current');
     const applied=new Map<string,{version:number;revision:number}>();
     request.onsuccess=()=>{
      const saved=request.result as Snapshot|undefined;
      const rows=Array.isArray(saved?.projects)?saved.projects.filter(row=>Array.isArray(row)&&row.length===2):[];
      if(saved&&(!Array.isArray(saved.projects)||rows.length!==saved.projects.length)){
       store.put(saved,'recovery:'+Date.now()+':'+crypto.randomUUID());store.put(saved,'recovery');
      }
      const projects=new Map(rows),nextVersions={...saved?.versions};
      for(const [id,edit] of valid){
       const currentVersion=nextVersions[id]??0;
       if(currentVersion!==(versions.get(id)??0)){conflicts.push(id);continue;}
       projects.set(id,edit.project);nextVersions[id]=currentVersion+1;applied.set(id,{version:currentVersion+1,revision:edit.revision});
      }
      store.put({selected,projects:[...projects],versions:nextVersions},'current');
     };
     tx.oncomplete=()=>{for(const [id,edit] of applied){versions.set(id,edit.version);if(pending.get(id)?.revision===edit.revision)pending.delete(id);}resolve();};
     tx.onabort=()=>reject(tx.error??Error('本地存档发生变化，写入已取消'));
    });
    return {invalid,conflicts};
   });
   queue=operation.catch(()=>{});return operation;
  },
 };
}
