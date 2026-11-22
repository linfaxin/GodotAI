# 运行时公开脚本属性与 Summer API 对齐实施方案

状态：已由[评审修订方案 V2](runtime-properties-and-summer-api-v2.zh-CN.md)取代，保留原提案供追溯。日期：2026 年 11 月 21 日。代码基线：`8583001d5d2966c8ba78e9409d3e7d9c0bad66b4`。Summer 参照版本：`summer-engine@4.9.2`，源码提交 `5d0bc70c6228a2f718485913449f20482434b47b`。

下一期交付一个可由程序驱动的游戏状态调试闭环：发现运行节点的公开脚本属性，按类型读取和修改，通过原生读回、独立查询、输入效果及画面验证，再重启确认修改没有持久化。Playground 经同一 Summer 操作适配器演示这条链路。

主要新增能力是标准 GodotJS 导出属性的运行时访问。兼容适配、类型和执行回执随这条链路一起交付。现有位置写入继续作为回归；任意方法调用、精确单步、同帧采样和更多脚本语言分别后续推进。职责遵循[引擎目标](../engine-goals.zh-CN.md)与[仓库架构](../architecture.md)。本提案中的新增 API、ABI、测试用例名称均是拟实施合同。

## 一 方向选择与交付边界

| 方向 | 对 Agent 的新增价值 | 本期决定 |
| --- | --- | --- |
| Summer 兼容入口 | 复用操作名和已支持的输入，明确能力差异 | 作为第一个小里程碑，贯穿后续演示 |
| 公开脚本属性发现和读写 | 检查血量、调整参数、设置测试条件，覆盖实际游戏状态 | 作为本期主要原生能力 |
| runtime_call | 触发受伤、复活等游戏规则 | 下一阶段，复用本期类型与执行基础 |
| Node3D 和更多内置属性 | 扩大现有 3D 示例覆盖 | 按真实接入需要插入，不作为本期前置 |
| 同帧 probe | 关联动态游戏的状态与像素 | 独立设计采样检查点，不能由顺序调用拼接 |
| pause 和 step | 稳定复现和精确推进游戏 | 单独定义调度范围，不与本期捆绑 |

另一条可行路线是先增加 Node3D 变换及 Node2D 的更多 setter。它能更快扩大可展示范围，但仍不能检查脚本业务状态，因此不选作本期主线。单独补 `value_before` 和帧号主要完善回执，不足以构成新的玩法调试能力；这些字段随公开脚本属性访问一起补齐。

首期支持活跃公开树中已绑定的 GodotJS 脚本导出属性，复用 `@bind.export` 等现有机制。普通 TS 字段、函数局部变量和 React hook 状态不自动成为可发现属性。Agent 可通过自身文件工具为项目增加标准导出，创作者无需手工配置调试注册表。

本期不提供游戏专用 `registerState` 协议、任意 JS eval、对象图遍历、动态 `_get/_set/_get_property_list`、跨调用事务、自动重试或回滚。GDScript/GDExtension、Object/Resource/RID、容器、完整 int64、方法 Promise 等待、素材生成及云发布不在本期范围。项目文件编辑和持久历史继续归平台。

## 二 当前基础与必须保持的合同

| 当前实现 | 已有能力 | 本期处理 |
| --- | --- | --- |
| [Playground API](../../apps/playground/src/playground-api.ts) | 检查、构建预览、运行记录、等待、停止及工具入口 | 保留；新增原语由同一入口装配 |
| [Worker runner](../../packages/engine/src/browser/dedicated/worker-runner.ts) | 运行树、节点观察、位置写入、输入与 PNG | 复用身份、能力发现和生命周期 |
| [原生观察与写入](../../bridge/jsb_runtime_observation.cpp) | 直接读取 position/rotation/visible；写 Node2D.position 并读回 | 旧 ABI 不变，新能力独立声明 |
| [脚本实例](../../weaver/jsb_script_instance.cpp) | 导出属性 get/set；get 可能先返回缓存 | 新 live 路径绕开缓存，不修改既有缓存语义 |
| [Environment 属性桥](../../bridge/jsb_environment.cpp) | 实际 JS Get/Set 和类型桥 | 增加运行时访问 helper 与分阶段结果 |
| [Agent 面板](../../apps/playground/src/workbench/agent-panel.ts) | 位置写入、独立观察、PNG、重启与收尾 | 保留旧回放，增加公开脚本属性回放 |

