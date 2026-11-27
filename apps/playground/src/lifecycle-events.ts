import type {WorkerRunIdentity} from '@godot-js/engine/browser/dedicated/worker-protocol';
import type {WorkerRunnerExit} from '@godot-js/engine/browser/dedicated/worker-runner';

export const LIFECYCLE_KINDS = ['play.started', 'play.stopped'] as const;
export type LifecycleKind = typeof LIFECYCLE_KINDS[number];

type RunData = {
  projectId: string;
  editorRevision: number;
  attemptId: string;
  run: WorkerRunIdentity;
  artifactId: string;
  releaseId: string;
  sourceHash?: string;
};

type ExitFacts = NonNullable<WorkerRunnerExit['sessionFacts']>;
export type LifecycleExit = {
  evidence: 'host-report' | 'editor-local';
  reason: WorkerRunnerExit['reason'];
  facts?: Omit<ExitFacts, 'failure'> & {failureObserved: boolean};
};

type LifecycleObservation =
  | {kind: 'play.started'; data: RunData}
  | {kind: 'play.stopped'; data: RunData & {startedObserved: boolean; exit: LifecycleExit}};
export type LifecycleEvent = LifecycleObservation & {seq: number; ts: number};

export interface LifecycleQuery {
  since?: number;
  stream_id?: string;
  kinds: readonly LifecycleKind[];
  limit: number;
}

export interface LifecyclePage {
  stream_id: string;
  since: number;
  kinds: readonly LifecycleKind[] | 'all';
  events: LifecycleEvent[];
  next_seq: number;
  truncated: boolean;
  gap?: {from_seq: number; to_seq: number};
}

export interface RecentLifecycleEvents extends LifecyclePage {
  last_seq: number;
  count: number;
  window: 'newest' | 'since' | 'ring';
}

export interface WaitLifecycleEvents extends LifecyclePage {
  matched: boolean;
  timed_out: boolean;
  waited_ms: number;
}

const MAX_EVENTS = 512;

export function createLifecycleLog(streamId: string) {
  const entries: LifecycleEvent[] = [];
  let lastSeq = 0;

  function read(since: number, kinds: readonly LifecycleKind[], limit: number): LifecyclePage {
    const evictedThrough = lastSeq - entries.length;
    const gap = since < evictedThrough ? {from_seq: since + 1, to_seq: evictedThrough} : undefined;
    let scanned = Math.max(since, evictedThrough);
    const events: LifecycleEvent[] = [];
    let truncated = false;
    for (let index = scanned - evictedThrough; index < entries.length; index++) {
      if (events.length === limit) {
        truncated = true;
        break;
      }
      const event = entries[index];
      scanned = event.seq;
      if (!kinds.length || kinds.includes(event.kind)) events.push(event);
    }
    return {stream_id: streamId, since, kinds: kinds.length ? [...kinds] : 'all',
      events: structuredClone(events), next_seq: scanned, truncated, ...(gap ? {gap} : {})};
  }

  return {
    head: () => lastSeq,
    accepts(query: LifecycleQuery) {
      return (query.stream_id === undefined || query.stream_id === streamId) &&
        (query.since === undefined || query.since <= lastSeq);
    },
    append(observation: LifecycleObservation) {
      entries.push({...observation, seq: ++lastSeq, ts: Date.now()});
      if (entries.length > MAX_EVENTS) entries.shift();
    },
    read,
    recent(query: LifecycleQuery): RecentLifecycleEvents {
      const since = query.since ?? Math.max(0, lastSeq - query.limit);
      const page = read(since, query.kinds, query.limit);
      return {...page, last_seq: lastSeq, count: page.events.length,
        window: query.since === undefined ? 'newest' : query.since === 0 ? 'ring' : 'since'};
    },
  };
}
