import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {patchWorkerRuntimeFile,WORKER_RUNTIME_PATHS} from '../../release/patch-web-worker-runtime.mjs';

const original=await readFile(new URL('./fixtures/godot-4.6.1-main.cpp',import.meta.url),'utf8');
const patched=patchWorkerRuntimeFile('main/main.cpp',original).code;
const draw=source=>source.slice(source.indexOf('\tGodotProfileZoneGrouped(_profile_zone, "RenderingServer::draw");'),source.indexOf('\n\tprocess_ticks =',source.indexOf('\tGodotProfileZoneGrouped(_profile_zone, "RenderingServer::draw");')));
const helper=patched.slice(patched.indexOf('#ifdef WEB_ENABLED\n#include <emscripten/emscripten.h>'),patched.indexOf('\n/* Static members */'));
const iteration=source=>source.slice(source.indexOf('bool Main::iteration() {'),source.indexOf('\nvoid Main::cleanup('));

test('checked draw patch is pinned, idempotent, ten-path and leaves the rest of iteration byte-identical',()=>{
 assert.equal(createHash('sha256').update(original).digest('hex'),'248f7e34fbe5aa3a65275420264af33cca7d29e0ce353120a90b9aaf23e8927c');
 assert.equal(WORKER_RUNTIME_PATHS.length,10);
 assert.equal(patchWorkerRuntimeFile('main/main.cpp',patched).changed,false);
 assert.throws(()=>patchWorkerRuntimeFile('main/main.cpp',patched.replace('godot_worker_draw_step_debt += scaled_step;','godot_worker_draw_step_debt = scaled_step;')),/E_WORKER_RUNTIME_PATCH_UNSUPPORTED/);
 assert.equal(iteration(patched).replace(draw(patched),draw(original)),iteration(original));
});