现有 `observation:1` 明确绕开 `Object::get`，避免执行用户 getter。新脚本读取可能执行游戏代码，因此新增独立 `runtimeProperties:1`，不扩大旧 `inspect_runtime_node` 或旧 `runtime_set` 的含义。旧属性读取仍只有 position、rotation、visible，旧写入仍只有 Node2D.position。

脚本导出不等于可读可写。当前 `ScriptPropertyInfo` 没有可靠的 getter/setter 访问模式；属性桥的布尔成功值也不证明 setter 生效。新合同使用静态支持范围、实际尝试阶段和原生读回表达结果。

## 三 公共接口与类型

SDK 增加 `describeRuntimeProperties`、`readRuntimeProperties`、`writeRuntimeProperty`。Playground 对应提供以下方法，现有方法和唯一全局入口继续保留：

```ts
type Target = {
  runId: string;
  path: string;
  expectedInstanceId: string;
  timeoutMs?: number;
};

describe_runtime_properties(input: Target & {
  names?: string[];
  limit?: number;
}, signal?: AbortSignal);

read_runtime_properties(input: Target & {
  properties: Array<{name: string; expectedType: RuntimeType}>;
}, signal?: AbortSignal);

write_runtime_property(input: Target & {
  property: string;
  value: RuntimeValue;
}, signal?: AbortSignal);

type RuntimeType = 'bool' | 'int' | 'float' | 'string' | 'vector2';
type RuntimeValue =
  | {type: 'bool'; value: boolean}
  | {type: 'int'; value: number}
  | {type: 'float'; value: number}
  | {type: 'string'; value: string}
  | {type: 'vector2'; value: {x: number; y: number}};
```

写入的 `value.type` 同时是声明类型前置条件。发现结果是当时的元数据观察，不是永久授权；原生每次执行重新核对声明。首期不增加公共 schema hash/token；同一操作内的脚本替换由内部绑定身份检查处理。发现之后、下一次操作之前发生的同类型脚本替换不由该前置条件阻止；若接入需要这种保证，再增加显式绑定版本。

描述符包含 `name`、`declaredType`、支持的 wire `type`、`origin`、`readAccess`、`writeAccess`、`readMayExecuteScript`、`writeMayExecuteScript` 及限制原因。访问状态为 `supported`、`candidate` 或 `unsupported`：直接实现的内置 getter 可以确认为 supported；脚本导出默认是 candidate；显式只读 usage 的写入为 unsupported。candidate 表示允许尝试，不保证存在 getter/setter或访问成功。正常演示用 auto-accessor，面板不把 candidate 展示成“已确认可写”。Node2D.position 的原生写入可能通过通知执行脚本，不能因为 origin 为 native 就将 writeMayExecuteScript 标为 false。

发现只使用已绑定实例的静态导出表，不读取属性值，不加载模块，不求默认值，也不调用动态属性枚举。派生类同名声明优先，继承解析有界。首期不为推断访问模式运行 JS descriptor/proxy 逻辑；如以后需要可靠的 readable/writable，再扩展 binder 元数据。

新原语支持已有的 Node2D.position 路径，并可描述既有 position/rotation/visible 读取范围；本期不增加 rotation/visible 的 setter。内置项按确定的原生路径解析；与内置名称冲突的脚本导出不作为第二个同名访问目标，描述结果明确报告冲突。

### 值和预算

| 项目 | 首期规则 |
| --- | --- |
| int | 仅 JS 安全整数；小数和越界写入在进入 getter/setter 前拒绝；越界读取返回 unavailable |
| float | 有限 double；不得把 Variant float 的范围错误收窄到 real_t |
| vector2 | x/y 有限；检查当前构建 real_t 范围；按原生精度转换和比较 |
| string | 原样 UTF-8，拒绝不完整代理项；单值最多 1024 字节；不截断成功值 |
| 其它 Variant | 可发现其声明类型，但访问返回不支持；不触发 getter 来推测类型 |
| 请求与回执 | 请求最多 4096 字节，回执最多 65536 字节，沿用有界缓冲区 |
| 路径 | 沿用规范绝对路径、2048 UTF-8 字节、128 段 |
| 属性名和批次 | 单名最多 256 UTF-8 字节，read 最多 16 项，names 最多 16 项；拒绝重复名 |
| 发现 | 默认 32、最多 64 项；最多扫描 512 个元数据项、16 层已加载继承链 |
| 等待 | 默认 5000 ms，范围 1–30000 ms |

