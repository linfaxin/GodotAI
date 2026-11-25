/** Application-local Summer subset. Data only: execution validation stays in the adapter/SDK. */
export const SUMMER_REFERENCE = Object.freeze({
  version: '4.9.2',
  commit: '5d0bc70c6228a2f718485913449f20482434b47b',
  url: 'https://github.com/SummerEngine/summer/tree/5d0bc70c6228a2f718485913449f20482434b47b',
});

export const SUMMER_COMPATIBILITY = Object.freeze({input: 'subset' as const, semantics: 'partial' as const,
  payload: 'godotai-typed-v1' as const, summerNativeFixture: false as const});

export const SUMMER_TREE_LIMITS = Object.freeze({
  depth: Object.freeze({min: 1, max: 8, default: 3}),
  limit: Object.freeze({min: 1, max: 500, default: 500}),
});

export interface OperationParameter {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
}
export interface SummerOperationSpec {
  readonly title: string;
  readonly description: string;
  readonly allowed: readonly string[];
  readonly unsupported: readonly string[];
  readonly parameters: readonly OperationParameter[];
  readonly limitations: readonly string[];
  readonly defaultInput: Readonly<Record<string, unknown>>;
}

function spec<const T extends SummerOperationSpec>(value: T): Readonly<T> {
  Object.freeze(value.allowed);
  Object.freeze(value.unsupported);
  value.parameters.forEach(Object.freeze);
  Object.freeze(value.parameters);
  Object.freeze(value.limitations);
  Object.freeze(value.defaultInput);
  return Object.freeze(value);
}