test('native synchronous gate inhibits only strict false; setup/reset/cleanup use a live native export',()=>{
 const js=helper.match(/return EM_ASM_INT\(\{([^]*?)\}\) != 0;/)[1];
 for(const value of [undefined,null,0,1,'false',false,true]) {
  const Module={godotWorkerDrawAllowed:typeof value==='undefined'?undefined:()=>value};
  assert.equal(runInNewContext(`(function(){${js}})()`,{Module}),value===false?0:1);
 }
 assert.equal(runInNewContext(`(function(){${js}})()`,{Module:{godotWorkerDrawAllowed:3}}),1);
 const setup=patched.match(/Error Main::setup\([^]*?EM_ASM\(\{([^]*?)\}\);/)[1];
 const cleanup=patched.match(/void Main::cleanup\([^]*?EM_ASM\(\{([^]*?)\}\);/)[1];
 let resets=0;const Module={_godot_web_worker_reset_draw_credit:()=>resets++};
 runInNewContext(setup,{Module});Module.godotWorkerResetDrawCredit();assert.equal(resets,1);
 runInNewContext(cleanup,{Module});assert.equal(Module.godotWorkerResetDrawCredit,undefined);
 assert(patched.match(/void Main::cleanup\(bool p_force\) \{\n#ifdef WEB_ENABLED\n\tgodot_web_worker_reset_draw_credit\(\);/));
});

// Execute the production helper and complete production draw block as C++, with
// small service doubles. This is a draw-boundary unit, not a whole-engine or
// browser performance claim. Physics/process/audio remain byte-identical above.
const harness=String.raw`
#include <cassert>
#include <cmath>
#include <vector>
#include <iostream>
#define EMSCRIPTEN_KEEPALIVE
#define GodotProfileZoneGrouped(...)
static bool credit=true;static int checks=0;
static int credit_hook(){++checks;return credit?1:0;}
#define EM_ASM_INT(...) credit_hook()
struct XRInterface{bool initialized=false;bool is_initialized(){return initialized;}};
template<class T>struct Ref{T*ptr=nullptr;bool is_valid(){return ptr!=nullptr;}T*operator->(){return ptr;}};
struct XRServer{XRInterface interface;bool has_primary=false;static XRServer*get_singleton(){static XRServer x;return &x;}Ref<XRInterface>get_primary_interface(){return {has_primary?&interface:nullptr};}};
struct RD{bool pending=false;static RD*get_singleton(){static RD x;return &x;}bool has_pending_resources_for_processing(){return pending;}};
struct DisplayServer{bool window=true,additional=false;static DisplayServer*get_singleton(){static DisplayServer x;return &x;}bool can_any_window_draw(){return window;}bool has_additional_outputs(){return additional;}};
struct OS{bool low=false;static OS*get_singleton(){static OS x;return &x;}bool is_in_low_processor_usage_mode(){return low;}};
struct Engine{int frames=0;static Engine*get_singleton(){static Engine x;return &x;}void increment_frames_drawn(){++frames;}};
struct RenderingServer{bool enabled=true,changed=true;std::vector<double>steps;std::vector<bool>presents;static RenderingServer*get_singleton(){static RenderingServer x;return &x;}bool is_render_loop_enabled(){return enabled;}bool has_changed(){return changed;}void draw(bool present,double step){steps.push_back(step);presents.push_back(present);changed=false;}};
HELPER
static bool force_redraw_requested=false;static int physics=0,process=0,audio=0;
static void iterate(double scaled_step){++physics;++process;
DRAW
++audio;}
static void reset(){*RD::get_singleton()={};*DisplayServer::get_singleton()={};*OS::get_singleton()={};*Engine::get_singleton()={};*RenderingServer::get_singleton()={};*XRServer::get_singleton()={};credit=true;checks=0;force_redraw_requested=false;physics=process=audio=0;
#ifdef WEB_ENABLED
godot_web_worker_reset_draw_credit();
#endif
}
static void close(double a,double b){assert(std::abs(a-b)<1e-10);}
int main(){auto*r=RenderingServer::get_singleton();auto*e=Engine::get_singleton();reset();
#ifdef WEB_ENABLED
 credit=false;iterate(.1);iterate(.2);iterate(0);assert(r->steps.empty()&&e->frames==0&&physics==3&&process==3&&audio==3);credit=true;iterate(.4);assert(r->steps.size()==1&&e->frames==1);close(r->steps.back(),.7);iterate(.01);close(r->steps.back(),.01);
 reset();credit=false;r->enabled=false;iterate(.2);assert(r->steps.empty()&&checks==0);RD::get_singleton()->pending=true;iterate(.3);assert(r->steps.size()==1&&!r->presents.back()&&checks==0);close(r->steps.back(),.3);
 reset();credit=false;OS::get_singleton()->low=true;r->changed=false;iterate(.4);assert(checks==0);r->changed=true;iterate(.2);assert(r->changed&&r->steps.empty());credit=true;iterate(.1);close(r->steps.back(),.3);
 reset();credit=false;force_redraw_requested=true;iterate(.25);assert(force_redraw_requested&&r->steps.empty());credit=true;iterate(.5);assert(!force_redraw_requested);close(r->steps.back(),.75);
 reset();credit=false;DisplayServer::get_singleton()->window=false;force_redraw_requested=true;iterate(.3);assert(r->steps.empty()&&checks==0&&force_redraw_requested);DisplayServer::get_singleton()->additional=true;iterate(.2);credit=true;iterate(.1);close(r->steps.back(),.3);
 reset();credit=false;iterate(.5);godot_web_worker_reset_draw_credit();credit=true;iterate(.1);close(r->steps.back(),.1);
 reset();credit=false;iterate(.2);r->enabled=false;iterate(5.0);r->enabled=true;credit=true;iterate(.1);close(r->steps.back(),.3);
#ifndef XR_DISABLED
 reset();credit=false;XRServer::get_singleton()->has_primary=true;iterate(.1);assert(r->steps.empty());XRServer::get_singleton()->interface.initialized=true;iterate(.2);assert(r->steps.size()==1);close(r->steps.back(),.3);
#endif
#else
 credit=false;iterate(.1);iterate(.2);assert(r->steps.size()==2&&checks==0&&e->frames==2);close(r->steps.back(),.2);
#endif
 std::cout<<"draw-only credit, elapsed time, project semantics and reset passed\n";
}
`;
const compiler=process.env.CXX??'c++';
test('production C++ draw boundary preserves simulation, shader time, user rendering and XR', {timeout:60000},async t=>{
 assert.equal(spawnSync(compiler,['--version'],{stdio:'ignore'}).status,0,'native compiler is required');
 const directory=await mkdtemp(join(tmpdir(),'worker-native-draw-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const code=harness.replace('\nHELPER\n','\n'+helper.replace(/^#include[^\n]*\n/gm,'')+'\n').replace('\nDRAW\n','\n'+draw(patched)+'\n');
 for(const [name,defines]of [['web-xr',['WEB_ENABLED']],['web-no-xr',['WEB_ENABLED','XR_DISABLED']],['native',[]]]){
  const file=join(directory,name+'.cpp'),binary=join(directory,name);await writeFile(file,code);
  const build=spawnSync(compiler,['-std=c++17','-O1',...defines.map(v=>'-D'+v),file,'-o',binary],{encoding:'utf8',timeout:20000});assert.equal(build.status,0,name+': '+build.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,name+': '+run.stderr+' '+run.stdout);
 }
});