达到数量、字节或工作量限制时，发现返回 `truncated`、原因和实际处理范围，不能声称已枚举全部。输出按名称排序；首期不提供分页游标。`names` 采用精确名查询并逐名解析已加载继承链，调用方可对已知属性做有界补查。遍历预算在收集前生效，不能先构造无界列表再裁剪。描述符中的自由文本同样计入总预算。

输入类型与读回实际类型都必须校验。已有转换器可能截断整数或接受不匹配的包装 Variant；新访问 helper 既要在转换前验证原始 JS 值的类型、整数性和范围，也要在转换后核对实际 Variant 类型，不能仅以“转换函数成功”判断正确。helper 区分 JS 异常、类型不符与编码失败，既有布尔 get/set 接口保持原行为。沿用既有 Vector2 数字 token 处理，避免中间 JSON 转换改变引擎精度边界。

输出按最终 JSON 字节增量计费，预留回执信封、frame 和失败项空间；不能只合计原始字符串字节。某次 getter 返回值装不下时，该项为 `unavailable/output_budget` 并停止，后续项为 not_attempted，保留已经观察到的项。写入 before 装不下时不进入写路径，返回 not_written；进入写路径后读回无法编码则 unconfirmed。不能因最终超预算把已执行的访问改报为无副作用的 `ok:false`。

## 四 原生访问与脚本生命周期

原生模块负责请求、路径、执行检查点、预算与回执；GodotJS 的 ScriptInstance/Environment helper 负责已绑定导出元数据、继承解析和实际 live Get/Set。helper 不调用可能 lazy-load 的通用 `get_script_property_list`，也不走优先使用 `property_cache_` 的通用 `ScriptInstance::get`。

首期只接纳 owner 线程已绑定且非 shadow 的 GodotJS 实例。访问捕获 Environment 强引用、节点 ObjectID、已绑定脚本/类代次身份和元数据副本。不能跨脚本回调保存裸 Node、ScriptInstance 或属性 map 指针。

内部绑定代次是本期新增机制：在实例重绑、热重载/类元数据更新时推进单调 generation。不能以现有 class_id、Script 资源地址或 ScriptClassInfo 地址替代，因为这些对象可能原位更新或复用。代次只用于本次操作内的核对，不作为公共持久 schema token。

单属性写入按以下顺序执行：

1. 校验完整请求、类型和预算；核对活跃 world、安全检查点、公开路径和实例 ID。
2. 解析当前属性声明、访问路径及脚本绑定，捕获内部身份。所有静态拒绝在访问前完成。
3. 在互操作作用域内 live 读取 before，记录已进入的阶段。
4. 重新取得 world/tree/node/binding；确认仍匹配后才进入 setter。
5. 进入原生 setter 或 JS 属性赋值路径；回调后再次重新解析并核对目标和绑定。
6. live 读回，校验实际类型、范围和编码预算；再核对目标。
7. 与转换到原生精度的请求值比较，形成结果及实际引擎帧计数。

每次进入新的 getter/写入路径前检查单调截止时间，以及当前执行端可见的停止/取消状态。before getter 返回时若已到期或运行已结束，不进入写入路径，保留已完成事实并返回 not_written；写入已进入而读回前不再满足准入条件，则返回 unconfirmed。同步 JS 执行中无法消费新的取消包，因此“检查取消”不代表能抢占该回调。宿主可能已先按超时结算 unconfirmed，迟到的原生结论不改写公开终态。

getter、setter 和原生变换通知都可能改变状态、删节点、换脚本或触发退出。路径、ObjectID 相同仍不足以证明脚本绑定未变。若 before getter 已改变绑定，停止并报告 setter 未进入；setter 进入后目标或绑定改变，则结果未确认。

读取批次先预检全部属性名、声明类型和静态资格，再按输入顺序访问；每项真正进入前及回调后仍需重新核对绑定和当前声明，并检查上述准入条件。getter 异常、目标或绑定变化、到期/取消后停止后续项，保留已观察到的结果和停止原因；未进入项不伪造值。getter 可以改变后续值，因此批次是顺序观察，不是事务快照。实时读取绕开缓存只是观察当前访问结果，不修改项目的缓存策略或保证无副作用。

## 五 结果与取消语义

所有回执保留 `requestId`、完整 `WorkerRunIdentity`、`releaseId`、路径和实例身份。原生帧信息使用实际 process/physics/drawn 计数，跨传输使用十进制字符串。它标记访问操作的原生检查点，不能用宿主时间、sampleSeq 或后续 PNG 的 renderSerial 代替。

