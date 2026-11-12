import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {patchThreadlessGroups, THREADLESS_GROUP_WAIT_ORIGINAL, THREADLESS_GROUP_PATCH} from '../../../scripts/release/patch-web-threadless-groups.mjs';

const original = THREADLESS_GROUP_WAIT_ORIGINAL;
test('threadless group patch is pinned, idempotent, and preserves the threaded implementation byte for byte', () => {
 const source = '// original source prefix\n' + original + '\n// source suffix\n';
 const first = patchThreadlessGroups(source), again = patchThreadlessGroups(first.code);
 assert.equal(first.changed, true); assert.equal(first.patchId, THREADLESS_GROUP_PATCH);
 assert.deepEqual(again, {...first, changed: false});
 const oldThreaded = original.slice(0, original.indexOf('\n#endif'));
 assert.equal(first.code.slice(first.code.indexOf('void WorkerThreadPool::'), first.code.indexOf('\n#else')), oldThreaded);
 for (const unsupported of [source.replace('groups.erase(p_group);', 'changed();'), source + original, first.code.replace('group_allocator.free(group);\n\tgroups.erase(p_group);', 'altered();'), 'unknown upstream']) {
  assert.throws(() => patchThreadlessGroups(unsupported), /E_THREADLESS_GROUP_PATCH_UNSUPPORTED/);
 }
});

const compiler = process.env.CXX ?? 'g++';
const available = spawnSync(compiler, ['--version'], {encoding: 'utf8'}).status === 0;
const harness = method => String.raw`
#include <cstdint>
#include <map>
#include <set>
#include <stdexcept>
#define ERR_FAIL_MSG(message) throw std::runtime_error(message)
#define ERR_FAIL_COND_MSG(condition,message) do { if (condition) throw std::runtime_error(message); } while (false)
struct BinaryMutex { void lock() {} void unlock() {} };
template<class T> struct MutexLock { explicit MutexLock(T&) {} };
struct Counter { uint32_t value=0; uint32_t increment(){return ++value;} uint32_t get() const{return value;} };
struct Flag { bool value=true; bool is_set() const{return value;} };
static int waits=0;
struct Semaphore { void wait(){++waits;} };
class WorkerThreadPool {
public:
 using GroupID=int;
 struct Group { uint32_t tasks_used=0; Counter finished; Flag completed; Semaphore done_semaphore; };
 struct Map {
  std::map<int,Group*> values;
  Group** getptr(int id){auto it=values.find(id);return it==values.end()?nullptr:&it->second;}
  void erase(int id){values.erase(id);}
 } groups;
 struct Allocator {
  std::set<Group*> live; unsigned frees=0;
  void free(Group* group){if(!live.erase(group))throw std::runtime_error("double free");++frees;delete group;}
 } group_allocator;
 BinaryMutex task_mutex;
 static WorkerThreadPool* singleton;
 void _unlock_unlockable_mutexes(){} void _lock_unlockable_mutexes(){}
 int add(int tasks){static int next=1;const int id=next++;auto* group=new Group();group->tasks_used=tasks;group->finished.value=tasks;groups.values[id]=group;group_allocator.live.insert(group);return id;}
 void wait_for_group_task_completion(GroupID);
};
WorkerThreadPool* WorkerThreadPool::singleton=nullptr;
${method}
int main(){
 WorkerThreadPool pool;WorkerThreadPool::singleton=&pool;
 // _post_tasks has synchronously returned, including its zero-element path.
 int id=pool.add(0);pool.wait_for_group_task_completion(id);
 if(pool.group_allocator.frees!=1 || !pool.groups.values.empty())return 17;
 id=pool.add(3);pool.wait_for_group_task_completion(id);
 if(pool.group_allocator.frees!=2 || !pool.groups.values.empty())return 18;
 for(int frame=0;frame<10000;++frame){
  id=pool.add(0);pool.wait_for_group_task_completion(id);
  id=pool.add(4);pool.wait_for_group_task_completion(id);
 }
 if(!pool.groups.values.empty() || !pool.group_allocator.live.empty() || pool.group_allocator.frees!=20002)return 19;
 bool invalid=false;try{pool.wait_for_group_task_completion(id);}catch(const std::runtime_error&){invalid=true;}
 if(!invalid)return 20;
#ifndef THREADS_ENABLED
 if(waits!=0)return 21;
 // Defensive checks must leave incomplete groups intact rather than freeing active users.
 id=pool.add(2);auto* pending=pool.groups.values[id];pending->completed.value=false;
 bool rejected=false;try{pool.wait_for_group_task_completion(id);}catch(const std::runtime_error&){rejected=true;}
 if(!rejected || pool.groups.values[id]!=pending || pool.group_allocator.frees!=20002)return 22;
 pending->completed.value=true;pending->finished.value=1;rejected=false;
 try{pool.wait_for_group_task_completion(id);}catch(const std::runtime_error&){rejected=true;}
 if(!rejected || pool.group_allocator.frees!=20002)return 23;
 pending->finished.value=2;pool.wait_for_group_task_completion(id);
 if(!pool.groups.values.empty() || !pool.group_allocator.live.empty())return 24;
#else
 if(waits!=20002)return 25;
#endif
 return 0;
}
`;

test('compiled original reproduces group retention; patched threaded and threadless paths retire zero/nonempty groups', {skip: !available, timeout: 60000}, async t => {
 const directory = await mkdtemp(path.join(tmpdir(), 'godot-threadless-groups-')); t.after(() => rm(directory, {recursive: true, force: true}));
 const patched = patchThreadlessGroups(original).code;
 for (const [name, method, threaded, expected] of [['upstream-threadless', original, false, 17], ['fixed-threadless', patched, false, 0], ['fixed-threaded', patched, true, 0]]) {
  const source = path.join(directory, name + '.cpp'), binary = path.join(directory, name);
  await writeFile(source, harness(method));
  const build = spawnSync(compiler, ['-std=c++17', '-O1', ...(threaded ? ['-DTHREADS_ENABLED'] : []), source, '-o', binary], {encoding: 'utf8', timeout: 30000});
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], {encoding: 'utf8', timeout: 10000});
  assert.equal(run.status, expected, name + ': ' + run.stderr);
 }
});
