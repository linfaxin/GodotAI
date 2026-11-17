import {createSourceSnapshot,applySourceSnapshotDelta,type SourceInput,type SourceSnapshot} from './build-plan.js';

export interface ProjectBuildSnapshot {readonly revision:number;readonly source:SourceSnapshot;release():void}
/** A mutable editor owns revisions; each build owns an immutable source snapshot. */
export class ProjectWorkspace {
 private serial=0;
 private current?:SourceSnapshot;
 private currentRevision=0;
 private readonly pins=new Map<number,SourceSnapshot>();
 get revision():number{return this.currentRevision;}
 get pendingSnapshots():number{return this.pins.size;}
 async capture(input:SourceInput,limits:{maxBytes?:number;maxFiles?:number}={}):Promise<ProjectBuildSnapshot>{
  const revision=++this.serial;
  // createSourceSnapshot captures every external buffer before its first await.
  const source=await createSourceSnapshot(input,{...limits,previous:this.current});
  if(revision===this.serial){this.current=source;this.currentRevision=revision;}
  this.pins.set(revision,source);let released=false;
  return Object.freeze({revision,source,release:()=>{if(!released){released=true;this.pins.delete(revision);}}});
 }
 async captureChanges(changed:SourceInput,removed:readonly string[]=[],limits:{maxBytes?:number;maxFiles?:number}={}):Promise<ProjectBuildSnapshot>{
  if(!this.current)throw Error('E_PROJECT_SNAPSHOT: Capture an initial source snapshot before applying deltas');
  const revision=++this.serial,base=this.current;
  const source=await applySourceSnapshotDelta(base,changed,removed,limits);
  if(revision===this.serial){this.current=source;this.currentRevision=revision;}
  this.pins.set(revision,source);let released=false;
  return Object.freeze({revision,source,release:()=>{if(!released){released=true;this.pins.delete(revision);}}});
 }
 isCurrent(snapshot:ProjectBuildSnapshot):boolean{return snapshot.revision===this.serial;}
 invalidate():void{this.serial++;}
}
