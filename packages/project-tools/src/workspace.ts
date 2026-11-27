import {createSourceSnapshot,applySourceSnapshotDelta,type SourceInput,type SourceSnapshot} from './build-plan.js';
import {ProjectToolError} from './errors.js';

export interface ProjectBuildSnapshot {readonly revision:number;readonly source:SourceSnapshot;release():void}
type SnapshotLimits = {maxBytes?:number;maxFiles?:number};
type ChangeOptions = SnapshotLimits & {expectedBaseRevision?:number};
/** A mutable editor owns revisions; each build owns an immutable source snapshot. */
export class ProjectWorkspace {
 private serial=0;
 private current?:SourceSnapshot;
 private currentRevision=0;
 private readonly pins=new Map<number,SourceSnapshot>();
 get revision():number{return this.currentRevision;}
 get pendingSnapshots():number{return this.pins.size;}
 private pin(revision:number,source:SourceSnapshot):ProjectBuildSnapshot{
  this.pins.set(revision,source);let released=false;
  return Object.freeze({revision,source,release:()=>{if(!released){released=true;this.pins.delete(revision);}}});
 }
 async capture(input:SourceInput,limits:SnapshotLimits={}):Promise<ProjectBuildSnapshot>{
  const revision=++this.serial;
  // createSourceSnapshot captures every external buffer before its first await.
  const source=await createSourceSnapshot(input,{...limits,previous:this.current});
  if(revision===this.serial){this.current=source;this.currentRevision=revision;}
  return this.pin(revision,source);
 }
 async captureChanges(changed:SourceInput,removed:readonly string[]=[],{expectedBaseRevision,...limits}:ChangeOptions={}):Promise<ProjectBuildSnapshot>{
  if(!this.current)throw Error('E_PROJECT_SNAPSHOT: Capture an initial source snapshot before applying deltas');
  if(expectedBaseRevision!==undefined){
   const base=this.current;
   const admittedSerial=this.serial;
   const verifyBase=()=>{
    if(expectedBaseRevision!==this.currentRevision||admittedSerial!==this.serial)
     throw new ProjectToolError('E_PROJECT_REVISION_CONFLICT','Project no longer has base revision '+expectedBaseRevision,
      {expectedBaseRevision, currentRevision:this.currentRevision});
   };
   verifyBase();
   const source=await applySourceSnapshotDelta(base,changed,removed,limits);
   verifyBase();
   const revision=++this.serial;
   this.current=source;
   this.currentRevision=revision;
   return this.pin(revision,source);
  }
  const revision=++this.serial,base=this.current;
  const source=await applySourceSnapshotDelta(base,changed,removed,limits);
  if(revision===this.serial){this.current=source;this.currentRevision=revision;}
  return this.pin(revision,source);
 }
 isCurrent(snapshot:ProjectBuildSnapshot):boolean{return snapshot.revision===this.serial;}
 invalidate():void{this.serial++;}
}
