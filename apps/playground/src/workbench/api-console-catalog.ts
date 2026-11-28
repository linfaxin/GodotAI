import type {PlaygroundApi} from '../playground-api';
import type {RuntimeType} from '@godot-js/engine/browser/dedicated/worker-runtime-properties';
import {SUMMER_OPERATION_SPECS, type SummerOperation, type OperationParameter} from '../summer-operation-spec.ts';

export const MAX_CONSOLE_READ_PROPERTIES = 16;

export type LocalConsoleOperation = 'check' | 'wait_for_event' | 'describe_runtime_properties' | 'describe_runtime_methods' |
  'read_runtime_properties' | 'game_input' | 'wait_for_input' | 'get_run';
export type ConsoleOperationId = SummerOperation | LocalConsoleOperation;
export const DEFAULT_CONSOLE_OPERATION: ConsoleOperationId = 'engine.get_project_context';
export type ConsoleBinding = 'none' | 'project' | 'main' | 'runtime' | 'explicit';

/** Sources are selected from real responses by the session; no placeholder IDs are generated here. */
export interface ConsolePresetContext {
  readonly editorProjectId?: string | null;
  readonly editorRevision?: number | null;
  readonly activeRunId?: string | null;
  readonly pendingAttemptId?: string | null;
  readonly attemptId?: string;
  readonly runId?: string;
  readonly until?: 'running' | 'exited';
  readonly target?: {readonly runId: string; readonly path: string; readonly expectedInstanceId: string};
  readonly properties?: readonly {readonly name: string; readonly type: RuntimeType}[];
  readonly input?: {readonly runId: string; readonly operationId: string};
}
export interface ConsolePreset {
  input: Record<string, unknown>;
  missing: readonly string[];
}
export interface ConsoleOperation {
  readonly id: ConsoleOperationId;
  readonly family: 'summer' | 'local';
  readonly name: ConsoleOperationId;
  readonly title: string;
  readonly description: string;
  readonly binding: ConsoleBinding;
  readonly acceptsSignal: boolean;
  readonly resultKind: 'json' | 'game-screenshot' | 'game-probe';
  readonly parameters: readonly OperationParameter[];
  readonly limitations: readonly string[];
  createPreset(context?: ConsolePresetContext): ConsolePreset;
  invoke(api: PlaygroundApi, input: unknown, signal?: AbortSignal): unknown;
}

function summer(id: SummerOperation, binding: ConsoleBinding, acceptsSignal = false): ConsoleOperation {
  const data = SUMMER_OPERATION_SPECS[id];
  return Object.freeze({
    id, name: id, family: 'summer' as const, title: data.title, description: data.description,
    binding, acceptsSignal, resultKind: id === 'engine.screenshot' ? 'game-screenshot' as const : id === 'engine.game_probe' ? 'game-probe' as const : 'json' as const,
    parameters: data.parameters,
    limitations: Object.freeze([...data.limitations, ...(data.unsupported.length ? [`不支持参数：${data.unsupported.join('、')}。`] : [])]),
    createPreset(context: ConsolePresetContext = {}): ConsolePreset {
      const input: Record<string, unknown> = {...data.defaultInput};
      const missing: string[] = [];
      if (id === 'engine.inspect_runtime_node' || id === 'engine.runtime_set') {
        if (context.target) input.path = context.target.path;
        else missing.push('节点路径（从运行树选择）');
      }
      return {input, missing};
    },
    invoke(api: PlaygroundApi, input: unknown, signal?: AbortSignal) {
      const call = {op: id, input};
      return acceptsSignal ? api.summer_call(call, signal) : api.summer_call(call);
    },
  });
}

function targetInput(context: ConsolePresetContext, input: Record<string, unknown>, missing: string[]) {
  if (context.target) {
    input.runId = context.target.runId;
    input.path = context.target.path;
    input.expectedInstanceId = context.target.expectedInstanceId;
  } else missing.push('运行树中的节点及其 runId/instanceId');
}

