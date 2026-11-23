/** Teaching data only. Loading a step never executes it or advances another step. */
export interface ConsoleLessonStep {
  id: string;
  label: string;
  operationId: string;
  /** A complete input for requests that need no runtime-generated identity. */
  input?: Record<string, unknown>;
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

export const CONSOLE_LESSONS: readonly ConsoleLesson[] = [
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
