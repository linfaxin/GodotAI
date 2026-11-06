/** Save is automatic; suppress the browser's Save/Save As in each UI realm. */
export function suppressBrowserSave(target:Window){
 target.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&(event.code==='KeyS'||event.key.toLowerCase()==='s')){
   event.preventDefault();
   event.stopPropagation();
  }
 },{capture:true});
}