| 写入结果 | 事实与后续行为 |
| --- | --- |
| `ok:false, error` | 参数/能力/目标/声明/派发等在访问前被拒绝，且确认尚未进入属性访问 |
| `ok:true, outcome:applied` | 写入路径已进入，读回同一目标与绑定，值等于原生转换后的请求值 |
| `ok:true, outcome:not_applied` | 写入路径已进入并完成读回，实际值与请求不同；返回实际值 |
| `ok:true, outcome:not_written` | before 读取已尝试但写入路径确认未进入；getter 仍可能产生副作用 |
| `ok:true, outcome:unconfirmed` | 属性访问可能/已经进入，但超时、取消、退出、失联、异常或读回失败使阶段或结果不能确认 |

applied/not_applied 返回 `beforeValue`、`observedValue`、用于比较的原生转换值、`writeEntered:true` 和原生 frame。not_written 返回 `writeEntered:false`、`phase:before_read`、失败原因及已知事实。unconfirmed 只保留有依据的 phase、before/frame 和 writeEntered；宿主没有执行端证据时不能猜测阶段。writeEntered 只证明进入原生 setter/JS 赋值路径，不证明用户定义的 setter 函数实际被调用，也不证明值曾发生变化。

访问前错误类别固定为 invalid_input、unsupported、not_found/run_ended、not_ready/busy、node_not_found/node_changed、property_not_found/property_read_only、type_mismatch/out_of_range、dispatch_failed，以及已确认访问前到期/取消的 timeout/cancelled。访问后的原因在业务结果中区分 getter_failed、target_changed、type_mismatch/out_of_range、value_too_large/output_budget、setter_failed、readback_failed，以及 timeout/cancelled/run_ended/transport_lost。错误信息保留来源，不把 JS 异常统一压成输入错误。

before 可能因 getter 异常、类型不符、越界、过大值或目标变化而失败。setter 内部抛错即使看似未完成，也必须按已进入处理；不得用属性桥的 false 结果断言无副作用。不自动读回恢复，更不自动重试；平台可根据 receipt 发出新的显式读取。

读取正常返回 `outcome:completed`，每项为 `value`、`unavailable` 或 `not_attempted`。unavailable 保留原因和 `readEntered`，后续未执行项明确标记。已执行 getter 的失败保留在业务结果内；已发送后超时、取消、运行结束或失联返回 `outcome:unconfirmed`。发现元数据不运行脚本，可使用普通有界查询错误；它仍需按原运行核对身份。

截止时间约束原生准入和宿主等待，不能抢占同步 getter/setter。请求到期、取消或丢回执不证明底层访问结束。非终止脚本可能阻塞整个 Worker；恢复需沿用运行会话的停止、强停和清理事实。平台决定是否强停，属性 API 不为单次超时自动销毁游戏。

写入只作用于该运行，不保证后续帧仍保持该值。before/set/readback 是一次操作中的顺序访问，不是跨属性事务；独立状态查询与 PNG 只按运行身份关联，不承诺同帧或因果关系。

## 六 Worker 协议与发布能力

外层 Dedicated Worker protocol 继续为 2。新增独立消息族 `runtime-property-request/cancel/result`，请求带 `describe/read/write` 种类、单调 `accessSequence`、绑定 runId 的不透明 requestId、截止时间和完整运行信封。新的 reader/writer/host/runner 一起更新，逐层验证 payload。

公开脚本 read/write 与旧 runtime write 共用一个可能执行脚本的操作槽，不能两条队列各执行一项。新 describe 也使用这个槽，首期不为元数据查询增加并发队列。旧无脚本 observation 保留独立槽。安全检查点先处理一项属性访问/旧写入，再重新核对运行，处理旧观察。

沿用旧写入的重放去重、一次结算、消费回执和物理额度管理。逻辑准入槽、物理传输额度与 Worker 内的同步执行分别记账：请求在原 deadline 到期且下行请求包已确认消费后，可以释放宿主逻辑准入，让执行已完成但结果丢失的会话恢复；取消本身不提前释放该槽。尚未消费的请求和取消包继续占各自物理额度，直到对应消费/终态或运行退役。迟到结果只回收原请求占用，不能覆盖新运行或释放其它请求额度。

释放逻辑准入不证明旧 getter 已结束或被回滚。Worker 单线程串行执行；同步访问阻塞时后续包不能被执行，必须在旧调用返回后再消费/检查各自截止时间。执行中没有消费回执时宿主可能仍因物理额度繁忙；无限访问最终依赖运行停止/强停收尾。测试同时覆盖结果丢失后的恢复与不可抢占调用仍未结束，不能用一个 busy 状态混淆两类事实。

