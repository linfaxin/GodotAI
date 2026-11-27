import {INPUT_SCRIPT_PLAYER_PATH} from '../input-script-demo';
import {SUMMER_OPERATION_SPECS} from '../summer-operation-spec';

/** Teaching data only. Loading a step never executes it or advances another step. */
export interface ConsoleLessonStep {
  id: string;
  label: string;
  operationId: string;
  /** A complete input for requests that need no runtime-generated identity. */
  input?: Record<string, unknown>;
  needsRunSource?: boolean;
  needsEventCursor?: boolean;
  /** Explicitly merge into this operation's valid object draft, preserving real IDs/path.
   * Invalid JSON is left untouched. This is not an expression or substitution system. */
  inputOverrides?: Record<string, unknown>;
  notes?: string;
}
export interface ConsoleLesson {
  id: string;
  title: string;
  description: string;
  steps: readonly ConsoleLessonStep[];
}

const inputScriptReady = '收到 running 回执后，确认主运行是回执中的 runId、待启动 attempt 为「无」，且「物理帧输入」和「游戏帧探测」均为「可用」。';

const takeCursor = (id: string, action: string): ConsoleLessonStep => ({
  id, label: `${action}前取游标`, operationId: 'engine.recent_events', input: {},
});
const waitLifecycle = (id: string, start: boolean): ConsoleLessonStep => ({
  id, label: start ? '确认本次启动事件' : '确认本次退出事件', operationId: 'engine.wait_for_event',
  input: {kinds: [start ? 'play.started' : 'play.stopped'], timeout_seconds: start ? 60 : 15}, needsEventCursor: true,
  notes: '用操作前的事件页填入游标。' + (start
    ? '在整页事件中核对 Play 回执的 attemptId、项目和版本。' + inputScriptReady
    : '按 Stop 回执核对 Worker 身份。正常退出需有 host-report 和 clean-exit。已退出时可查看原回执；只有取消的启动尝试时先查构建。') +
    '若仅看到其它运行，从这次等待结果填入新游标，再显式执行一次等待。若历史有缺口，按原身份查询构建或运行。',
});

const lifecycleProbe = (id: string, x: number): ConsoleLessonStep => ({
  id, label: `探测位置 x=${x}`, operationId: 'engine.game_probe',
  input: {tree: {path: '/root/Main'}, props: [INPUT_SCRIPT_PLAYER_PATH + ':position']},
});
const stopLifecycleRun = (id: string): ConsoleLessonStep => ({
  id, label: '停止已探测的运行', operationId: 'engine.stop', input: {}, needsRunSource: true,
  notes: '从最近一次同帧探测的历史回执填入目标，再检查 Stop 返回的 runs。',
});

