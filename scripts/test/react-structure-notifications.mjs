import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const marker='GODOTJS_STRUCTURE_NOTIFICATION_RESULT ';
const probe=`extends SceneTree

func _initialize():
 var detached = Node.new()
 var leaf_signals = {"order":0,"exiting":0,"exited":0}
 detached.child_order_changed.connect(func(): leaf_signals.order += 1)
 detached.tree_exiting.connect(func(): leaf_signals.exiting += 1)
 detached.tree_exited.connect(func(): leaf_signals.exited += 1)
 detached.free()
 var leaf_destroyed = not is_instance_valid(detached)

 var old_parent = Node.new()
 var new_parent = Node.new()
 var mount = Node.new()
 old_parent.add_child(mount)
 var mount_signals = {"order":0,"exiting":0,"exited":0}
 mount.child_order_changed.connect(func(): mount_signals.order += 1)
 mount.tree_exiting.connect(func(): mount_signals.exiting += 1)
 mount.tree_exited.connect(func(): mount_signals.exited += 1)
 old_parent.remove_child(mount)
 new_parent.add_child(mount)
 var parent_changed = mount.get_parent() == new_parent
 var cases = [
  {"name":"detached-leaf-free","destroyed":leaf_destroyed,"signals":leaf_signals.duplicate()},
  {"name":"detached-mount-reparent","parentChanged":parent_changed,"signals":mount_signals.duplicate()}
 ]
 new_parent.free()
 old_parent.free()
 print("${marker}" + JSON.stringify({"engineVersion":Engine.get_version_info().string,"cases":cases}))
 quit(0)
`;

function executable(value){
 return /[\\/]/.test(value)?path.resolve(value):value;
}

/** A successful probe confirms counterexamples, never complete signal coverage. */
export async function runStructureNotificationProbe({godot,out}={}){
 const command=executable(godot||process.env.GODOT||path.join(repository,'tests/bin/godot-host-qjs'));
 const outputRoot=path.resolve(out??path.join(repository,'work/react-structure-notifications'));
 await mkdir(outputRoot,{recursive:true});
 const directory=await mkdtemp(path.join(outputRoot,'native-'));
 const fixture=path.join(directory,'project');
 await mkdir(fixture,{recursive:true});
 await Promise.all([
  writeFile(path.join(fixture,'project.godot'),'config_version=5\n[application]\nconfig/name="Structure notification coverage probe"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\n'),
  writeFile(path.join(fixture,'probe.gd'),probe),
 ]);
 const args=['--headless','--audio-driver','Dummy','--path',fixture,'--script','res://probe.gd','--quit-after','8'];
 const run=spawnSync(command,args,{cwd:fixture,encoding:'utf8',timeout:15000,killSignal:'SIGKILL',maxBuffer:2*1024*1024,
  env:{...process.env,XDG_DATA_HOME:path.join(directory,'xdg/data'),XDG_CONFIG_HOME:path.join(directory,'xdg/config'),XDG_CACHE_HOME:path.join(directory,'xdg/cache')},
 });
 const stdout=run.stdout??'',stderr=run.stderr??'';
 const lines=stdout.split(/\r?\n/).filter(line=>line.startsWith(marker));
 let observation,error;
 try{if(lines.length!==1)throw Error('Expected exactly one native observation');observation=JSON.parse(lines[0].slice(marker.length));}
 catch(value){error=String(value);}
 const quietSignals=value=>value&&typeof value==='object'&&Object.keys(value).length===3&&['order','exiting','exited'].every(key=>value[key]===0);
 const cases=Array.isArray(observation?.cases)?observation.cases:[];
 const leaf=cases.find(value=>value?.name==='detached-leaf-free'),mount=cases.find(value=>value?.name==='detached-mount-reparent');
 const engineErrors=/^(?:ERROR:|SCRIPT ERROR:)/m.test(stdout+'\n'+stderr);
 const passed=!run.error&&run.status===0&&!error&&!engineErrors&&cases.length===2&&leaf?.destroyed===true&&mount?.parentChanged===true&&quietSignals(leaf.signals)&&quietSignals(mount.signals);
 const report={
  status:passed?'passed':'failed',scope:'native-headless-public-node-signals',
  conclusion:passed?'External native structure auditing remains required; these node signals miss both observed changes.':'The expected counterexamples were not confirmed; inspect this run before drawing a coverage conclusion.',
  command,args,exitCode:run.status,signal:run.signal,engineVersion:observation?.engineVersion??null,cases,
  ...(run.error?{processError:run.error.message}:{}),...(error?{observationError:error}:{}),engineErrors,
  artifacts:{directory,project:fixture,stdout:path.join(directory,'stdout.log'),stderr:path.join(directory,'stderr.log'),report:path.join(directory,'report.json')},
 };
 await Promise.all([
  writeFile(report.artifacts.stdout,stdout),writeFile(report.artifacts.stderr,stderr),
  writeFile(report.artifacts.report,JSON.stringify(report,null,2)+'\n'),
 ]);
 return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const options={};
 try{
  const args=process.argv.slice(2);
  if(args.includes('--help')){
   process.stdout.write('Usage: node scripts/test/react-structure-notifications.mjs [--godot PATH] [--out DIR]\nGODOT supplies the engine when --godot is omitted; the default is tests/bin/godot-host-qjs.\nArtifacts are retained under work/react-structure-notifications/ by default.\nA passing result confirms missing signals and requires retaining external audits.\n');
  }else{
   for(let index=0;index<args.length;index++){
    const key=args[index];if(!['--godot','--out'].includes(key)||!args[index+1]||args[index+1].startsWith('--'))throw Error('Expected --godot PATH or --out DIR; use --help');
    options[key.slice(2)]=args[++index];
   }
   const report=await runStructureNotificationProbe(options);process.stdout.write(JSON.stringify(report,null,2)+'\n');
   if(report.status!=='passed')process.exitCode=1;
  }
 }catch(error){process.stderr.write(String(error)+'\n');process.exitCode=1;}
}