新原生导出拟为 `_godotjs_runtime_properties_abi()` 与 `_godotjs_runtime_properties_execute(bytes)`，共用有界输入/输出 buffer 和同步重入防护。运行握手携带 `runtimePropertiesVersion:1`，`get_run().runtimeProperties` 返回 `{supported:boolean|null, ready:boolean, version?, types?, origins?}`。supported 未协商时为 null，旧模板明确 false，声明但实际导出不符时在发布 running 前失败。

新 `runtimeAbi.runtimeProperties:1` 依赖 lifecycle 1、observation 1，不把旧 runtimeWrite 1 作为语义依赖。首期开放范围沿用 Full/debug、单线程 Web 配方、Dedicated Worker/Direct；其它目标明确 unsupported。旧 ABI 导出、旧只读模板和旧写入模板继续接受。

证明链覆盖 `SCsub`、原生构建报告、便携模板、通用 release、Playground descriptor、VerifiedRelease、Worker/host/runner 握手与候选校验。新增证明绑定实际 WASM、完整源码快照及本次属性 helper/Environment/ScriptInstance/类型转换的来源闭包，不能仅复制原观察证明的固定三文件列表。新增能力必须重建原生模板和匹配 SDK/站点；修改声明或刷新前端不能提供该能力。

## 七 Summer 适配范围

适配器 factory 注入窄 backend，独立于 window、Monaco、IndexedDB 和面板。第一个 backend 由 Playground API/recorder/runner 装配；使用相同 dispatcher 做页面回放、受控测试和浏览器验收。尚无第二个真实宿主时，不把整个工作台控制器搬入 engine；未来可将已验证的 backend 合同抽到共享入口。

在唯一 Playground 全局入口增加 `summer_call({op,input})`。请求接纳时同步捕获项目、编辑版本和当前运行；所有异步工作只使用该绑定。针对该 run 解析路径及实例 ID，按描述符转换类型，再调用新原语。运行替换、节点重建和停止只能拒绝或结算原请求，不能在 await 后重新取得 activeRunId 并重定向操作。

| 操作 | 本期支持范围与限制 |
| --- | --- |
| `engine.get_project_context` | 映射平台项目/运行和能力，明确 GodotAI 上下文扩展 |
| `engine.play/stop/is_running` | 主运行、默认受限模式；固定版本、构建、运行身份；不支持的 scene/mode/seed/instance 参数逐项拒绝 |
| `engine.get_runtime_tree` | 映射实际运行树及截断；不能把采样数量当未观察到的总数 |
| `engine.inspect_runtime_node` | 映射受支持属性；读取脚本属性明确可能运行 getter；不声称与原生 Summer properties 编码完全相同 |
| `engine.runtime_set` | 最终支持主运行的指定导出类型与 Node2D.position，经新原语获得 before/after/frame；M1 在旧模板上仅映射旧位置写入并明确 partial；field 分量写入拒绝 |
| `engine.screenshot` | 仅显式 `{target:'game'}`；不能把省略 target 的默认 viewport 当游戏截图 |
| GodotAI 属性发现/批量读 | 明确为扩展，不能编成 Summer 标准 `runtime_get` 操作 |
| game_input、wait_for_event | 现有本地原语保留；本期不映射为 Summer 的输入脚本和事件游标合同 |
| runtime_call、game_probe、game_control | 本期 unsupported；顺序查询与截图不冒充同帧 probe |

首期支持省略 instance 或 `main`；不支持命名并行实例。Summer tree/inspect 没有 instance 参数，不为它们擅自增加标准参数。只有明确定义且可以实现的参数进入支持清单；未知参数在派发前拒绝，不能忽略。

核心传输始终使用 typed value。Summer 输入的标量按发现的声明类型解释；Vector2 只接受严格的 `Vector2(x, y)` 字面量，禁止 eval。目标为 string 时，形似 Vector2 的文本仍是字符串。拒绝非有限数、越界整数、script/owner、对象句柄和不支持类型。

兼容分三层记录：支持的输入子集、实际执行语义、输出/错误的 wire 编码。Summer 4.9.2 公开源码确认 before/after/applied/transport/frame 来自一次原生操作，但 inspect 内部 properties 编码和 transport 枚举尚无已核验的原生 fixture。工具 mock 中的字符串数值不能替代实机合同。因此首期称“Summer 风格操作入口与明确的兼容子集”，保留 GodotAI typed receipt；只有固定版本输入、默认值、输出编码及失败行为都有黄金样例和契约测试时，才逐项标为协议兼容。

