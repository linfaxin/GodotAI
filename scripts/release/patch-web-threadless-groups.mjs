/** Godot 4.6.1 single-thread workers execute group tasks synchronously.
 * The upstream wait method only retires groups with THREADS_ENABLED. */
export const THREADLESS_GROUP_PATCH = 'godotjs-threadless-group-reclaim-v1';
export const THREADLESS_GROUP_WAIT_ORIGINAL = String.raw`void WorkerThreadPool::wait_for_group_task_completion(GroupID p_group) {
#ifdef THREADS_ENABLED
	task_mutex.lock();
	Group **groupp = groups.getptr(p_group);
	task_mutex.unlock();
	if (!groupp) {
		ERR_FAIL_MSG("Invalid Group ID.");
	}

	{
		Group *group = *groupp;

		if (this == singleton) {
			_unlock_unlockable_mutexes();
		}
		group->done_semaphore.wait();
		if (this == singleton) {
			_lock_unlockable_mutexes();
		}

		uint32_t max_users = group->tasks_used + 1; // Add 1 because the thread waiting for it is also user. Read before to avoid another thread freeing task after increment.
		uint32_t finished_users = group->finished.increment(); // fetch happens before inc, so increment later.

		if (finished_users == max_users) {
			// All tasks using this group are gone (finished before the group), so clear the group too.
			MutexLock task_lock(task_mutex);
			group_allocator.free(group);
		}
	}

	MutexLock task_lock(task_mutex); // This mutex is needed when Physics 2D and/or 3D is selected to run on a separate thread.
	groups.erase(p_group);
#endif
}`;
const threadless = String.raw`#else
	// GODOTJS_THREADLESS_GROUP_RECLAIM_V1
	// _post_tasks has synchronously completed all users before returning.
	MutexLock task_lock(task_mutex);
	Group **groupp = groups.getptr(p_group);
	if (!groupp) {
		ERR_FAIL_MSG("Invalid Group ID.");
	}
	Group *group = *groupp;
	ERR_FAIL_COND_MSG(!group->completed.is_set(), "Threadless group did not complete synchronously.");
	ERR_FAIL_COND_MSG(group->finished.get() != group->tasks_used, "Threadless group still has active users.");
	group_allocator.free(group);
	groups.erase(p_group);
#endif
}`;
const patched = THREADLESS_GROUP_WAIT_ORIGINAL.replace('#endif\n}', threadless);
const signature = 'void WorkerThreadPool::wait_for_group_task_completion(GroupID p_group) {';
const marker = 'GODOTJS_THREADLESS_GROUP_RECLAIM_V1';
const count = (source, text) => source.split(text).length - 1;

/** Strict layout checks make unknown upstream versions fail before any writes. */
export function patchThreadlessGroups(source) {
 if (typeof source !== 'string' || count(source, signature) !== 1) throw Error('E_THREADLESS_GROUP_PATCH_UNSUPPORTED: expected the pinned WorkerThreadPool method');
 if (count(source, patched) === 1 && count(source, marker) === 1) return {code: source, changed: false, patchId: THREADLESS_GROUP_PATCH};
 if (count(source, THREADLESS_GROUP_WAIT_ORIGINAL) !== 1 || count(source, marker) !== 0) throw Error('E_THREADLESS_GROUP_PATCH_UNSUPPORTED: changed or partially patched WorkerThreadPool method');
 return {code: source.replace(THREADLESS_GROUP_WAIT_ORIGINAL, patched), changed: true, patchId: THREADLESS_GROUP_PATCH};
}