export const CONSOLE_LESSONS: readonly ConsoleLesson[] = [
  {
    id: 'diagnostic-repair',
    title: 'Summer：定位并修复类型错误',
    description: '从 engine.get_diagnostics 打开独立示例。保留正常预览，检查坏版本并修复，然后用新构建验证。',
    steps: [
      {id: 'play-original', label: '启动原始版本', operationId: 'engine.play', input: {}},
      {id: 'wait-original', label: '等原始版本运行', operationId: 'wait_for_event', input: {until: 'running', timeoutMs: 60000},
        notes: '从本次 Play 的历史结果填入 attemptId。运行后切回 /src/Player.ts，在 import 后加一行 const step: number = "bad";。'},
      {id: 'check-broken', label: '检查坏版本', operationId: 'check', input: {},
        notes: '点「更新目标」填入编辑项目和版本，执行并等待检查结算。'},
      {id: 'read-broken', label: '定位类型错误', operationId: 'engine.get_diagnostics', input: {},
        notes: '查看 check 中的 2322、/src/Player.ts 和行号。'},
      {id: 'play-broken', label: '尝试构建坏版本', operationId: 'engine.play', input: {}},
      {id: 'wait-broken', label: '等坏版本构建结算', operationId: 'wait_for_event', input: {until: 'running', timeoutMs: 60000},
        notes: '从坏版本的 Play 回执填入 attemptId。确认 no_session，并观察原有预览仍在运行。'},
      {id: 'read-failed-build', label: '查看失败构建', operationId: 'engine.get_diagnostics', input: {},
        notes: '核对 build.attemptId、failed 和 run 为 null。然后回到 /src/Player.ts 删除刚才加的行。'},
      {id: 'check-repaired', label: '复查修复版', operationId: 'check', input: {},
        notes: '更新目标后执行。保留此检查的 sourceHash。'},
      {id: 'read-repaired', label: '核对复查结果', operationId: 'engine.get_diagnostics', input: {},
        notes: '确认 check 已观测到零错误。支持同帧探测和物理帧输入时，可从「等待启动与退出」的第一步启动修复版，核对构建 sourceHash 后继续试玩。'},
      {id: 'play-repaired', label: '启动修复版', operationId: 'engine.play', input: {},
        notes: '也可以直接启动修复版，用本地等待确认新会话，再查看新构建和关联运行。'},
      {id: 'wait-repaired', label: '等待修复版启动', operationId: 'wait_for_event', input: {until: 'running', timeoutMs: 60000},
        notes: '从修复版 Play 回执填入 attemptId。确认新的 runId。'},
      {id: 'read-repaired-run', label: '核对修复版构建和运行', operationId: 'engine.get_diagnostics', input: {},
        notes: '核对 build.sourceHash 与复查相同，run.identity.runId 与本次启动相同。'},
    ],
  },
  {
    id: 'lifecycle-events',
    title: 'Summer：等待启动与退出',
    description: '从 engine.game_input 打开独立示例。用游标确认两次真实启动和退出，观察位置 64 → 128 → 64。',
    steps: [
      takeCursor('cursor-start', 'Play'),
      {id: 'play', label: '启动示例', operationId: 'engine.play', input: {}},
      waitLifecycle('started', true),
      lifecycleProbe('before', 64),
      {id: 'move', label: '按住向右动作四步', operationId: 'engine.game_input',
        input: {...SUMMER_OPERATION_SPECS['engine.game_input'].defaultInput}, needsRunSource: true,
        notes: '从起点探测回执选择本次运行。'},
      lifecycleProbe('after', 128),
      takeCursor('cursor-stop', 'Stop'),
      stopLifecycleRun('stop'),
      waitLifecycle('stopped', false),
      takeCursor('cursor-restart', '重启'),
      {id: 'restart', label: '以同一源码重启', operationId: 'engine.play', input: {},
        notes: '从下一次启动事件核对相同的 sourceHash 和新的 runId。'},
      waitLifecycle('restarted', true),
      lifecycleProbe('reset', 64),
      takeCursor('cursor-final-stop', '第二次 Stop'),
      stopLifecycleRun('final-stop'),
      waitLifecycle('final-stopped', false),
    ],
  },
  {
    id: 'input-script',
    title: 'Summer：用输入验证移动',
    description: '从输入标签打开独立示例。先探测起点，再执行四个物理步的移动输入并用画面验证。',
    steps: [
      {id: 'input-play', label: '启动示例', operationId: 'engine.play', input: {}},
      {id: 'input-ready', label: '等待本次启动', operationId: 'wait_for_event', input: {until: 'running', timeoutMs: 60000}, notes: '从本次启动回执填入 attemptId。' + inputScriptReady},
      {id: 'input-before', label: '探测起点 x=64', operationId: 'engine.game_probe', input: {tree: {path: '/root/Main'}, props: [INPUT_SCRIPT_PLAYER_PATH + ':position']}},
      {id: 'input-execute', label: '按住向右动作四步', operationId: 'engine.game_input', input: {...SUMMER_OPERATION_SPECS['engine.game_input'].defaultInput},
        needsRunSource: true, notes: '从起点探测回执选择本次运行，再执行并核对两个边沿。'},
      {id: 'input-after', label: '验证位置 x=128', operationId: 'engine.game_probe', input: {tree: {path: '/root/Main'}, props: [INPUT_SCRIPT_PLAYER_PATH + ':position']}},
      {id: 'input-key', label: '按住物理右键四步', operationId: 'engine.game_input', needsRunSource: true,
        input: {action: 'script', clock: 'frame', events: [
          {type: 'key', physical_keycode: 4194321, pressed: true, at_frame: 0},
          {type: 'key', physical_keycode: 4194321, pressed: false, at_frame: 4},
        ]}, notes: '从位置探测回执选择本次运行。按顺序执行时，Player 会再移动 64。'},
      lifecycleProbe('input-after-key', 192),
      {id: 'input-click', label: '点击左上角重置位置', operationId: 'engine.game_input', needsRunSource: true,
        input: {action: 'script', clock: 'frame', events: [{type: 'mouse_click', position: [0, 0], button: 1, at_frame: 0}]},
        notes: '从最近一次探测回执填入运行和画布版本。重置区从画布原点开始，也可以按探测图的原始尺寸换算区内坐标。'},
      lifecycleProbe('input-after-click', 64),
      {id: 'input-stop', label: '停止已验证的运行', operationId: 'engine.stop', input: {}, needsRunSource: true, notes: '从移动后探测回执选择目标。'},
      {id: 'input-exit', label: '确认原运行退出', operationId: 'wait_for_event', input: {until: 'exited'}, notes: '从停止回执填入 runId。'},
      {id: 'input-restart', label: '以同一源码重启', operationId: 'engine.play', input: {}},
      {id: 'input-ready-new', label: '等待新的运行', operationId: 'wait_for_event', input: {until: 'running', timeoutMs: 60000}, notes: '使用第二次启动回执。' + inputScriptReady},
      {id: 'input-reset', label: '确认恢复起点 x=64', operationId: 'engine.game_probe', input: {tree: {path: '/root/Main'}, props: [INPUT_SCRIPT_PLAYER_PATH + ':position']}},
      {id: 'input-stop-new', label: '停止新运行', operationId: 'engine.stop', input: {}, needsRunSource: true, notes: '从恢复起点的探测回执选择新运行。'},
      {id: 'input-exit-new', label: '确认新运行退出', operationId: 'wait_for_event', input: {until: 'exited'}, notes: '从第二次停止回执填入 runId。'},
    ],
  },
  {
    id: 'game-probe',
    title: 'Summer：验证同帧状态与画面',
    description: '打开独立位置示例，先探测起点，再移动 Player 并从同一运行验证画面。',
    steps: [
      {id: 'play', label: '启动位置示例', operationId: 'engine.play', input: {}},
      {id: 'wait', label: '等待该次运行', operationId: 'wait_for_event', input: {until: 'running', timeoutMs: 60000}, notes: '从本次启动的历史结果填入 attemptId。'},
      {id: 'tree', label: '找出本次 Player', operationId: 'engine.get_runtime_tree', input: {depth: 3, limit: 50}},
      {id: 'before', label: '探测位置和画面', operationId: 'engine.game_probe', input: {screenshot: true}, notes: '选择该次运行树中的 Player 填参，核对 x=64 和 PNG。'},
      {id: 'move', label: '移动 Player 到 x=192', operationId: 'engine.runtime_set', input: {property: 'position', value: 'Vector2(192, 256)'}, notes: '从同一次运行树填入 Player 路径。'},
      {id: 'after', label: '再次探测同一 Player', operationId: 'engine.game_probe', input: {screenshot: true}, notes: '重新填参，核对 x=192、像素、同一实例和更大的 renderSerial。'},
      {id: 'stop', label: '停止并确认退出', operationId: 'engine.stop', input: {}},
      {id: 'exit', label: '等待原运行退出', operationId: 'wait_for_event', input: {until: 'exited', timeoutMs: 10000}, notes: '从停止回执填入 runId。'},
      {id: 'restart', label: '启动新运行', operationId: 'engine.play', input: {}},
      {id: 'wait-new', label: '等待新运行', operationId: 'wait_for_event', input: {until: 'running', timeoutMs: 60000}, notes: '用第二次启动回执填入 attemptId。'},
      {id: 'tree-new', label: '重新发现 Player', operationId: 'engine.get_runtime_tree', input: {depth: 3, limit: 50}},
      {id: 'reset', label: '验证恢复起点', operationId: 'engine.game_probe', input: {screenshot: true}, notes: '从新树填参，核对新 run 和 x=64。'},
      {id: 'stop-new', label: '停止新运行', operationId: 'engine.stop', input: {}},
      {id: 'exit-new', label: '确认新运行退出', operationId: 'wait_for_event', input: {until: 'exited', timeoutMs: 10000}, notes: '用第二次停止回执填入 runId。'},
    ],
  },
  {
    id: 'runtime-method',
    title: 'Summer：调用玩法方法',
    description: '从方法调用标签打开独立示例。点击步骤载入草稿。在目标标签的共享历史中查看来源，选择该次运行的目标，再点「填入当前操作」。确认参数后手动执行。',
    steps: [
      {id: 'play', label: '启动示例', operationId: 'engine.play', input: {}, notes: '执行后，从当前调用结果取得 attemptId。'},
      {id: 'wait-running', label: '等待启动（本地辅助）', operationId: 'wait_for_event', input: {until: 'running', timeoutMs: 60000}, notes: '查看本次 play 结果并填入 attemptId。确认 outcome 为 reached、公开方法调用为可用后继续。'},
      {id: 'tree', label: '发现 Player', operationId: 'engine.get_runtime_tree', input: {depth: 3, limit: 50}, notes: '为本次运行找到 /root/Main/Player 的实际实例。'},
      {id: 'describe-health', label: '发现血量属性（本地辅助）', operationId: 'describe_runtime_properties', input: {names: ['health']}, notes: '查看本次运行树，选择 Player 并填参。执行后取得 health 的类型。'},
      {id: 'read-before', label: '读取初始血量（本地辅助）', operationId: 'read_runtime_properties', input: {}, notes: '查看本次属性发现结果，选择 health 并填参。执行后确认血量为 100。'},
      {id: 'screenshot-before', label: '采集调用前的画面', operationId: 'engine.screenshot', input: {target: 'game'}, notes: '保留本次运行的完整血条 PNG。'},
      {id: 'describe', label: '发现玩法方法（本地辅助）', operationId: 'describe_runtime_methods', input: {}, notes: '查看本次运行树，选择 Player 并填参，再执行方法发现。'},
      {id: 'invoke', label: '调用 take_damage(25)', operationId: 'engine.runtime_call', input: {args: [25]}, notes: '查看本次方法发现结果，选择 take_damage 并填参。执行一次，核对返回 75。如果结果未确认，先独立读回血量。'},
      {id: 'read', label: '独立读回血量（本地辅助）', operationId: 'read_runtime_properties', input: {}, notes: '仍使用本次运行的属性发现结果，选择 health 并填参。执行后确认血量为 75。'},
      {id: 'screenshot', label: '观察血条缩短', operationId: 'engine.screenshot', input: {target: 'game'}, notes: '对照同一运行的前图，查看血条与后续 renderSerial。'},
      {id: 'stop', label: '请求停止原运行', operationId: 'engine.stop', input: {}, notes: '保留该次 stop 结果中的原 runId。'},
      {id: 'wait-exited', label: '确认原运行退出（本地辅助）', operationId: 'wait_for_event', input: {until: 'exited', timeoutMs: 10000}, notes: '在刚才的 stop 结果中选择原 runId 并填参。确认 outcome 为 reached，并查看退出回执。'},
      {id: 'restart', label: '以同一源码重新启动', operationId: 'engine.play', input: {}, notes: '保持源码，执行后取得新的 attemptId。'},
      {id: 'wait-restarted', label: '等待重新启动（本地辅助）', operationId: 'wait_for_event', input: {until: 'running', timeoutMs: 60000}, notes: '使用第二次 play 的结果填参。确认 outcome 为 reached，并取得新的 runId。'},
      {id: 'tree-restarted', label: '在新运行中发现 Player', operationId: 'engine.get_runtime_tree', input: {depth: 3, limit: 50}, notes: '使用这次运行树中的 Player 做后续发现。'},
      {id: 'describe-restarted', label: '重新发现血量属性（本地辅助）', operationId: 'describe_runtime_properties', input: {names: ['health']}, notes: '从新运行树选择 Player 并填参。'},
      {id: 'read-restarted', label: '读取恢复后的血量（本地辅助）', operationId: 'read_runtime_properties', input: {}, notes: '从新发现结果选择 health 并填参。执行后确认恢复为 100。'},
      {id: 'screenshot-restarted', label: '观察恢复后的血条', operationId: 'engine.screenshot', input: {target: 'game'}, notes: '查看新运行的完整血条 PNG。'},
      {id: 'stop-restarted', label: '请求停止新运行', operationId: 'engine.stop', input: {}, notes: '查看本次 stop 捕获的新 runId。'},
      {id: 'wait-restarted-exited', label: '确认新运行退出（本地辅助）', operationId: 'wait_for_event', input: {until: 'exited', timeoutMs: 10000}, notes: '从最新的 stop 结果选择新 runId 并填参，然后查看退出回执。'},
    ],
  },
  {
    id: 'summer-position',
    title: 'Summer：观察与修改位置',
    description: '先打开独立示例。每一步只填入请求，由你执行、阅读结果并继续；等待启动和退出使用明确标注的 GodotAI 辅助。',
    steps: [
      {id: 'context', label: '1 · 读取项目上下文', operationId: 'engine.get_project_context', input: {}, notes: '核对编辑项目、主运行归属及当前能力；本页展示的是 Summer 输入子集与 GodotAI typed-v1 返回。'},
      {id: 'play', label: '2 · 启动示例', operationId: 'engine.play', input: {}, notes: 'accepted/pending 只证明启动请求已接纳。保留本次 attemptId，不把 done 当作已经运行。'},
      {id: 'wait-running', label: '3 · 等待本次启动（本地辅助）', operationId: 'wait_for_event', inputOverrides: {until: 'running', timeoutMs: 60000}, notes: '从 play 结果使用原 attemptId 填参；只在 outcome=reached 且取得本次 run 后继续。取消只停止等待。'},
      {id: 'tree', label: '4 · 读取真实节点树', operationId: 'engine.get_runtime_tree', input: {depth: 3, limit: 500}, notes: '找到实际 Player，使用此结果填入 path；本地属性目标还需要同一结果的 runId 和 instanceId。'},
      {id: 'inspect-before', label: '5 · 读取初始位置', operationId: 'engine.inspect_runtime_node', notes: '使用本次 tree 的 Player 路径。标准样例初始位置为 (64,256)；此接口固定读取 position/rotation/visible。'},
      {id: 'screenshot-before', label: '6 · 采集修改前画面', operationId: 'engine.screenshot', input: {target: 'game'}, notes: '查看真实 PNG 与其 run/renderSerial；状态采样和 PNG 不是同帧事务。'},
      {id: 'set-position', label: '7 · 将 Player 移至 (192,256)', operationId: 'engine.runtime_set', inputOverrides: {property: 'position', value: 'Vector2(192, 256)'}, notes: '保留来自实际节点树的 path。修改只作用于本次运行；结果未确认时先观察，不能自动重试。'},
      {id: 'inspect-after', label: '8 · 独立读回位置', operationId: 'engine.inspect_runtime_node', notes: '显式再次执行 inspect，确认本次 run 的 position=(192,256)，不要只依据写入请求判断效果。'},
      {id: 'screenshot-after', label: '9 · 观察修改后画面', operationId: 'engine.screenshot', input: {target: 'game'}, notes: '核对同一 run 的后续 PNG，白色标记应位于新位置；图片本身不会自动判定玩法正确。'},
      {id: 'stop', label: '10 · 请求停止', operationId: 'engine.stop', input: {}, notes: '查看本次捕获的 runs[]；接纳停止请求不等于已确认退出。'},
      {id: 'wait-exited', label: '11 · 确认原运行退出（本地辅助）', operationId: 'wait_for_event', inputOverrides: {until: 'exited', timeoutMs: 10000}, notes: '先从 stop 结果逐个选原 runId，再填入退出等待；删除已有 attemptId，两个 ID 二选一。不得重新取后来 activeRunId 代替。'},
    ],
  },
  {
    id: 'gameplay-properties',
    title: '混合 API：血量、移动与重启',
    description: '需要公开脚本属性、输入和截图能力。Summer 写入与 GodotAI 显式发现/读取/输入分别标明；教程不自动执行或断言。',
    steps: [
      {id: 'check', label: '1 · 检查当前示例（本地辅助）', operationId: 'check', notes: '用当前 projectId/editorRevision 填参。只有 completed 且类型错误为零才继续。'},
      {id: 'play', label: '2 · 启动示例', operationId: 'engine.play', input: {}, notes: '保存本次 play 返回的 attemptId。'},
      {id: 'wait-running', label: '3 · 等待本次运行（本地辅助）', operationId: 'wait_for_event', inputOverrides: {until: 'running', timeoutMs: 60000}, notes: '从原 play 结果填入 attemptId，确认 reached 并取得 run。'},
      {id: 'tree', label: '4 · 发现 Player', operationId: 'engine.get_runtime_tree', input: {depth: 3, limit: 500}, notes: '将本次 Player 的 runId/path/instanceId 用于本地属性请求；同路径不保证跨运行实例相同。'},
      {id: 'describe', label: '5 · 发现公开属性（本地辅助）', operationId: 'describe_runtime_properties', inputOverrides: {names: ['health', 'move_step']}, notes: '发现不执行 getter；从 found 描述取得 health:int、move_step:float。candidate 表示可尝试访问。'},
      {id: 'read-before', label: '6 · 显式读取初值（本地辅助）', operationId: 'read_runtime_properties', notes: '从本次 describe 结果填入 name/expectedType，确认 health=100、move_step=64；读取可能执行 getter。'},
      {id: 'set-health', label: '7 · 设置血量 40', operationId: 'engine.runtime_set', inputOverrides: {property: 'health', value: 40}, notes: '保留本次 Player 路径；不要将本地 runId/expectedInstanceId 放进 Summer input。'},
      {id: 'read-health', label: '8 · 独立读回血量（本地辅助）', operationId: 'read_runtime_properties', notes: '再次显式读取，确认 health=40。Summer inspect 不会返回脚本 health。'},
      {id: 'screenshot-health', label: '9 · 观察血条', operationId: 'engine.screenshot', input: {target: 'game'}, notes: '绿色血条应缩短；核对 PNG 归属，截图与前次读回各自记录采样事实。'},
      {id: 'set-move-step', label: '10 · 设置移动步长 128', operationId: 'engine.runtime_set', inputOverrides: {property: 'move_step', value: 128}, notes: '保留实际 Player 路径；再执行本地 read 确认 move_step=128。'},
      {id: 'read-move-step', label: '11 · 独立读回步长（本地辅助）', operationId: 'read_runtime_properties', notes: '复用同一 run 的属性目标和类型，确认 move_step=128。'},
      {id: 'input-down', label: '12 · 重置位置（本地输入）', operationId: 'game_input', inputOverrides: {gesture: {kind: 'key_tap', code: 'ArrowDown'}}, notes: '保留本次 runId。接纳回执给出 operationId，不证明原生已经消费。'},
      {id: 'wait-down', label: '13 · 等待 Down 分发（本地辅助）', operationId: 'wait_for_input', notes: '从上一步结果填同一对 runId/operationId，确认 down/up；取消等待不撤回输入。'},
      {id: 'input-right', label: '14 · 向右移动（本地输入）', operationId: 'game_input', inputOverrides: {gesture: {kind: 'key_tap', code: 'ArrowRight'}}, notes: '本次仍使用同一 run；随后等待这个新 operationId。'},
      {id: 'wait-right', label: '15 · 等待 Right 分发（本地辅助）', operationId: 'wait_for_input', notes: '使用刚才 Right 的 operationId，不能沿用 Down 的回执。'},
      {id: 'inspect-moved', label: '16 · 读回移动结果', operationId: 'engine.inspect_runtime_node', notes: '独立确认 position=(192,256)；未观察到时可再次查询，输入分发不等于业务结果。'},
      {id: 'screenshot-moved', label: '17 · 观察标记和血条', operationId: 'engine.screenshot', input: {target: 'game'}, notes: '核对同一 run 的后续画面。'},
      {id: 'stop', label: '18 · 停止原运行', operationId: 'engine.stop', input: {}, notes: '保存 stop 捕获的 runId，不能用后来主运行代替。'},
      {id: 'wait-exited', label: '19 · 等待原运行退出（本地辅助）', operationId: 'wait_for_event', inputOverrides: {until: 'exited', timeoutMs: 10000}, notes: '先从 stop 结果填入原 runId，再填退出等待；删除已有 attemptId，两个 ID 二选一。查看原生退出及宿主清理事实。'},
      {id: 'restart', label: '20 · 同源码重新启动', operationId: 'engine.play', input: {}, notes: '本次会得到新的 attempt。旧节点实例与输入回执不能自动填给新 run。'},
      {id: 'wait-restarted', label: '21 · 等待新运行（本地辅助）', operationId: 'wait_for_event', inputOverrides: {until: 'running', timeoutMs: 60000}, notes: '从第二次 play 的结果使用新 attemptId；删除旧 runId。确认 reached 且取得新 run。'},
      {id: 'tree-restarted', label: '22 · 重新发现 Player', operationId: 'engine.get_runtime_tree', input: {depth: 3, limit: 500}, notes: '显式更新 Summer 目标至新 run，并使用这次 tree 的节点；不得沿用旧 instanceId。'},
      {id: 'describe-restarted', label: '23 · 重新发现属性（本地辅助）', operationId: 'describe_runtime_properties', inputOverrides: {names: ['health', 'move_step']}, notes: '从新 tree 填入新 runId/path/expectedInstanceId。'},
      {id: 'read-restarted', label: '24 · 读回恢复后的初值（本地辅助）', operationId: 'read_runtime_properties', notes: '从新的 describe 结果填参，确认 health=100、move_step=64。'},
      {id: 'inspect-restarted', label: '25 · 确认位置恢复', operationId: 'engine.inspect_runtime_node', notes: '使用新 tree 的路径，确认 position=(64,256)。运行时修改没有保存至源码或场景。'},
      {id: 'stop-restarted', label: '26 · 停止第二次运行', operationId: 'engine.stop', input: {}, notes: '查看本次 stop 捕获的新 run 列表，不沿用首次运行。'},
      {id: 'wait-restarted-exited', label: '27 · 确认第二次退出（本地辅助）', operationId: 'wait_for_event', inputOverrides: {until: 'exited', timeoutMs: 10000}, notes: '从最新 stop 结果填入新 runId；删除 attemptId，确认退出与宿主清理事实。'},
    ],
  },
];