applied/not_applied 可投影已确认的比较结果；not_written 与 unconfirmed 保留扩展事实，不压成 `applied:false`。未确认结果可用 facade 的结构化 `outcome_unknown` 表达并附完整 receipt，不能带自动重试建议。原生 transport 事实只描述实际 Dedicated Worker/native 路径，不猜 Summer 枚举。

SDK 业务结果、Summer 操作封装和 MCP content 分层。首期不以安装 MCP server 或外部 Summer 应用为前置；未来 MCP 只包装 dispatcher，截图提供 image content 加说明。精确互操作需要固定 Summer 原生样例/实机核验时，单独记录尚未达到的兼容级别。

## 八 Playground 演示

新增独立轻量样例，不改八个复杂示例，也不替换旧位置写入回归。Schema 4 场景入口的 `main.tscn` 将真实 GodotJS 脚本挂到 Player；用 `@bind()` 和 `@bind.export` 的标准 auto-accessor。导出 `health:int=100`、`move_step:float=64`；另以 bool/string 字段覆盖类型测试。

Player 从 `(64,256)` 开始，显示白色标记。health 控制 HUD 数字和绿色实色血条，`_process` 根据当前值同步。ArrowRight 单次非 echo 按下使 x 增加 move_step；ArrowDown 将位置重置到 `(64,256)`。move_step 的含义是每次输入移动像素数，不称真实连续速度，避免假定按键持续时间、物理帧数或墙钟。

回放由已有面板的样例准备、运行互斥、调用轨迹、超时和 finally 收尾装配，通过 Summer dispatcher 执行受支持操作，通过同一 backend 执行明确的 GodotAI 扩展：

1. check、play、等待指定尝试 running；从真实运行树找到 Player，固定 runId/path/instanceId。
2. 发现属性及类型/来源/访问范围；读取初值并采集 PNG。发现本身不能调用 getter。
3. 经 `engine.runtime_set` 写 health=40；验证原生 before/after/outcome，再独立读回。采集后续 PNG，直到血条从 200 像素变成 80 像素。
4. 用本地 game_input 发送一次 ArrowRight，等待输入边沿回执，再读 position 确认 x=128。
5. 经同一 Summer 入口写 move_step=128。ArrowDown 重置并确认 x=64，再一次 ArrowRight，读回 x=192 并验证标记图像。
6. 按 runId 停止并取得实际 host-report。相同 sourceHash/编辑版本重启，确认 health=100、move_step=64、x=64。
7. 对旧 run 再发写入，确认拒绝且新运行未变化；新运行同样取得正常退出和清理回执。

画面证据用固定实色区域/标记和几何映射判断，文字只作展示，不依赖字体截图。每次状态和 PNG 等待均有界、保留独立采样序号；后续帧已出现不等于 setter 与画面同帧。正常样例用 auto-accessor；异常/删除/换脚本放独立 fixture，不混入正常像素验收。

面板展示公开操作名、实际参数、兼容级别、描述符、typed 值、outcome、原生帧、运行/请求身份和前后图片。candidate、unsupported、未确认分别说明。整个示例不接 LLM，也不要求用户手写代码；模型接入可直接复用已验证的程序入口。

## 九 分工与集成顺序

| 工作包 | 负责范围 | 交接与验收 |
| --- | --- | --- |
| A 合同与适配 | typed DTO、错误/阶段、支持矩阵、dispatcher、backend 接口 | 固定载荷、参数拒绝和结果投影契约测试 |
| B 原生与脚本桥 | 静态导出发现、live Get/Set、继承/绑定核对、类型与回执 | C++ 测试和真实装饰器 TS 脚本验证 |
| C Worker SDK | 新消息族、槽位、版本握手、取消/截止/去重/额度、公共 runner | 受控时钟、重放、失联和替换竞态回归 |
| D 发布证明 | 构建导出、来源闭包、WASM/报告/便携模板及两条发布链 | 正常证明保留、篡改拒绝、新旧候选校验 |
| E Playground | 新样例、统一入口、回放和结果显示、浏览器专项 | 受控面板与公开 API 测试，真引擎脚本 |
| F 环境与验收 | 认证工具链、旧模板恢复、新模板构建和两套站点 | 匹配候选、JSON/PNG、身份和退出证据 |

G0 冻结本提案的输入、结果、访问副作用和兼容边界；A 产出确切结果 DTO、phase/reason/错误码枚举和覆盖全部分支的请求/回执样例，供 A/C/B 共享。随后 B/C/D/E 可按职责并行，F 同时准备工具链和旧模板。共享文件由相应包负责集成，先合小接口再接各层实现。