const localOperations: readonly ConsoleOperation[] = [
  {
    id: 'describe_runtime_methods', name: 'describe_runtime_methods', family: 'local', title: '发现公开方法',
    description: '读取当前节点已登记的方法与类型签名。', binding: 'explicit', acceptsSignal: true, resultKind: 'json',
    parameters: [
      {name: 'runId / path / expectedInstanceId', description: '来自同一次真实运行树。', required: true},
      {name: 'method / limit', description: '可选的精确方法名或枚举上限，两者互斥。'},
    ],
    limitations: ['只读取已发布登记；调用需要本次发现的方法 token。'],
    createPreset(context = {}) {
      const input: Record<string, unknown> = {}, missing: string[] = [];
      targetInput(context, input, missing);
      return {input, missing};
    },
    invoke: (api, input, signal) => api.describe_runtime_methods(input as Parameters<PlaygroundApi['describe_runtime_methods']>[0], signal),
  },
  {
    id: 'check', name: 'check', family: 'local', title: '检查当前编辑项目',
    description: '对指定项目与编辑版本做 TypeScript 检查。', binding: 'project', acceptsSignal: false, resultKind: 'json',
    parameters: [
      {name: 'projectId', description: '当前编辑项目 ID。', required: true},
      {name: 'expectedEditorRevision', description: '当前编辑版本；过期时拒绝。', required: true},
    ], limitations: ['completed 表示收到检查结果；只有错误计数为零才表示检查通过。', '本操作不能取消。'],
    createPreset(context = {}) {
      const input: Record<string, unknown> = {}, missing: string[] = [];
      if (context.editorProjectId != null) input.projectId = context.editorProjectId;
      else missing.push('编辑项目 ID');
      if (context.editorRevision != null) input.expectedEditorRevision = context.editorRevision;
      else missing.push('编辑版本');
      return {input, missing};
    },
    invoke: (api, input) => api.check(input as Parameters<PlaygroundApi['check']>[0]),
  },
  {
    id: 'wait_for_event', name: 'wait_for_event', family: 'local', title: '等待指定启动或退出',
    description: '按明确的 attemptId 或 runId 等待 running/exited，不是 Summer 事件游标协议。',
    binding: 'explicit', acceptsSignal: true, resultKind: 'json',
    parameters: [
      {name: 'attemptId / runId', description: '必须二选一；attempt 来自 play，run 来自运行回执。', required: true},
      {name: 'until', description: 'running 或 exited。', required: true},
      {name: 'timeoutMs', description: '1–60000 毫秒，默认 30000。'},
    ], limitations: ['reached、timeout、no_session 与 exited_before_condition 分别表达。', '取消只结束等待，不取消启动或停止游戏。'],
    createPreset(context = {}) {
      const until = context.until ?? 'running';
      const input: Record<string, unknown> = {until, timeoutMs: until === 'exited' ? 10000 : 60000};
      const missing: string[] = [];
      // An explicit source wins over ambient state; never combine two identities in one request.
      if (context.attemptId) input.attemptId = context.attemptId;
      else if (context.runId) input.runId = context.runId;
      else if (until === 'running' && context.pendingAttemptId) input.attemptId = context.pendingAttemptId;
      else if (context.activeRunId) input.runId = context.activeRunId;
      else missing.push('play 的 attemptId 或明确的 runId');
      return {input, missing};
    },
    invoke: (api, input, signal) => api.wait_for_event(input as Parameters<PlaygroundApi['wait_for_event']>[0], signal),
  },
  {
    id: 'describe_runtime_properties', name: 'describe_runtime_properties', family: 'local', title: '发现公开脚本属性',
    description: '读取节点的属性元数据，不运行脚本 getter。', binding: 'explicit', acceptsSignal: true, resultKind: 'json',
    parameters: [
      {name: 'runId / path / expectedInstanceId', description: '同一次实际运行树提供的完整节点身份。', required: true},
      {name: 'names', description: '1–16 个不重复的属性名；不能同时传 limit。'},
      {name: 'limit', description: '枚举上限 1–64，默认 32；不能同时传 names。'},
      {name: 'timeoutMs', description: '1–30000 毫秒，默认 5000。'},
    ], limitations: ['candidate 表示可尝试访问，不保证 getter 成功。', '截断或 unresolved 不表示属性不存在。'],
    createPreset(context = {}) {
      const input: Record<string, unknown> = {names: ['health', 'move_step']}, missing: string[] = [];
      targetInput(context, input, missing);
      return {input, missing};
    },
    invoke: (api, input, signal) => api.describe_runtime_properties(input as Parameters<PlaygroundApi['describe_runtime_properties']>[0], signal),
  },
  {
    id: 'read_runtime_properties', name: 'read_runtime_properties', family: 'local', title: '显式读取公开脚本属性',
    description: '按选定属性与已发现类型独立读取；此时可能执行脚本 getter。', binding: 'explicit', acceptsSignal: true, resultKind: 'json',
    parameters: [
      {name: 'runId / path / expectedInstanceId', description: '来自同一次运行树的完整节点身份。', required: true},
      {name: 'properties', description: `1–${MAX_CONSOLE_READ_PROPERTIES} 项 {name, expectedType}，类型来自该目标的 describe。`, required: true},
      {name: 'timeoutMs', description: '1–30000 毫秒，默认 5000。'},
    ], limitations: ['逐项保留 value/unavailable/not_attempted 与 stopReason；不是同帧事务快照。', '取消可能发生在 getter 已进入之后，不保证没有执行。'],
    createPreset(context = {}) {
      const input: Record<string, unknown> = {}, missing: string[] = [];
      targetInput(context, input, missing);
      if (context.properties?.length && context.properties.length <= MAX_CONSOLE_READ_PROPERTIES) {
        input.properties = context.properties.map(item => ({name: item.name, expectedType: item.type}));
      } else if (context.properties?.length) missing.push(`每次最多 ${MAX_CONSOLE_READ_PROPERTIES} 项属性`);
      else missing.push('该目标 describe 返回的属性与类型');
      return {input, missing};
    },
    invoke: (api, input, signal) => api.read_runtime_properties(input as Parameters<PlaygroundApi['read_runtime_properties']>[0], signal),
  },
  {
    id: 'game_input', name: 'game_input', family: 'local', title: '发送一次游戏输入',
    description: '提交方向键或 Space 的 key_tap；返回 operationId 后显式等待输入回执。', binding: 'explicit', acceptsSignal: false, resultKind: 'json',
    parameters: [
      {name: 'runId', description: '要操作的明确运行 ID。', required: true},
      {name: 'gesture', description: '{kind:"key_tap",code:"ArrowRight"}；支持 Space/ArrowUp/ArrowDown/ArrowLeft/ArrowRight。', required: true},
    ], limitations: ['这是 GodotAI 有限输入，不是 Summer timed script/record/replay。',
      'operationId 表示已接纳；分发与原生消费事实不同，输入不能撤销。',
      'primary_click 另需实际截图的 geometryEpoch 与 [0,1) 归一化坐标；本期只预设按键。'],
    createPreset(context = {}) {
      const input: Record<string, unknown> = {gesture: {kind: 'key_tap', code: 'ArrowRight'}}, missing: string[] = [];
      const runId = context.runId ?? context.target?.runId ?? context.activeRunId;
      if (runId) input.runId = runId;
      else missing.push('运行 ID');
      return {input, missing};
    },
    invoke: (api, input) => api.game_input(input as Parameters<PlaygroundApi['game_input']>[0]),
  },
  {
    id: 'get_run', name: 'get_run', family: 'local', title: '查询指定运行',
    description: '按 runId 查询保留的运行身份和退出回执。', binding: 'explicit', acceptsSignal: false, resultKind: 'json',
    parameters: [{name: 'runId', description: '从本次启动或退出的匹配事件取得。', required: true}],
    limitations: ['已退出的运行只保留最近两次。当前主运行变化不会改变查询目标。'],
    createPreset(context = {}) {
      return context.runId ? {input: {runId: context.runId}, missing: []} : {input: {}, missing: ['要查询的运行 ID']};
    },
    invoke: (api, input) => api.get_run(input as Parameters<PlaygroundApi['get_run']>[0]),
  },
  {
    id: 'wait_for_input', name: 'wait_for_input', family: 'local', title: '等待输入分发回执',
    description: '查询同一 run 的 operationId，保留按下、释放与未确认事实。', binding: 'explicit', acceptsSignal: true, resultKind: 'json',
    parameters: [
      {name: 'runId / operationId', description: '同一次 game_input 的请求 runId 与返回 operationId，必须成对使用。', required: true},
      {name: 'timeoutMs', description: '0–60000 毫秒，默认 5000；0 仅查询快照。'},
    ], limitations: ['settled 不保证完整分发；检查 operation.status/down/up。', 'nativeConsumption 仍为 unconfirmed；取消等待不取消输入。'],
    createPreset(context = {}) {
      const input: Record<string, unknown> = {timeoutMs: 5000}, missing: string[] = [];
      if (context.input) {input.runId = context.input.runId; input.operationId = context.input.operationId;}
      else missing.push('同一次 game_input 的 runId/operationId');
      return {input, missing};
    },
    invoke: (api, input, signal) => api.wait_for_input(input as Parameters<PlaygroundApi['wait_for_input']>[0], signal),
  },
];

/** Explicit allowlist: adding a public method does not silently expand the console. */
export const CONSOLE_OPERATIONS: readonly ConsoleOperation[] = Object.freeze([
  summer('engine.get_project_context', 'none'),
  summer('engine.get_diagnostics', 'none'),
  summer('engine.get_script_errors', 'none'),
  summer('engine.get_debugger_errors', 'project'),
  summer('engine.play', 'project'),
  summer('engine.stop', 'main'),
  summer('engine.is_running', 'none'),
  summer('engine.recent_events', 'none'),
  summer('engine.wait_for_event', 'none', true),
  summer('engine.get_runtime_tree', 'runtime', true),
  summer('engine.inspect_runtime_node', 'runtime', true),
  summer('engine.runtime_set', 'runtime', true),
  summer('engine.runtime_call', 'runtime', true),
  summer('engine.screenshot', 'runtime', true),
  summer('engine.game_probe', 'runtime', true),
  summer('engine.game_input', 'runtime', true),
  ...localOperations.map(operation => Object.freeze(operation)),
]);

export function getConsoleOperation(id: string): ConsoleOperation | undefined {
  return CONSOLE_OPERATIONS.find(operation => operation.id === id);
}