export const SUMMER_OPERATION_SPECS = Object.freeze({
  'engine.get_project_context': spec({
    title: '读取项目上下文', description: '读取当前编辑项目、编辑版本、引擎发布与预览环境。',
    allowed: [], unsupported: ['include', 'settingsPrefix', 'settingsPrefixes'], parameters: [], defaultInput: {},
    limitations: ['返回 GodotAI context；activeRunId 可能属于之前的项目。', '不支持 include 与项目设置筛选。'],
  }),
  'engine.play': spec({
    title: '构建并启动游戏', description: '捕获当前编辑版本并开始构建；接纳后返回 attemptId。',
    allowed: ['instance'], unsupported: ['scene', 'mode', 'focus', 'deterministic', 'seed', 'fixed_fps', 'time_scale', 'speed', 'players', 'spectators', 'queue'],
    parameters: [{name: 'instance', description: '省略或 main；仅支持主运行。'}], defaultInput: {},
    limitations: ['done 仅表示已接纳，data.state 为 pending；继续查询或显式等待该 attempt。',
      '使用冻结的编辑版本构建；构建失败保留旧运行，与 Summer 从已保存文件先停再启动的语义不同。'],
  }),
  'engine.stop': spec({
    title: '停止捕获的游戏运行', description: '取消接纳时捕获的 pending attempt，并请求停止其运行与当前 main run。',
    allowed: ['instance'], unsupported: [],
    parameters: [{name: 'instance', description: '省略或 main；仅支持主运行。'}], defaultInput: {},
    limitations: ['目标是页面当时的主运行，可能属于之前的编辑项目。', '返回停止接纳与各 run 的回执；需要后续退出事实才能确认结束。'],
  }),
  'engine.is_running': spec({
    title: '查询主运行状态', description: '查询接纳时捕获的 main run 是否实际处于 running。',
    allowed: [], unsupported: [], parameters: [], defaultInput: {},
    limitations: ['不接受 instance。', 'playing 不证明本次 play 已完成，也不证明属性、输入与截图能力已就绪。'],
  }),
  'engine.get_runtime_tree': spec({
    title: '读取运行时节点树', description: '读取运行中的实际节点，返回绝对路径、实例 ID 与截断事实。',
    allowed: ['path', 'depth', 'limit'], unsupported: ['maxCharacters'],
    parameters: [
      {name: 'path', description: '可选绝对节点路径；省略时从实际 SceneTree 根开始。'},
      {name: 'depth', description: `整数 ${SUMMER_TREE_LIMITS.depth.min}–${SUMMER_TREE_LIMITS.depth.max}，默认 ${SUMMER_TREE_LIMITS.depth.default}。`},
      {name: 'limit', description: `整数 ${SUMMER_TREE_LIMITS.limit.min}–${SUMMER_TREE_LIMITS.limit.max}，默认 ${SUMMER_TREE_LIMITS.limit.default}。`},
    ], defaultInput: {depth: SUMMER_TREE_LIMITS.depth.default, limit: SUMMER_TREE_LIMITS.limit.default},
    limitations: ['不支持 maxCharacters；返回 GodotAI 平面节点列表及运行身份。'],
  }),
  'engine.inspect_runtime_node': spec({
    title: '检查运行时节点', description: '读取实际节点的 position、rotation 与 visible 原生属性。',
    allowed: ['path'], unsupported: ['maxCharacters'],
    parameters: [{name: 'path', description: '从实际运行树取得的绝对节点路径。', required: true}], defaultInput: {},
    limitations: ['固定读取三项原生属性；不支持 properties 或 instance，不读取 health 等脚本 getter。'],
  }),
  'engine.runtime_set': spec({
    title: '修改运行时属性', description: '修改实际运行对象并报告原生写入阶段、独立 readback 与运行身份。',
    allowed: ['path', 'property', 'value', 'instance'], unsupported: ['field'],
    parameters: [
      {name: 'path', description: '从实际运行树取得的绝对节点路径。', required: true},
      {name: 'property', description: '支持的脚本导出标量或 Node2D.position；script 与 owner 拒绝。', required: true},
      {name: 'value', description: 'JSON boolean/number/string；position 使用 "Vector2(192, 256)" 字符串。', required: true},
      {name: 'instance', description: '省略或 main；不支持其它实例。'},
    ], defaultInput: {property: 'position', value: 'Vector2(192, 256)'},
    limitations: ['脚本导出仅支持 bool/int/float/string；原生写入仅 Node2D.position。',
      '不支持 field、Vector3、Color；不接受 runId 或 expectedInstanceId。',
      '按提交时的当前运行重新解析 path；不保证跨调用固定同一节点实例。未确认写入不可自动重试。'],
  }),
  'engine.runtime_call': spec({
    title: '调用公开玩法方法', description: '发现登记的脚本方法并在已绑定的运行中调用一次。',
    allowed: ['path', 'method', 'args', 'instance'], unsupported: [],
    parameters: [
      {name: 'path', required: true, description: '从实际运行树取得的绝对节点路径。'},
      {name: 'method', required: true, description: '类明确登记的方法名称。'},
      {name: 'args', description: '按登记签名提供至多八个标量，省略时使用空数组。'},
      {name: 'instance', description: '省略或 main。'},
    ],
    defaultInput: {args: []},
    limitations: ['只支持明确登记的同步标量签名。', '超时或取消可能留下未确认结果，请先独立观察。'],
  }),
  'engine.game_input': spec({
    title: '按物理帧发送动作', description: '为主运行安排同一个 InputMap 动作的按下和释放。',
    allowed: ['action', 'instance', 'clock', 'wait', 'events'],
    unsupported: ['include_motion', 'save_as', 'recording', 'seed'],
    parameters: [
      {name: 'action', required: true, description: 'script'},
      {name: 'instance', description: '省略或 main。'},
      {name: 'clock', description: 'frame，对应原生物理帧。'},
      {name: 'wait', description: '省略或 true，等待释放迭代结束。'},
      {name: 'events', required: true, description: '同一已注册动作的两条 action 边沿，显式 pressed:true/false，偏移递增，最大 120。'},
    ],
    defaultInput: {action: 'script', events: [
      {type: 'action', action: 'move_right', pressed: true, at_frame: 0},
      {type: 'action', action: 'move_right', pressed: false, at_frame: 4},
    ]},
    limitations: ['Full/debug Chromium Worker Direct。支持物理步内的动作轮询。', '使用 game_probe 验证玩法结果。'],
  }),
  'engine.game_probe': spec({
    title: '探测游戏帧', description: '读取一次正常渲染提交的节点状态和 PNG，或单独读取迭代结束时的状态。',
    allowed: ['instance', 'tree', 'props', 'screenshot', 'max_dim'], unsupported: [],
    parameters: [
      {name: 'instance', description: '省略或 main。'},
      {name: 'tree', description: '可选子树 {path?, depth?, limit?}。'},
      {name: 'props', description: '最多 16 个绝对路径:属性名，支持 position、rotation、visible。'},
      {name: 'screenshot', description: '默认 true。false 只读取状态。'},
      {name: 'max_dim', description: '图像最长边 16–1024 像素，默认 1024。'},
    ],
    defaultInput: {screenshot: true},
    limitations: ['需要匹配的 Full/debug Worker Direct 预览。'],
  }),
  'engine.screenshot': spec({
    title: '截取游戏画面', description: '等待当前运行的新渲染提交，返回实际 PNG 字节与画面身份。',
    allowed: ['target'], unsupported: ['scenePath', 'framing', 'bookmark_name', 'size', 'nodePath', 'camera_path', 'camera_position', 'camera_look_at', 'fov', 'marks', 'max_marks', 'compare_previous', 'update_previous'],
    parameters: [{name: 'target', description: '必须显式填写 game。', required: true}], defaultInput: {target: 'game'},
    limitations: ['仅支持游戏画面，不支持 viewport/scene/camera/size 等参数。', '截图与属性采样分别计数，不代表同帧状态快照。'],
  }),
});

export type SummerOperation = keyof typeof SUMMER_OPERATION_SPECS;