里程碑 M1 交付 dispatcher 和既有位置写入回放；旧 write-1 模板仍调用旧 API，返回标明 GodotAI 扩展的旧 typed receipt，缺失的 before/native frame 保持缺失，不能用独立预读或宿主时间补齐。M1 明确部分兼容，不宣称新脚本属性已具备。M2 交付 B/C 与 headless/受控集成；M3 由 B/D/F 形成新认证模板，用同批 SDK 完整构建新旧站点，并在新站点把适配器升级到新属性原语；M4 通过新脚本属性与旧能力兼容两类真实专项。只有 M4 才完成本期功能演示交付。严格 Summer wire 互操作另按黄金样例达到的范围升级，不与 M4 混称。

本期不承诺固定工期：适配器是小范围 TS 工作；公开脚本属性涉及原生脚本执行语义和新 WASM，主要成本在 B/C/D/F。若新模板准备阻塞，可单独交付 M1 和受控结果；不能据此关闭本期 M4。

## 十 验收矩阵与执行入口

| 层次 | 必须覆盖的事实 |
| --- | --- |
| 属性发现 | 真实 export、继承/覆盖、未导出字段不出现、只读资格、未知访问模式；不执行 getter、不触发默认值构造或加载 |
| 实时值 | 缓存属性绕过缓存；int/float/bool/string/Vector2；Unicode/类似 literal 字符串；严格实际类型、边界与过大值 |
| 写入执行 | 正常 applied、clamp 得到 not_applied、before getter 失败得 not_written、setter 改值后抛错得 unconfirmed |
| 目标生命周期 | getter/setter 中 queue_free、同路径新节点、同节点换脚本、退出与重入；不读失效指针、不写新目标 |
| 读取执行 | getter 执行次数、异常后后续 not_attempted、getter 改变后续属性；读取超时也可有副作用 |
| Worker | 进入前后 deadline、取消迟到、逻辑/物理额度、重放仅执行一次、结果丢失、旧运行回执、槽位恢复 |
| 发布 | 缺依赖/导出、版本错、来源闭包/WASM/目标不符均拒绝；声明能力失配在 running 前失败 |
| 新旧兼容 | 旧只读模板的发布/握手/API 行为做受控回归；旧 write-1 与新模板做真实站点专项；旧模板新属性能力 unsupported，新模板旧 API 原样工作 |
| 真浏览器 | 真实装饰器 TS、原生回执、独立读取、输入效果、PNG、相同源码重启、两次干净退出 |
| Summer facade | 参数/default 子集、未知参数、类型转换、会话绑定、无假 before/frame/transport、未确认不自动重试 |

