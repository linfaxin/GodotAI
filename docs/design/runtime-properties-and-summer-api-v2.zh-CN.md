# 运行时公开脚本属性与 Summer API 实施方案 V2

状态：V2 范围已完成，M1–M4 均通过。方案日期：2026 年 11 月 21 日；实施日期：2026 年 11 月 22 日。基线：GodotAI `8583001d5d2966c8ba78e9409d3e7d9c0bad66b4`；Summer 参照：`summer-engine@4.9.2`、提交 `5d0bc70c6228a2f718485913449f20482434b47b`。

本期交付标准 GodotJS 导出标量属性的发现、实时读取和单属性写入，在 Playground 通过 Summer 风格操作入口修改血量、调整单次移动距离，再用独立读取、输入和 PNG 验证效果。项目源码不因运行态修改而改变，重启恢复初值。长期边界遵循[引擎目标](../engine-goals.zh-CN.md)和[仓库架构](../architecture.md)。

本方案取代[V1](runtime-properties-and-summer-api.zh-CN.md)，将原先留给 G0 的输入、结果、序号、预算、适配路由和验收决定写入正文。以下名称和类型作为实现合同保留；交付状态与实际证据见文末实施记录。

V2 运行时属性阶段已完成 A–F。新旧 full/debug 模板、同批冻结 SDK 的两个完整站点、来源证明及七项真实浏览器专项均已验收通过，交付证据见第十五节。后续增加的 `engine.game_probe` 的用法、支持条件和验收命令见[第十六节](#十六-enginegame_probe-同帧采样)。

## 一 评审决定与本期范围

| V1 评审发现 | V2 的确定决定 |
| --- | --- |
| 结果 DTO、批读拒绝和未知执行阶段没有定全 | 第二至四节冻结输入、描述符、结果、错误和证据；不再由各层自行解释 |
| 新旧请求各自计数会撞 ID 或吞重放 | 同一 session 共用序号分配、host 准入门及 host/Worker 去重水位 |
| 原生拿不到分阶段 deadline | 新导出接收剩余微秒预算；宿主等待期限与原生单调预算分别约束 |
| 最终回执预算没有传到原生 | 65536 限制最终公开 JSON；Worker 预留完整信封后传 outputBudgetBytes |
| 现有属性桥可能截断整数、接受错误 wrapper | 标量走新严格 helper；不调用旧宽松转换器 |
| 脚本 Vector2 涉及 Proxy/包装品牌和递归解包 | 首期仅开放原生 Node2D.position 的 Vector2；脚本 Vector2 明确 unsupported |
| Web 字符串长度和 NUL 不可靠 | 新严格字符串路径保留显式长度、校验代理项与 UTF-8，不使用 NUL 终止解码 |
| class_id、地址和旧属性表不足以识别热重载 | 新增实例 token、运行时绑定代次、类元数据 revision/ready、静态 own exports |
| 原生互操作作用域不是节点/VM pin | 每次回调独立作用域，退出后重取目标；不跨回调保留 scoped pointer |
| Summer inspect 无属性选择，自动读脚本 getter 会扩大副作用 | 始终使用旧原生观察读取三项；脚本读取通过显式新原语 |
| play、stop 与 pending attempt 缺少明确合同 | play 明确采用本地冻结编辑版本语义；stop 捕获并取消指定待启动意图 |
| 历史模板是否可恢复不确定 | 恢复优先；失败则从本地已有的完整 PR22 SHA 重建旧模板 |

首期支持公开 SceneTree 中已经绑定、owner 线程上的非 shadow GodotJS 导出属性：bool、JS 安全整数、有限 float、受限 string。普通 TS 字段、闭包和 React hook 状态不自动暴露；不引入游戏专用 registerState。发现来自标准导出元数据，Agent 可用自己的文件工具为项目增加标准导出。

保留现有 observation 1 和 runtimeWrite 1 的语义、导出和结果编码。旧观察只读 position/rotation/visible，旧写入只改 Node2D.position；新属性接口是独立增量。首期不增加 rotation/visible setter。

不纳入本期：脚本 Vector2/其它数学包装、Object/Resource/RID/容器、完整 int64、GDScript/GDExtension、动态属性协议、任意 eval、方法调用、同帧 probe、暂停单步、自动重试/回滚、文件 CRUD、模型和素材/云发布服务。下一阶段优先同步 runtime_call，复用本期类型、身份和执行事实。

## 二 输入、类型与描述合同

以下类型中 `WorkerRunIdentity` 直接复用[现有七字段合同](../../packages/engine/src/browser/dedicated/worker-protocol.ts)：runId、revision、buildKey、generation、documentId、workerId、runConfigurationHash。不得用自创 sessionId 代替其中字段。

```ts
type RuntimeType = 'bool' | 'int' | 'float' | 'string' | 'vector2';
type RuntimeValue =
  | {type: 'bool'; value: boolean}
  | {type: 'int'; value: number}
  | {type: 'float'; value: number}
  | {type: 'string'; value: string}
  | {type: 'vector2'; value: {x: number; y: number}};

type Target = {
  runId: string;
  path: string;
  expectedInstanceId: string;
  timeoutMs?: number;
};
type DescribeInput = Target & (
  | {names?: never; limit?: number}
  | {names: readonly string[]; limit?: never}
);
type ReadInput = Target & {
  properties: readonly {name: string; expectedType: RuntimeType}[];
};
type WriteInput = Target & {property: string; value: RuntimeValue};
```

SDK 方法为 `describeRuntimeProperties/readRuntimeProperties/writeRuntimeProperty`；Playground 增加 `describe_runtime_properties/read_runtime_properties/write_runtime_property`，均接收对应 input 和可选 AbortSignal。写入 value.type 是声明类型前置条件，读取显式提供 expectedType。描述结果是当前观察，不是永久授权；首期不要求公共 schema token，也不保证阻止两次调用间的同类型脚本替换。

所有公共请求只接受本合同字段、有界普通数据对象与数组；拒绝 accessor 字段、symbol、重复属性名和未知键，不在校验时主动读输入 getter。保留现有跨 realm 普通对象/AbortSignal 的处理原则。JS Proxy 没有通用无副作用检测方式；外部请求首选经过结构化传输得到的纯数据，不能承诺对任意恶意对象做验证时绝不触发 trap。

```ts
type AccessMode =
  | {status: 'supported' | 'candidate'}
  | {status: 'unsupported'; reason:
      'unsupported_type' | 'unsupported_export_type' | 'read_only'
      | 'no_native_getter' | 'no_native_setter'};
type Descriptor = {
  name: string;
  declaredType: {variantType: number; name: string};
  type: RuntimeType | null;
  origin: 'native' | 'godotjs_export';
  readAccess: AccessMode;
  writeAccess: AccessMode;
  readMayExecuteScript: boolean;
  writeMayExecuteScript: boolean;
  shadowedExport: boolean;
};
type ScanReason = 'item_limit' | 'metadata_limit'
  | 'inheritance_limit' | 'output_budget';
type Scan = {
  metadataEntriesVisited: number;
  inheritanceLevelsVisited: number;
  truncated: boolean;
  reasons: ScanReason[];
};
type NamedDescriptor =
  | {name: string; status: 'found'; descriptor: Descriptor}
  | {name: string; status: 'absent'}
  | {name: string; status: 'unresolved'; reason:
      'metadata_limit' | 'inheritance_limit' | 'output_budget'};
type Frame = {process: string; physics: string; drawn: string};
type DescribeResult = {frame: Frame; scan: Scan} & (
  | {mode: 'enumerate'; properties: Descriptor[]}
  | {mode: 'names'; properties: NamedDescriptor[]}
);
```

访问模式不通过读取 JS descriptor、getter 或默认值推断。脚本导出通常为 candidate；明确只读 usage 拒写；candidate 只表示可尝试。首期 script-export Vector2 的 type 可为 vector2，但双方 access 均为 unsupported_export_type，读取/写入在 getter 前拒绝。内置读取表固定为 Node2D.position/rotation、CanvasItem.visible，写入表仅 Node2D.position；这些原生分支不要求挂 GodotJS 脚本。

内置名称优先，重名脚本导出不成为第二条同名路径，内置描述符设置 shadowedExport。原生 position setter 可能通过通知执行脚本，writeMayExecuteScript 必须为 true；不能从 native 来源推断无副作用。

发现只读已经加载的静态 own exports 及基类链接，不执行脚本、不 lazy-load。已确认的原生基类是继承链终点，与缺失脚本模块不同。所需类/脚本基类链未加载或未 ready 时，访问前返回 not_ready，不能当成 absent/property_not_found；预算不足则按 unresolved 处理。子类真实 own 声明优先。枚举结果按名称排序；到预算即停止，排序仅作用于已收集项，不声称全局前缀或稳定分页。names 模式逐名精确查找，输出仍按名称排序；只有检查完该名称的全部已加载继承链才可 absent，预算未覆盖必须 unresolved。首期无游标。

## 三 结果、错误与执行证据

```ts
type AccessErrorCode =
  | 'invalid_input' | 'unsupported' | 'not_found' | 'run_ended'
  | 'not_ready' | 'busy' | 'node_not_found' | 'node_changed'
  | 'property_not_found' | 'property_read_only'
  | 'type_mismatch' | 'out_of_range' | 'dispatch_failed'
  | 'timeout' | 'cancelled';
type AccessReason =
  | 'getter_failed' | 'target_changed' | 'type_mismatch' | 'out_of_range'
  | 'value_too_large' | 'output_budget' | 'encoding_failed'
  | 'setter_failed' | 'readback_failed'
  | 'timeout' | 'cancelled' | 'run_ended' | 'transport_lost';
type AccessError = {
  code: AccessErrorCode;
  message: string;
  source: 'sdk' | 'host' | 'worker' | 'native' | 'godotjs';
  property?: string;
  index?: number;
};
type Correlation = {
  requestId: string;
  accessSequence: number;
  run: WorkerRunIdentity;
  releaseId: string;
  path: string;
  expectedInstanceId: string;
};
type PublicResult<T> =
  | {ok: true; receipt: Correlation; result: T}
  | {ok: false; receipt?: Correlation; error: AccessError};
```

receipt 只可在输入/能力/运行准入尚未成功时缺失；分配请求并绑定运行之后的任何结果均保留 correlation。`ok:false` 表示确认未进入属性访问；它不要求错误前已经创建合法运行身份。错误消息最多 512 UTF-8 字节，可截断诊断文本，不能截断成功业务值。

```ts
type WriteEvidence =
  | {phase: 'unknown'; writeEntered: 'unknown'}
  | {phase: 'before_read'; writeEntered: false;
      frame: Frame; beforeValue?: RuntimeValue}
  | {phase: 'write' | 'readback'; writeEntered: true;
      frame: Frame; beforeValue: RuntimeValue};
type WriteResult = {property: string; requestedValue: RuntimeValue} & (
  | {outcome: 'applied' | 'not_applied'; phase: 'readback';
      writeEntered: true; frame: Frame; beforeValue: RuntimeValue;
      comparisonValue: RuntimeValue; observedValue: RuntimeValue}
  | {outcome: 'not_written'; phase: 'before_read'; writeEntered: false;
      reason: AccessReason; frame: Frame; beforeValue?: RuntimeValue}
  | {outcome: 'unconfirmed'; reason: AccessReason; evidence: WriteEvidence}
);

type ReadItem =
  | {name: string; expectedType: RuntimeType; status: 'value';
      readEntered: true; value: RuntimeValue}
  | {name: string; expectedType: RuntimeType; status: 'unavailable';
      readEntered: boolean; reason: AccessReason}
  | {name: string; expectedType: RuntimeType; status: 'not_attempted';
      readEntered: false};
type ReadResult =
  | {outcome: 'completed'; frame: Frame; properties: ReadItem[];
      stopReason?: AccessReason}
  | {outcome: 'unconfirmed'; reason:
      'timeout' | 'cancelled' | 'run_ended' | 'transport_lost';
      evidence: {phase: 'unknown'}
        | {phase: 'read'; frame: Frame; properties: ReadItem[]}};
```

phase 固定表示最后已经进入的访问阶段。writeEntered/readEntered 证明进入赋值/Get 路径，不证明用户自定义 setter/getter 函数实际执行。unknown 是显式未知证据，不能换成 false、空 frame 或虚构 not_attempted 项。

| 发生位置 | 公开结算 |
| --- | --- |
| 任一输入、声明、资格或派发在访问前被拒绝 | ok:false；批读整批拒绝，零 getter |
| before Get 已进入，异常、值不可编码或目标变化 | not_written；writeEntered:false；可能已有 getter 副作用 |
| before 完成但新阶段前到期/取消/退出 | not_written，保留 before 和实际 frame |
| 赋值入口返回异常、Maybe 无值或明确 false | unconfirmed/setter_failed，不自动读回；不能用旧 IsJust() 当成功 |
| 写路径正常接受，读回同一绑定且等于原生比较值 | applied；不承诺发生过值变化或后续保持 |
| 写路径正常接受，读回有效但与比较值不同 | not_applied，保留实际值 |
| 写路径进入后目标变化、阶段到期或读回失败 | unconfirmed，保留执行端已知阶段 |
| 已发送，宿主先到期/取消/停止/失联，执行阶段未知 | unconfirmed + unknown evidence，不自动重试 |

批读预检全部名称、声明类型和静态资格，任一项不符则整批 ok:false。尚无 read 进入时确认到期/取消/退出，同样为访问前错误；已有 read 进入后到期/取消/退出/失联则 unconfirmed，携带已知 evidence。getter、类型、越界、编码/输出预算失败则 completed+stopReason：该项 unavailable，停止后续访问并将剩余项标 not_attempted，成功前项保留。每项开始前及回调后重新检查身份/声明/阶段准入。getter 可以改后续值，批次不是原子快照。`completed` 表示执行端已经结算该批次，不表示所有属性成功。

发现不执行脚本，超时/取消可按有界查询错误返回。显式脚本读取与写入都可能产生副作用，不因 operation 标注 read 就自动重试。宿主未知结果时不主动补读；平台依据 receipt 发起新的读取决定。

Frame 取本次原生操作末尾/最后可取得的实际 process、physics、drawn 计数，uint64 用十进制字符串。before/set/readback 是一次操作中的顺序访问，不是事务隔离；frame 不代表与独立 PNG 同帧，更不能用宿主时钟或 renderSerial 补造。

## 四 数值、字符串与输出预算

| 项目 | 冻结规则 |
| --- | --- |
| bool | 只收原始 boolean，不做 truthy 转换 |
| int | 只收原始 number、整数且 Number.isSafeInteger；读到超界/小数为 unavailable |
| float | 原始有限 number，构造 Variant double；不错误限制为 real_t |
| 原生 vector2 | 精确 x/y 普通数据字段，有限且在 real_t 范围；按原生精度得到 comparisonValue |
| string | 原始 string，完整代理项配对、严格 UTF-8；成功值最多 1024 UTF-8 字节，支持嵌入 U+0000 |
| native 请求 | 包含内部控制字段后最多 4096 字节 |
| 最终 PublicResult | UTF-8 JSON 最多 65536 字节，包含完整 correlation/error，不是仅 native body |
| 路径/属性名 | 路径沿用 2048 UTF-8 字节和 128 段；属性名非空、最多 256 UTF-8 字节、无 NUL/孤立代理项 |
| 批读/names | 各 1–16 个唯一名称；names 与 limit 互斥 |
| 发现枚举 | 默认 32、上限 64 项；整次请求最多 512 元数据项、16 层继承；不逐名重置扫描额度 |
| timeoutMs | 默认 5000，整数 1–30000 |

新标量 helper 在转换前直接判断 JS 原始类型，读取 number 后在 C++ 校验有限/整数/范围，显式构造准确 Variant；不走会截断或递归解包的旧 js_to_gd_var/can_convert_strict。Web 不调用可被项目替换的全局 Number/Boolean/String 转换函数。

字符串先检查 UTF-16 code-unit 数不超过 1024，再检查代理项配对、计算 UTF-8 长度并按显式长度复制；该预检与最终 1024 字节限制相容。QJS 同样按显式长度和严格编码返回。Web 写入不得使用遇 NUL 停止的 UTF8ToString，包括只增加 maxBytes 参数的版本；使用预先捕获的 fatal UTF-8 decoder 对精确字节区间解码或等价实现。新桥接输入的 JSON unicode escape 也先验证，避免解析器静默规范化非法代理项。测试必须包括 `a\u0000b`、中文、emoji、控制字符及类似 Vector2 字面的字符串。

Worker 根据实际 correlation 与固定结果包装计算最终序列化预留量，将内部 outputBudgetBytes 传给 native；native 请求的 4096 上限包含这个字段。native 增量按实际 JSON 字节计费，并为 frame、停止原因和所有剩余状态项预留空间。不能只合计原始字符串字节，因为转义会膨胀。

预算无法容纳当前读值时返回 unavailable/output_budget 并停止；before 无法编码为 not_written；写入后读回不能编码为 unconfirmed。全部路径保留已有执行事实，不在 getter 已运行后改报 preaccess error。Worker/runner 对畸形或超预算执行回执不能声称未执行，应丢弃不可信内容并按阶段未知结算；若公开包装预留不足在调用前就失败。

原生请求解码明确区分控制整数和 typed 值：outputBudgetBytes、kind 等不能被沿用的数字 token 替换逻辑误读成 token 下标。旧 position 解码器保持不变；新入口独立解析并复用已经验证的有限数字精度处理。

## 五 原生访问和绑定生命周期

新增 `bridge/jsb_runtime_properties.cpp/.h` 负责新入口、准入、类型、路径、预算和原生回执；ScriptInstance/Environment 提供窄内部 helper。旧 cpp 匿名 namespace 内的 active_scene_error/find_node 不能跨文件直接调用，B 将公共只读 guard/path 部分抽到 `bridge/jsb_runtime_access_common.cpp/.h`，供两条路径使用；旧准入行为保持，新退出标记检查仅由新能力要求，D 将抽取文件纳入来源闭包。发现不调用可能 ensure_module_loaded 的 get_script_property_list/get_base_script/is_valid，也不求默认值。live Get 绕过 property_cache_，不改变通用 ScriptInstance 缓存行为。

| 身份/元数据 | 新增或复用的具体位置 |
| --- | --- |
| 现有 wrapper 绑定 | 复用 ObjectBindingTicket 的 env epoch、active/generation；不修改其 generation 语义或 binding_records 键 |
| script-instance token | GodotJSScript::instance_create 和 instance_construct 两条实际分配路径都分配单调 token，覆盖普通对象挂脚本与同节点换脚本 |
| runtime binding 记录 | 初次成功绑定及 Environment::_rebind 保存 generation、实际 bound_class_id、ready；rebind 开始即失效/推进，成功发布，失败 ready=false |
| class 元数据 | ScriptClassInfo::_parse_script_class 首次原位修改前推进 revision 并 ready=false，成功后发布新 revision 的只读 own_runtime_exports 和已加载基类链接 |
| 真正 own exports | 只从类自身导出 symbol 获取；不把继承复制的旧 properties 当成自己的声明；旧 properties 行为保持 |
| 操作身份 | node ObjectID、wrapper ticket、实例 token、runtime binding 代次、实际 bound_class_id，以及已访问继承链各 class revision/ready |

不能只用 class_id_、Script/ScriptClassInfo 地址检测变化；旧 rebind 可能只改原型且实例 class_id_ 仍旧，资源也会原位更新。运行时记录只服务本能力，不顺便重写旧 dispatch 语义。所有单调计数不得回绕复用。

helper 先复制最小元数据、Environment 强引用和身份快照，释放 ScriptClassInfoPtr/ObjectHandlePtr 等带 SArray/DB scope 的指针/锁，再进入 JS。每次 callback 单独进入 NativeInteropScope，回调结束退出作用域后才调用 active_scene_error 并重新取得 world/tree/node/binding。把整次操作包在一个作用域里会使后验准入检查错误失败；该作用域也不是 Node、VM 的 pin，不能阻止 free/queue_free/set_script。

GodotJS 导出路径每次访问前后检查公开路径、完整 ObjectID、wrapper/实例/绑定和继承 revision；换脚本、重载失败、节点离树/排队释放时停止。原生属性路径只要求 world/tree/path/ObjectID及生命周期有效，不要求 GodotJS 实例或 wrapper ticket；它可能触发其它脚本语言的通知，不代表开放这些语言的导出属性访问。不跨回调保存裸 Node/ScriptInstance 或属性 map 指针，不对新绑定继续用旧元数据。

SceneTree.quit 可能只设置内部退出标记，world 尚未 closing。B 增加固定 Godot 4.6.1 源码补丁：仅 C++ 可用的 const `SceneTree::godotjs_is_quit_requested()`，不绑定到脚本；新 helper 在准入和每次回调后检查。D 将补丁、实际输出及源码链加入 native/Web 准备和证明；不通过 getter 提前运行 cleanup。

单属性操作顺序固定为：静态预检 → before Get → 重取并核对身份/退出/期限 → 写路径 → 重取核对 → readback Get → 再核对 → 类型/精度比较和 frame。赋值返回 Maybe false 与异常都是明确写路径失败，不依赖旧 `IsJust()` 逻辑，也不自动读回恢复。

## 六 原生预算、消息与共享操作槽

新增两个导出，保留全部旧导出：

```ts
declare function _godotjs_runtime_properties_abi(): 1;
declare function _godotjs_runtime_properties_execute(
  inputBytes: number,
  remainingBudgetMicros: number, // uint32, 1..30_000_000
): number; // 返回共享 buffer 中 JSON 回执字节数
```

Worker 先完成编码和 buffer 拷贝，最后按 interactionNow 检查原绝对 deadline，计算 floor((deadline-now)*1000)；非正不进入 WASM。native 入口以 OS 单调 ticks 加剩余微秒建立本地 deadline，每次进入新的 Get/写路径/readback 前检查期限及本地可见停止状态。headless helper 的执行 context 可注入时钟。

公共 waiter 按原绝对截止一次结算；native 是交接剩余额度的执行端约束，不承诺零交接开销或跨 realm 时钟完全相同。同步 JS 不可被请求超时抢占，也不能在阻塞期间消费后来取消包；宿主超时不证明原生停止。before 后已到期则不写；write 后不满足 readback 准入则 unconfirmed；迟到事实不覆盖先前终态。

外层 Worker protocol 保持 2。新消息为 runtime-property-request/cancel/result，信封沿用完整七字段身份。request 带 requestId、accessSequence、deadline、command，取消仅引用原 ID。判别字段和 native 结果固定为：

```ts
type WithoutRun<T> = T extends unknown ? Omit<T, 'runId' | 'timeoutMs'> : never;
type PropertyCommand =
  | ({kind: 'describe'} & WithoutRun<DescribeInput>)
  | ({kind: 'read'} & WithoutRun<ReadInput>)
  | ({kind: 'write'} & WithoutRun<WriteInput>);
type NativeResult<T> =
  | {ok: true; result: T}
  | {ok: false; error: AccessError};
type NativePropertyRequest = PropertyCommand & {outputBudgetBytes: number};
```

result 消息回显 kind，分别对应 NativeResult<DescribeResult/ReadResult/WriteResult>；先匹配原请求的 kind/身份再解析该 union。native 不产生 correlation，由 Worker/runner 使用接纳时的上下文补充。新 result reader 与旧 runtime-write reader分开，旧结果仍严格保持原来的字段数和 outcome。

每个 session 只有一个 nextAccessSequence。旧 write 使用 writeSequence=s，新属性使用 accessSequence=s，requestId 均为 runId+冒号+s。host 和 Worker 归一化成 family/sequence/requestId 后，共享一个最高序号和一个 pending 操作槽。跨消息族复用序号或重放不执行；终态必须匹配 family、sequence、ID 和完整运行。不能仅在两套独立 relay 前检查 busy。

host relay 是权威准入门：原请求终态，或原 deadline 到期且 request 消费已确认后释放逻辑占用；取消本身不提前释放。runner waiter 可先结算，但下一请求仍需经过该门。describe 也占共享槽；旧 observation 保留独立槽，检查点先处理一项共享访问，再重检运行并做旧观察。

requestDelivery 和 cancelDelivery 分别保存 owner ID/dataSequence。匹配终态可证明原 request 消费，不能证明取消包已消费；取消额度只由其自身 data receipt 或运行退役回收。迟到包不能释放其它请求额度。释放宿主逻辑准入不证明同步访问已结束；后续包只能等该 Worker 调用返回再执行并重新检查各自期限。无限脚本依赖会话停止/强停与清理事实收尾，属性超时不自动销毁游戏。

## 七 Summer 子集与启动停止合同

新增应用内 `createSummerDispatcher(backend)` 和独立白名单/转换测试；factory 不依赖 window、Monaco、IDB 或面板。唯一全局入口增加 summer_call；页面、回放、测试都经该 factory，无第二份 switch。本期沿用 schemaVersion:1 作为方法增量，真实浏览器精确方法集合从现有 16 个键增加到 20 个键，旧键全部保留。

顶层只接收 op/input；input 必须是普通数据对象，可省略时按空对象。已知 Summer 参数但不支持返回 unsupported 并给 parameter；未知键为 invalid_input 并列 unknownKeys；字段类型、必需字段或格式错误为 invalid_input 并给 parameter，depth/limit 必须为整数。合法但不支持的枚举为 unsupported。op 缺失/类型或格式错误为 invalid_input；格式有效但未列入支持清单则 unsupported，零 backend 调用。所有拒绝先于启动、路径解析、发现和 getter。以下是本地子集，不声称 Summer 只有这些参数。

| 操作 | 实际接受的 input/default | 明确拒绝或语义差异 |
| --- | --- | --- |
| engine.get_project_context | 空对象 | include、settingsPrefix/settingsPrefixes 不支持；payload 为 GodotAI context |
| engine.play | 仅 instance 可省略或 main | scene、mode、focus、deterministic、seed、fixed_fps、time_scale、speed、players、spectators、queue 均不支持，包括看似默认值；执行采用下述本地语义 |
| engine.stop | instance 可省略或 main | 非主实例拒绝；同时捕获待启动意图与主 run |
| engine.is_running | 空对象 | instance 是未知参数；仅真实 state=running 时 playing=true，pending 为 false |
| engine.get_runtime_tree | path 可省略；depth 默认3、范围1–8；limit 默认500、范围1–500 | 显式传默认值，不复用本地2/200；maxCharacters 已知但不支持；不伪造 total_nodes |
| engine.inspect_runtime_node | 必需 path | maxCharacters 已知但不支持；固定旧 observation 三属性，不自动读导出 getter；无 instance/properties 参数 |
| engine.runtime_set | path/property/value 必需，value 为 JSON string/number/boolean；instance 省略或 main | field 只要出现即拒绝；script/owner、非主实例及未支持类型拒绝 |
| engine.screenshot | 必需显式 target=game | 省略 target 不当作 game；其它 target 及全部 scene/camera/marks/size/compare 参数拒绝；无 instance |

tree/inspect 的固定资源 schema 声明 maxCharacters，而 MCP handler 不声明；V2 把它当已知但不支持参数，不推断 Summer 各传输对未知参数的行为一致。截图返回实际 PNG bytes/尺寸/身份，面板的 byteLength 投影不能代替 API 图像。

本期 engine.play 直接复用现有冻结 editorRevision 的构建/替换链路，立即返回 attemptId；构建失败保留旧运行。它与 Summer saved-files、先停止旧 main 再启动的语义不同，明确标为 partial。本期不为追求该差异另建一套 launch/job 状态机，也不伪造 runId。跟踪使用现有 get_build 和 wait_for_event(attemptId,running)。

backend 同步提供 captureContext()，含项目/编辑版本、当前待启动 attempt 及 active run；提供 cancelLaunch(attemptId)、getBuild、stopRun、wait 等窄接口。cancelLaunch 复用 main.ts 对匹配 playIntent 的 invalidatePlay，不取消后来 attempt、不声称中止编译 Worker。该 hook 是 backend 合同，不额外增加全局 cancel 方法。

engine.stop 接纳时捕获 pending attempt 和当前 run：先取消该 attempt 的未来预览意图，再只查该 attempt.preview；若它已形成 session，只将其 runId 与原 captured run 去重后请求停止。等待/查询始终绑定这几个 ID，绝不 await 后读取新的 activeRunId。接纳之后的新 play 不属于该 stop。

E/C 明确收拢 session-created 与 attempt 归属登记的同步边界，保留取消标记直到该尝试不再可能生成预览。若取消与 session 登记交错，登记 hook 发现所属 attempt 已取消后，只对该 session 请求 stop，不允许迟到运行继续存活。该收尾义务沿用有界 attempt 保留/容量，不新增独立 job；不能只查一次 preview=pending 就丢弃义务。迟到 session 通过原 attempt 追踪；初始 stop 返回数组不伪造尚未知的 runId，也不转向后来其它运行。

stop 与 play 一样先返回接纳事实，不能在请求已派发时因等待超时报“未执行”。stop payload 固定含 cancelledAttemptId 或 null，以及本次 captured/derived run 的 stop 回执数组；正常退出通过 get_run/wait_for_event 查询。没有目标时返回空数组和 no_target=true，不宣称曾退出一个游戏。面板 finally 不使用已 abort 的回放 signal，按捕获 attempt/run 做独立有界收尾；超时保留未确认事实。

请求入场捕获项目/版本/run，所有后续异步只使用该绑定。节点路径解析后保留 expectedInstanceId；不能发现节点替换就悄悄重绑。标准 engine.runtime_set 不带 runId，只能防本次调用途中重定向；跨调用旧运行测试必须调用显式 runId 的 GodotAI 原语，不能声称标准参数可表达旧 run。

新 ABI ready 时 runtime_set 一律走新原语，包含 position；只有 runtimeProperties.supported 明确为 false 且旧 runtimeWrite ready 时，才允许仅 position 路由旧 API。supported=null 或 supported=true/ready=false 均返回 not_ready，不降级。路由及能力依据绑定入场捕获的 run；新路径 busy、异常、超时、unconfirmed 时不回退补写。声明新 ABI 但导出失配直接握手失败，不能退回旧路径掩盖错误。M1 的旧回执不含 before/native frame，原样保留缺失。

字面量按声明类型严格解释：bool 只收 boolean；int 只收 safe integer number；float 收有限 number；string 原样保留；原生 position 接受完整 Vector2(x,y) 字符串。数字 grammar 固定为 `[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?`，仅允许 constructor、逗号旁 ASCII 空白及两个有限分量，整体必须匹配。禁止 eval、其它构造器、尾随表达式、对象、数组；string 声明的 Vector2 文本不被解析。

## 八 Facade 输出与兼容声明

统一使用 Summer 风格外层和明确 GodotAI payload，不添加未核验的 Summer before/after/transport 别名：

```ts
type Compatibility = {
  input: 'subset';
  semantics: 'partial';
  payload: 'godotai-typed-v1';
  summerNativeFixture: false;
};
type FacadeSuccess<T> = {
  ok: true;
  status: 'done';
  result: {
    data: T;
    godotai: {compatibility: Compatibility};
  };
};
type BackendFailure = Extract<
  RuntimeSetResult | ObservationResult<unknown> | InteractionResult<unknown>
  | Awaited<ReturnType<PlaygroundApi['play']>>
  | Awaited<ReturnType<PlaygroundApi['stop']>>,
  {ok: false}
>;
type BackendError = BackendFailure['error'] | AccessError;
type FacadeErrorCode = BackendError['code']
  | 'invalid_cursor' | 'revision_conflict' | 'outcome_unknown';
type FacadeReceipt = PublicResult<WriteResult> | RuntimeSetResult;
type FacadeFailure = {
  ok: false;
  error: {
    code: FacadeErrorCode;
    message: string;
    source?: AccessError['source'];
    retry: 'no';
    details: {godotai: {
      compatibility: Compatibility;
      route?: 'runtime_properties' | 'legacy_write';
      receipt?: FacadeReceipt;
      backendError?: BackendError;
      parameter?: string;
      unknownKeys?: string[];
    }};
  };
};

type CompletedWriteResult = Exclude<WriteResult, {outcome: 'unconfirmed'}>;
type LegacyWriteSuccess = Extract<RuntimeSetResult, {ok: true}>;
type CompletedLegacyWriteSuccess = Omit<LegacyWriteSuccess, 'result'> & {
  result: Exclude<LegacyWriteSuccess['result'], {outcome: 'unconfirmed'}>;
};
type WriteData =
  | {route: 'runtime_properties';
      payload: Extract<PublicResult<CompletedWriteResult>, {ok: true}>}
  | {route: 'legacy_write'; payload: CompletedLegacyWriteSuccess};
type PlayData = {
  accepted: true; state: 'pending'; attemptId: string; run: null;
  projectId: string; editorRevision: number;
};
type RunningData = {
  playing: boolean; capturedRunId: string | null;
  pendingAttemptId: string | null;
};
type StopData = {
  accepted: true;
  cancelledAttemptId: string | null;
  capturedRunId: string | null;
  pendingAttemptId: string | null;
  runs: Array<{runId: string;
    receipt: Awaited<ReturnType<PlaygroundApi['stop']>>}>;
  no_target: boolean;
};
```

本节引用的 RuntimeSetResult、ObservationResult、InteractionResult、PlaygroundApi 均使用现有 SDK/Playground 导出类型，不复制删减其错误码。FacadeSuccess 的 data：context 使用现有 get_project_context.result；tree/inspect/screenshot 使用现有对应 snapshot；写入为 WriteData；is_running/play/stop 分别为 RunningData/PlayData/StopData。无值身份统一 null，不省略。stop.runs 保留每个目标的完整旧 stop 返回值，包括个别失败；no_target 当且仅当 pendingAttemptId 为 null 且 runs 为空。不存在不具备轮询接口的新 job ID。

status=done 只说明提交/查询调用已完成；play/stop 的 accepted 不等于运行/退出已确认。play 的后续构建、sourceHash 和 run 由原 attempt 追踪。新写 route=runtime_properties，旧写 route=legacy_write；二者 payload 分支不能混读。

not_written/not_applied 是已知结算业务结果，保留成功信封；unconfirmed 不进入成功 WriteData，转 outcome_unknown，details 保留固定 route 与完整 typed receipt，retry=no。未知执行证据仍为 unknown，不填 false。访问前错误保留原 code，包括 unsupported_node_type、observation_failed、capture_failed、revision_conflict 等既有代码，不压为 invalid_input。details.godotai.backendError 保存完整原 error；顶层 source 只在已知时给出，适配器自身校验为 sdk，旧 backend 没有 source 时不猜。尚未调用 backend 的拒绝可无 backendError/receipt。

已核验固定 Summer 客户端参数、请求构造与工具声明的预期字段；客户端只发一次 SetRuntimeProp，不代表已验证其原生绑定检查、实际值编码、transport 枚举或帧关系。本期的 native before/set/readback 由本地新 ABI 自己保证。严格 wire 兼容需要固定版本原生黄金样例和逐字段契约测试，列为后续兼容级别，不阻塞本期输入子集/本地语义演示。

属性发现/批读、check、wait、输入与旧运行负测使用明确的 GodotAI 本地原语，不伪装成 engine.runtime_get。engine.inspect 不自动执行 script getter。最初的 V2 运行时属性阶段将 `game_input` 和 `wait_for_event` 的 Summer 脚本输入与事件游标，以及 `runtime_call`、`game_probe` 和 `game_control` 列在交付范围之外。后续 `game_probe` 的支持条件见[第十六节](#十六-enginegame_probe-同帧采样)。MCP content 是未来对 dispatcher 的外壳；本期不要求安装 MCP server 或连接 Summer 应用。

## 九 Playground 与证据

新增独立 `runtime-properties-demo.ts`，Schema 4 engine scene launch，project.godot 指向 main.tscn；Main/Player 挂真实 @bind()/@bind.export auto-accessor 脚本。不要扩写当前动态 new Node2D 的 interaction demo 冒充导出脚本。旧演示保留回归。

固定样例：画布960×640，红背景；Player 初始(64,256)，中心32×32白标记；health:int=100、move_step:float=64、can_move:bool=true、display_name:string=Player 你好，未导出 internalCounter 不可发现。血条位于(24,24)，高度16、黑底宽200、绿条宽2×clamp(health,0,100)，_process 同步。Right 非 echo 单次按下增加 move_step，Down 重置(64,256)。文字只展示，不作像素判据。

固定回放如下：

1. 准备/复用独立样例，捕获项目版本；check，经 dispatcher play，按 attempt 等 running；保存 sourceHash、完整 run/release 和唯一 Main/Player 的路径/实例。
2. describe 验证四项真实导出、candidate、类型和未导出字段缺席；显式 read 初值，旧观察读 position；采初始 PNG。
3. Summer runtime_set health=40，要求原生 before=100、comparison/observed=40、applied/writeEntered/frame；独立 read=40；采后续 PNG 验证绿条200变80。
4. 本地 Right tap，wait_for_input 的 down/up 均有 dispatched 证据；独立读 position=(128,256)。
5. Summer 写 move_step=128，独立读回；Down 完整边沿后确认(64,256)，再 Right 完整边沿后确认(192,256)；PNG 验证标记及血条。
6. dispatcher stop，按捕获 run 取得 host-report、clean-exit、nativeExit.code=0、hostCleanup=complete。
7. 相同项目/版本/sourceHash 重启，新 runId；新实例初值和初始 PNG 恢复。
8. 用第一轮原封不动保存的 run/path/instance 调本地 write 原语，要求 run_ended；随后读取第二轮和 PNG，确认无变化。第二轮同样取得干净退出。

每个 native receipt、独立读取、输入回执、PNG 都核对七字段 WorkerRunIdentity 和 releaseId；请求关联再核对 requestId/sequence。节点只选唯一场景目标，不按首个同名猜测。PNG 按 floor(logical×实际尺寸/逻辑尺寸) 映射，检查 y=32 中线绿色连续区间 `[24,224)` 与 `[24,104)` 的缩放边界，以及白标记内部；不用两个像素代表整个宽度。renderSerial 与读样本序号分别记录，不断言同帧。

面板共用运行互斥和统一 backend，失败、abort、切项目均 finally 按捕获 attempt/run 收尾。现有 trace 仅12条且会截断，不承载完整证据；专项独立收集结构化报告。面板可展示最小身份/帧以供调试，但不把 candidate 写成确认可写，不因成功回执断言玩法正确。

## 十 发布能力与来源证明

新增 runtimeAbi.runtimeProperties=1，依赖 lifecycle=1、observation=1，不依赖 runtimeWrite。首期只开放 full-engine-v1/template_debug、单线程 window 构建配方、Dedicated Worker/Direct；bitmap 等明确 unsupported。运行握手 runtimePropertiesVersion=1，get_run.runtimeProperties 为 supported=null/false/true、ready、version、supportedExportTypes、supportedNativeProperties。协商前 null；旧模板 false；声明存在但实际缺导出/版本错在公开 running 前失败。

证明字段冻结为 runtimeProperties={abi:1,exports:[两个新符号],sources:{相对路径:sha256},wasmSha256}，与 ABI 声明双向验证：缺任一项、版本/目标/依赖/来源/实际 WASM 不符即拒绝；不能静默剥离一边当成有能力。非认证产物不发布该能力。

独立 RUNTIME_PROPERTIES_EXPORTS、来源清单和验证器，不复用仅固定观察三文件的检查。最小来源清单包含新属性 cpp/h、共享观察/guard cpp/h、Environment cpp/h、ScriptInstance cpp/h、Script cpp/h、class_info cpp/h、object_handle.h、实际新字符串/标量 Web/C++ 桥、SCsub、Godot退出标记补丁及生成输入。源文件新增/拆分必须在同一改动扩清单。完整 source.inputs 快照仍然保留，来源清单不能替代全快照；Godot补丁还绑定实际输出哈希和应用顺序。

| 文件归属 | 实施落点 |
| --- | --- |
| D 原生导出与构建 | SCsub；build-browser-engine.mjs 的实际导出/源码/目标/WASM报告 |
| D 证明与便携 | web-release-utils.mjs；package-browser-engine-artifact.mjs 打包和读取均验证，并重算ZIP内WASM |
| D 两条发布链 | build-web-release.mjs；full-engine-release.mjs 的 attestation/descriptor/build 保留和双向校验 |
| D 候选封印 | worker-candidate.mjs；seal-site-acceptance.mjs |
| D ABI白名单 | engine-profiles.mjs、release-adapter.ts、VerifiedRelease 的字段和验证 |
| C 运行协商 | Worker/host/runner 原生 ABI 与 running 握手；与 D 接受的 release 类型一致 |

旧只读及旧 write-1 报告继续接受；新 SDK 不给旧模板补新能力。新模板仍运行旧 API，旧 runtime-write-result 的严格两字段结果不加 before/frame、不加入新 outcome。原生、SDK或Web桥发生变化时完整重建，不走前端刷新补 ABI。

## 十一 分工、合入顺序与开工判定

| 包 | 可以立即开展的工作 | 单一文件责任/交接 | 后续依赖 |
| --- | --- | --- | --- |
| A 合同/适配 | 将第二至八节变成DTO、严格reader/fixtures、dispatcher和白名单 | 新adapter/backend模块、参数与投影测试；不再重开核心语义选择 | 新能力联调等待B/C，旧位置M1可先完成 |
| B 原生 | own exports、绑定记录/revision、严格标量/字符串、退出标记、回调安全和新导出 | 原生新模块、Environment/ScriptInstance/class/script、真实TS fixture；Godot补丁内容交D登记 | 测试编辑器/新Web产物等待F构建 |
| C Worker | 消息、统一序号/准入槽、预算、截止、DTO reader、runner与协商 | engine运行层、playground-api.ts三个新方法接线；引用A载荷 | 用受控执行器先测，真实ABI联调等待B/D |
| D 发布 | 能力枚举、独立proof、来源闭包、便携/发布/封印验证 | ABI/release类型、构建报告与补丁注册；C不重复改这些文件 | 真proof签发等待B和实际WASM |
| E Playground | 独立场景样例、面板、capture/cancelLaunch接线、精确方法清单、专项case | main.ts、agent-panel、web DOM、browser-debug-api/panel测试统一集成 | 可按A/C固定fixture先开发；真回放等待站点 |
| F 环境/验收 | 工具链前置已完成；继续旧基线/新候选构建和证据准备 | 产物目录/环境和真实执行，不重写E的case逻辑 | 新模板及M4等待B/D和实际产物 |

所有工作包现在都有明确输入和可实现任务，可以并行启动；不要求所有代码同一时刻合入。A 将已定合同物化为公共类型和 fixtures 是最先合入的小提交，不再是等待决策的 G0；B/C/D/E 可依本文和相同 fixture 形状先实现，再接该提交。共享文件按上表单人集成，避免多个包同时修改 main、公共 API 和发布白名单。

M1：A/E 完成旧位置经 dispatcher 回放，标明 legacy payload、缺失 before/frame。M2：A/B/C/D/E 受影响类型检查、原生/真实TS及受控测试通过。M3：B/D/F 产出新模板和固定旧模板，用同批新 SDK 完整构建两个站点。M4：两站点实际专项通过，才完成本期交付。

开工结论不包含“当前可立即执行M3/M4”，也不包含“已证明与Summer原生wire互通”。M2失败阻止相关实现合入；新proof/模板不匹配阻止M3；缺少任一真实专项或身份/退出事实阻止M4，不能用受控结果补位。

## 十二 验收矩阵和命令

| 层次 | 必须验证的行为 |
| --- | --- |
| DTO/输入 | 完整分支fixtures；names/limit互斥；静态批拒零getter；unknown evidence不变false；字符串/类型/最终JSON预算 |
| 原生元数据 | own导出/无own派生/继承覆盖、基类热重载、重绑失败ready=false、同节点变脚本、未知访问模式、只读usage |
| 标量桥 | bool/int/float/string严格类型；JS小数不截断；安全整数边界；Unicode/NUL/孤立代理/转义膨胀；不调用被替换的全局转换函数 |
| 生命周期 | 每阶段free/queue_free/换脚本/quit/重入；释放scoped pointer；NativeInteropScope范围；旧API保持 |
| 结果 | applied、clamp的not_applied、before失败的not_written、write Maybe false/throw的unconfirmed、read首失败停止 |
| Worker | 跨消息族序号重用/重放、结果丢失恢复、请求/取消独立物理额度、旧回执、deadline交接与阶段检查、同步阻塞 |
| facade | 操作白名单/default、未知与已知不支持参数、typed字符串规则、M1与新路径只选一次、pending stop/替换不误停后来run |
| 面板 | 全流程确经dispatcher、candidate与unknown呈现、切项目/取消/finally、独立证据不依赖trace容量 |
| 发布 | 证明双向缺失/篡改、错误WASM/来源/退出补丁/目标、声明握手失配、旧报告接受 |

已注册真实 case：runtime-script-properties、runtime-script-properties-boundaries、runtime-script-properties-unsupported，均包含能力 preflight 和选中 case 必执行检查。实际通过状态见第十五节。

新站点跑正常业务回放及边界专项：before throw、write后throw/Maybe false、clamp、批读异常、目标/绑定变化、quit后不写、NUL/Unicode往返、脚本Vector2静态unsupported。旧 write-1 站点验证新三方法unsupported且无派发，并真实跑旧位置/观察/输入/PNG；新旧站点都跑既有 runtime-set-position 和 runtime-set-boundaries。旧只读配置做受控发布/握手/API回归，本期不要求第三套真实站点，也不宣称验证其真实引擎。

```sh
pnpm test:engine
pnpm --filter @godot-js/playground typecheck
node --test apps/playground/scripts/playground-api.test.mjs \
  apps/playground/scripts/debug-api.test.mjs
node apps/playground/scripts/browser-debug-panel-test.mjs

# 使用已集成模块和固定QJS配方重建 tests=yes 编辑器后：
/absolute/godotjs-editor --headless --test --test-case='*runtime propert*'

PLAYGROUND_TEST_DIRECTORY=/absolute/site-new \
PLAYGROUND_DEBUG_API_CASE=runtime-script-properties \
PLAYGROUND_DEBUG_API_REPORT=/absolute/results/new-properties.json \
node apps/playground/scripts/browser-debug-api-test.mjs

PLAYGROUND_TEST_DIRECTORY=/absolute/site-old \
PLAYGROUND_DEBUG_API_CASE=runtime-script-properties-unsupported \
PLAYGROUND_DEBUG_API_REPORT=/absolute/results/legacy-properties.json \
node apps/playground/scripts/browser-debug-api-test.mjs
```

新增包内和发布回归加入对应test命令；原生过滤实际执行非零测试。必须有真实 decorated TS 经编译/加载形成 ScriptInstance，不能仅C++假对象。遵循[本地验证策略](../../CONTRIBUTING.md#local-verification)，不用缺少custom_modules等环境参数的通用SCons命令替代本机配方。

M4报告要求 engineExecuted=true，保存源码/编辑版本/sourceHash、releaseId/candidateId/ABI、七字段运行身份、节点/请求/序号、原生与独立值、输入down/up边沿、PNG/哈希/几何、两轮host-report及nativeExit.code=0、hostCleanup=complete。受控面板明确engineExecuted=false；cleanExit不能只检查reason。单独记录facade级别，不把本地成功升级为Summer互操作证明。

## 十三 环境事实与确定的候选路线

本节保留开工时的环境与候选路线记录；后续完整构建和交付验收以第十五节为准。

开工工具链前置已于 2026 年 11 月 22 日补齐，使用 `source /workspace/.godotai-tools/web-env.sh` 加载：

| 工具 | 已准备的位置与核验 |
| --- | --- |
| Emscripten | `/workspace/.godotai-tools/emsdk`，固定 4.0.11，实际 C 编译为 WASM 并在 Node 执行通过 |
| Godot Git 源码 | `/workspace/.godotai-sdk/godot-4.6.1-git`，干净 HEAD `14d19694e0c88a3f9e82d899a0400f27a24c176e` |
| glTF 导入器 | `/workspace/.godotai-tools/godot-importer-4.6.1/Godot_v4.6.1-stable_linux.x86_64`，官方 4.6.1，归档 SHA-512 与官方清单匹配，实际 glTF 场景导入通过 |
| 既有工具 | Node 24.19.0、pnpm 10.11.0、SCons 4.10.0、GodotJS 4.6.1 QJS 编辑器继续使用 |

`pnpm build:engine-js`、现有 Web 生产器的源码快照、Full/debug 单线程 SCons dry-run 均已通过，检查记录为 `/workspace/.godotai-logs/web-prerequisites.json`。这些结果证明工具可用及构建预检通过，尚未执行完整 Godot Web 编译或真实浏览器产品验收。原有本机 SDK 保留；源码快照与预检在独立构建目录 `/workspace/.godotai-sdk/web-full-debug-build` 完成。

F 的工具链阻塞已解除。新能力模板仍须等待 B/D 实现、重建匹配编辑器和实际 WASM，冻结同批 SDK 后再执行候选与双站点验收；预检报告不能作为 sourceCertified/built 报告消费。

旧模板优先找回PR22便携材料并复核；找不到即从已经存在的完整旧SHA `8583001d5d2966c8ba78e9409d3e7d9c0bad66b4` 的独立Git checkout重建。固定full-engine-v1、template_debug、window、threads=no、dlink_enabled=no；使用该基线的构建脚本/原生源码及完整认证报告。当前任务工作区和已有修改保留，旧模板来源不混入本期新原生修改。此fallback不依赖历史下载链接继续有效。

新旧模板分别保留原始报告、便携映射、ZIP/WASM、build.log、artifact.json。用本期同一冻结新版SDK和完整build分别构建site-new/site-old；旧模板带旧源证明，新SDK带自己的冻结证明，两者按已有release装配合同核对，不声称同一个源码版本。

```sh
node scripts/test/package-browser-engine-artifact.mjs \
  --out /absolute/old-portable --verify

GODOT_SOURCE=/absolute/git-godot-4.6.1 \
ENGINE_PROFILE=full-engine-v1 ENGINE_TARGET=template_debug \
ENGINE_EXECUTION_MODEL=window \
bash apps/playground/scripts/build-web-engine.sh

GODOT=/absolute/godotjs-editor GODOT_IMPORTER=/absolute/godot-4.6.1-importer \
node apps/playground/scripts/build.mjs \
  --engine-report /absolute/new/engine-report.json --out /absolute/site-new

GODOT=/absolute/godotjs-editor GODOT_IMPORTER=/absolute/godot-4.6.1-importer \
node apps/playground/scripts/build.mjs \
  --engine-report /absolute/old-portable/engine-report.json --out /absolute/site-old
```

实际签发proof等待真实WASM，不能用合成proof或 dry-run 代替；旧模板恢复失败采用上述固定基线重建，不降低M4。工具链、Git源码和导入器已就绪，后续等待项是实现代码与匹配构建产物。

## 十四 评审通过条件与后续

本版消除了原API/Worker/原生设计阻断：结果分支、类型范围、阶段预算、统一序号/准入、最终JSON预算、热重载/退出检测、inspect范围和pending stop都已定案。首期不再以研究代理Vector2或取得Summer原生wire样例为前置。A–F可以各自按第十一节启动，实际代码与产物仍须过各自门禁。

后续新增脚本Vector2前，验证正常Godot数学proxy、品牌/存活、错误wrapper、循环/恶意proxy与有界解包，不能直接放开旧转换器。runtime_call独立定义方法发现、同步返回、异常、目标自删除和不可编码返回；probe与pause/step分别定义采样及调度范围，不把SceneTree.paused称为整个JS/Worker游戏被冻结。

Summer固定来源：[操作定义](https://github.com/SummerEngine/summer/blob/5d0bc70c6228a2f718485913449f20482434b47b/src/core/ops/engine.ts)、[运行参数](https://github.com/SummerEngine/summer/blob/5d0bc70c6228a2f718485913449f20482434b47b/src/core/capabilities/runtime-control.ts)、[感知工具](https://github.com/SummerEngine/summer/blob/5d0bc70c6228a2f718485913449f20482434b47b/src/mcp/tools/perception-tools.ts)、[运行工具](https://github.com/SummerEngine/summer/blob/5d0bc70c6228a2f718485913449f20482434b47b/src/mcp/tools/runtime-tools.ts)。客户端源码、资源schema和native实机输出分别说明证据范围，不互相替代。


## 十五 实施记录（2026 年 11 月 22 日）

原生属性 ABI、严格标量和字符串桥、静态 own-export 元数据、绑定身份与分阶段生命周期检查已落地。SDK/Worker 接入三个新方法并与旧位置写入共用序号、准入和额度管理；Playground 增加三个本地原语、八项 Summer 风格操作及公开属性回放按钮。发布链保留旧 ABI，并为新能力验证 31 个来源文件、补丁链和实际 WASM。没有引入新的注册状态、启动作业或自动重试机制。

演示入口：[本机 Playground](http://localhost:4173/) → 调试 → API 文档 → 公开脚本属性验证。它使用真实标准导出脚本，通过 Summer 入口写血量与移动步长，独立读取、输入和 PNG 检验，再验证相同源码重启恢复和旧运行隔离。Summer 兼容级别仍为本地语义与输入子集，结果为 GodotAI typed-v1；本期没有签发 Summer 原生 wire 互操作证明。

| 检查 | 实际结果与记录 |
| --- | --- |
| SDK / 项目工具 | engine 143/143、project-tools 123/123；`runtime-properties-final-reviewed-engine.log`、`runtime-properties-post-review-engine-tests.log` |
| Playground | 完整套件 407/407，无失败、跳过或取消；最终契约补充用例 39/39，类型检查通过；`runtime-properties-final-reviewed-playground.log`、`runtime-properties-post-review-final-focused.log`、`runtime-properties-post-review-final-typecheck.log` |
| 原生新旧接口 | 18/18，643/643 断言，包含真实 decorated TS 和严格名称/值/JSON 往返；`runtime-properties-post-review-native-correct-cwd.log` |
| Web 桥与发布 | Web 桥 54 pass / 1 skip / 0 fail；来源证明、便携包、完整发布及候选校验 63/63；`runtime-properties-post-review-web-bridge.log`、`runtime-properties-post-review-release.log` |
| 固定旧模板 | 从固定基线独立重建 full/debug、单线程模板；报告 `write1-engine-report.json` 为 built/sourceCertified，声明 observation 1 / runtimeWrite 1，无 runtimeProperties |
| 旧站点真实验收 | 用修复后的 SDK 重建后，三项全部 passed，均 engineExecuted=true：新能力 unsupported、旧位置回放、旧写边界；`runtime-properties-post-review-acceptance/old-*.json` |
| 新模板 | `properties-engine-report.json` 为 built/sourceCertified，声明 runtimeProperties 1；31 个证明源与当前生产源码逐项一致，站点 WASM 与证明哈希一致 |
| 新站点真实验收 | 用修复后的 SDK 重建后，正常属性回放、属性边界、旧位置回放、旧写边界四项全部 passed，均 engineExecuted=true；新增数组 getter 零调用及 Vector2 精度专项也在真实引擎通过；`runtime-properties-post-review-acceptance/new-*.json` |
| M1–M4 汇总 | `runtime-properties-post-review-acceptance/completion.json`；七份最终报告逐项匹配当前 candidate/release，双站点 SDK 源码及输出哈希相同，四张 PNG 字节与报告哈希一致；`runtime-properties-acceptance/completion.json` 同步指向最新汇总 |

本机证据根目录为 `/workspace/.godotai-logs`。新旧便携产物分别位于 `/workspace/.godotai-artifacts/runtime-properties-new`、`/workspace/.godotai-artifacts/runtime-properties-old`，均已用当前打包器创建并独立验证；合并记录为 `runtime-properties-portable-artifact-acceptance.json`。新旧完整站点分别位于 `/workspace/.godotai-sites/runtime-properties-new`、`/workspace/.godotai-sites/runtime-properties-old`。资源导出器另存于 `/workspace/.godotai-tools/godot-exporter-4.6.1/godotjs-editor`，避免链接中的原生测试二进制覆盖导出进程。

真实集成发现的样例 `NodePath` 参数类型已修复，随后正常回放的实际类型检查和全部业务断言通过。换脚本专项采用以原生 `Node2D.position` 保存状态的显式 getter/setter，独立确认替换后的值为 500、位置仍为 (64,256)，旧写结果为 not_written/target_changed。初始 auto-accessor 替换夹具触发既有 crossbind 只换原型、未初始化私有 brand 的语言行为，接口如实返回 getter_failed；candidate 的含义仍是可尝试访问。

### 修复后全量评审

复核覆盖本次全部已跟踪改动与新增文件，包括原生元数据/生命周期、严格字符串桥、SDK 与 Worker 传输、Summer facade、Playground 回放、发布证明、测试及文档。文件清单与 SHA-256、修复项和证据路径记录于 `runtime-properties-all-changes-review.json`；本轮未发现仍待修复的 P1/P2 问题。

两项 P2 已修复：输入数组及结果数组按自有数据描述符复制，校验和观测日志不再调用输入继承的 every、iterator 或 toJSON，拒绝索引 accessor 与稀疏数组；原生写回执必须使请求值、比较值、读取值及结果分支相互一致，拒绝伪造成功、错型 beforeValue 和没有进入读取的已知读取证据，保留整组一致的 float32/float64 Vector2 精度表达。补充的真实浏览器验收同时覆盖这两条路径。

全量复核还收紧了 Summer facade 的类型与输入边界：typed-v1 的各成功 data 分支和错误码使用具体联合类型；缺失 screenshot.target 返回 invalid_input；Vector2 字符串必须完整匹配，不能带末尾换行。本轮没有修改原生生产源码，31 个来源证明仍与当前原生实现一致；新旧站点均使用同一份修复后的 SDK 重新构建并重新验收。修复前的浏览器记录保留在 `runtime-properties-acceptance-before-review-fixes`，供对照追溯。

本机演示可重新启动：

```sh
cd /workspace/GodotAI
source /workspace/.godotai-tools/web-env.sh
PLAYGROUND_DIRECTORY=/workspace/.godotai-sites/runtime-properties-new PORT=4173 \
  node apps/playground/scripts/serve.mjs
```

## 十六 `engine.game_probe` 同帧采样

`summer_call({op: 'engine.game_probe', input})` 接受 `instance: 'main'`、`tree`、`props`、`screenshot` 与 `max_dim`。`tree` 可指定绝对路径，深度范围 1–8，默认 2，节点上限范围 1–500，默认 200。`props` 最多 16 项，格式为 `'/root/Main/Player:position'`。`screenshot` 默认开启，`max_dim` 是 PNG 长边上限，范围 16–1024，默认 1024。SDK `gameProbe` 和 Playground `game_probe` 要求显式 `runId`，使用 `{path, property}` 和 `maxDimension`，并支持 `timeoutMs` 和 `AbortSignal`。

图像模式从主视口一次实际成功的自动绘制提交读取树、纯原生属性和 PNG。快照与 Canvas 副本先于 `frame_post_draw`，迭代结束时才确认提交次数和退出意图，再启动 PNG 编码。普通截图与图像 probe 共用一个物理捕获槽。取消或超时可以先结束调用者的等待，捕获槽在实际结果到达或运行销毁后释放。`screenshot: false` 在原生迭代末尾获取数据，结果的 `image` 为 `null`。两种模式均返回运行身份、发布身份和请求 ID，图像模式还返回渲染序号与几何。

属性范围为 `Node2D.position`、`Node2D.rotation` 和 `CanvasItem.visible`，其他属性按项返回 `unavailable`。树结果包含节点实例 ID 和截断信息。仅源证明和实际导出均匹配的 Full Engine debug 单线程模板声明 `gameProbe: 1`。Chromium Worker Direct 运行就绪后才接受采样。旧模板通过同一新 SDK 返回 `unsupported`，无需向 Worker 发送 probe 请求。

Playground 的 **API 调用 → engine.game_probe → 打开独立示例** 包含定位、采样、移动、复采样、退出和重启。载入历史来源仅填充当前草稿。使用 `browser-game-probe-g0.mjs` 运行最小 PCK 专项，用 `test:browser:game-probe` 对匹配新旧模板的完整站点执行验收。