先执行受影响包的类型检查、测试及原生脚本夹具，再执行受控面板。选择性新增测试应验证新行为与执行边界，避免复制实现。参考[本地验证策略](../../CONTRIBUTING.md#local-verification)和[既有写入方案](playground-runtime-set-p0.zh-CN.md)。

```sh
pnpm test:engine
pnpm --filter @godot-js/playground typecheck
node --test apps/playground/scripts/playground-api.test.mjs \
  apps/playground/scripts/debug-api.test.mjs
node apps/playground/scripts/browser-debug-panel-test.mjs

# 新模块的测试文件及发布定向测试随实现加入对应包的 test 命令。
# 本机原生构建使用环境既有 QJS 配方、先运行 prepare-native-engine，保留 tests=yes。
/absolute/godotjs-editor --headless --test --test-case='*runtime propert*'
```

原生过滤必须实际执行非零用例；另需真实 decorated TypeScript 经编译、加载并形成 ScriptInstance 的验证，不能仅用 C++ 假属性代替。运行时矩阵沿用仓库脚本与当前环境的布局要求，不照抄缺少 custom_modules 等设置的通用 SCons 命令。

真实验收复用 `browser-debug-api-test.mjs`，拟新增以下 case：

```sh
PLAYGROUND_TEST_DIRECTORY=/absolute/site-new \
PLAYGROUND_DEBUG_API_CASE=runtime-script-properties \
PLAYGROUND_DEBUG_API_REPORT=/absolute/results/script-properties.json \
node apps/playground/scripts/browser-debug-api-test.mjs

PLAYGROUND_TEST_DIRECTORY=/absolute/site-old \
PLAYGROUND_DEBUG_API_CASE=runtime-script-properties-unsupported \
PLAYGROUND_DEBUG_API_REPORT=/absolute/results/script-properties-legacy.json \
node apps/playground/scripts/browser-debug-api-test.mjs
```

报告区分受控替身 `engineExecuted:false` 和真实执行 `engineExecuted:true`。真实报告保存 releaseId/candidateId/ABI、源版本/sourceHash、完整 run/request/节点身份、原生 receipt、独立值观察、PNG 与哈希、输入边沿、重启前后两份 host-report，以及原生退出码 0 和 hostCleanup complete。兼容矩阵说明样例是本地 SDK/facade 验收还是 Summer 实机互操作，不能混用。

## 十一 候选与环境准备

当前工作区保留本机 headless QJS 工具链和依赖，没有现成匹配的 Playground dist/Web 候选。真实验收需要固定 Emscripten 4.0.11、Godot 4.6.1 Git 源码 `14d19694e0c88a3f9e82d899a0400f27a24c176e`、新代码重建的测试编辑器和有 glTF 支持的固定导入器。现有解压源码缺少可认证 Git HEAD；它可用于已有本机配置，不自动满足 Web 源码认证。

优先恢复 [PR22](https://github.com/linfaxin/GodotAI/pull/22) 使用的便携模板/认证报告，或找到等价认证材料；恢复后先逐文件验证，不能假定历史链接仍可用。旧 write-1 模板用于新 SDK 下的兼容站点，新脚本属性站点必须使用新编译的 WASM。若找不到可恢复材料，单列旧基线重建任务。

```sh
node scripts/test/package-browser-engine-artifact.mjs \
  --out /absolute/old-portable --verify

GODOT_SOURCE=/absolute/git-godot-4.6.1 \
ENGINE_PROFILE=full-engine-v1 ENGINE_TARGET=template_debug \
ENGINE_EXECUTION_MODEL=window \
bash apps/playground/scripts/build-web-engine.sh

GODOT=/absolute/godotjs-editor GODOT_IMPORTER=/absolute/godot-importer \
node apps/playground/scripts/build.mjs \
  --engine-report /absolute/new/engine-report.json --out /absolute/site-new

GODOT=/absolute/godotjs-editor GODOT_IMPORTER=/absolute/godot-importer \
node apps/playground/scripts/build.mjs \
  --engine-report /absolute/old-portable/engine-report.json --out /absolute/site-old
```

便携包包含实际 ZIP、原始及便携报告、日志和 artifact.json；搬迁校验、冻结 SDK 和站点封印沿用现有发布链。前端刷新只适用于原生和 SDK 均匹配的既有发布；本期变更 SDK/原生后完整重建。M4 的真实门禁固定为新能力站点与旧 write-1 站点两套；旧只读配置在本期要求受控发布/握手/API 回归，不新增第三套真实站点，也不把受控结果称为其真实引擎验收。若后续扩大模板发布范围，再补对应真实候选。

## 十二 后续演进与参考

下一阶段优先同步 `runtime_call`，复用本期类型、身份、执行槽和阶段回执，但分别定义方法发现、抛错、目标自删除、返回值无法编码及异步返回的合同。之后按接入需求扩展 Node3D/Vector3、更多内置 setter、完整 int64 和其它脚本语言。

同检查点/同帧 probe 与 pause/step 分别设计。probe 可从现有渲染/iteration hooks 研究，不以暂停为必然前置。`SceneTree.paused` 不代表 JS timers、always 节点、异步回调和用户 Worker 都被冻结；精确单步必须定义这些调度边界后再承诺。

Summer 核验以固定版本为准，避免当前文档生成基线和 npm 最新包漂移：

- [引擎操作参考](https://docs.summerengine.com/mcp/operations/engine)
- [固定版本操作定义](https://github.com/SummerEngine/summer/blob/5d0bc70c6228a2f718485913449f20482434b47b/src/core/ops/engine.ts)
- [固定版本运行时参数](https://github.com/SummerEngine/summer/blob/5d0bc70c6228a2f718485913449f20482434b47b/src/core/capabilities/runtime-control.ts)
- [固定版本运行时工具](https://github.com/SummerEngine/summer/blob/5d0bc70c6228a2f718485913449f20482434b47b/src/mcp/tools/runtime-tools.ts)
- [固定版本感知工具](https://github.com/SummerEngine/summer/blob/5d0bc70c6228a2f718485913449f20482434b47b/src/mcp/tools/perception-tools.ts)

本期完成的判据是公开属性访问和兼容子集入口真实改变并验证游戏状态，保留实际执行事实，能在相同项目重启后恢复默认值；不能用受控面板成功、方法数量或兼容命名代替这一结果。
