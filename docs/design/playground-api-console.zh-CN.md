# Playground API 调用台完整方案

日期：2026 年 11 月 22 日。分析基线：`87ab9ef`（PR #23）。

首期方案已实施并通过真实引擎验收，交付记录见第 11 节。调用台现有 15 项 Summer 风格操作和 7 项本地辅助，包含主动脚本检查、诊断、玩法方法、同帧探测、物理帧输入和启停事件。 [现行调用台](../../apps/playground/README.md#agent-tools) · [诊断与修复](../../apps/playground/README.md#diagnostics-and-repair) · [生命周期回放](../../apps/playground/README.md#lifecycle-events) · [初建阶段开发原则](../../CONTRIBUTING.md#framework-development-stage-and-reviews)

## 1. 结论与目标

交付一个可在页面内选择操作、修改 JSON 参数、执行并观察真实游戏结果的调用台。主要受众是平台接入开发者、引擎维护者与 API 演示使用者；Agent 继续调用现有公共 API，不需要操作页面。

一次交付 **8 项 Summer 风格操作 + 6 项 GodotAI 本地辅助**。Summer 为默认组，本地辅助单独分组并标明合同来源。取消上一轮按两次交付划分目录的歧义。

调用台与新增引擎能力分开：本期无需 runtime_call、game_probe、新原生 ABI、MCP server、ops.describe 或外部服务。位置修改、公开脚本属性与输入都使用已有实现。完整 Inspector、通用 JSON Schema 表单、任意 JS/eval、步骤脚本语言、持久历史与分享不在本期。

**实施前的开工判断。** 当时缺少匹配的 Web 模板、报告和完整站点。资产恢复与目录、调用器、界面和受控测试并行推进，真实验收结果见第 11 节。

## 2. 评审结论与修订

| 原方案未定或有误的地方 | 本版定案 |
| --- | --- |
| 首期 8 项、第二期 6 项，演示边界不一致 | 首期统一交付 14 项；不将本地辅助算作 Summer 兼容覆盖 |
| JSON 编辑复用 Monaco 还是另开编辑器 | 首期使用独立 textarea；保留源码 Monaco 模型与撤销栈，不注册虚拟项目文件 |
| 全局 Ctrl/Cmd+Enter 会执行 compile | API 参数区只执行调用；API 模式其它区域不触发源码构建；代码模式保留原快捷键 |
| 打开示例似乎只会填参 | 分开“填入预设”和“打开独立示例”；后者明确切项目、结束当前预览、不自动 play |
| activeRunId 被当作当前编辑项目的运行 | 同时展示编辑项目/版本与 active run 的 projectId/revision；运行操作不准误指切换前项目 |
| Summer 输入似乎可固定选中节点实例 | 不添加 runId/expectedInstanceId；只能防已知运行切换，跨调用节点实例固定不是该接口的能力 |
| 订阅 trace 可用作用户历史 | 调用器直接取得返回；一次提交一条历史，trace 仍为旁观记录 |
| 截图按 Uint8Array 处理 | 实际 bytes 是 ArrayBuffer；用 Blob([bytes]) 展示，JSON 显式标二进制摘要 |
| 取消会立即释放互斥或意味着撤销 | 互斥持有到 finally；取消不抹除执行事实，不伪造回滚 |

证据：[主接线与示例打开](../../apps/playground/src/main.ts)、[调用入口](../../apps/playground/src/playground-api.ts)、[Summer 白名单与绑定](../../apps/playground/src/summer-adapter.ts)、[工作区布局](../../apps/playground/src/workbench/workbench.ts)、[截图与输入类型](../../packages/engine/src/browser/dedicated/worker-interaction.ts)。

## 3. 页面与交互合同

### 3.1 布局

左栏的「API 调用」与「内置依赖」使用同一种折叠区样式。操作列表分为 Summer 风格和 GodotAI 本地辅助两组，每项显示 API 名称和一行简介。点击条目在文件标签同一栏打开带 `API:` 前缀的标签，再次点击聚焦已有标签。每张卡包含以下内容。

1. 编辑项目/版本、当前主运行归属与阶段，以及待启动 attempt。
2. 该 API 的名字、说明、支持参数与当前限制。
3. input JSON textarea、“填入预设”“更新目标/填入上下文”“执行”；可取消时显示“取消等待/查询”。
4. 本次请求完整构造、结果阶段、JSON 展示投影及 PNG 附件。
5. 本页共享的有限历史。「载入参数」打开对应 API 标签并恢复请求，等待手工执行。

底部调试面板提供调用台快捷入口，优先打开最近使用的 API。自动验证继续使用底部面板入口。

### 3.2 文件、焦点与快捷键

- 模式切换不写项目、不改变 editorRevision、不自动检查/构建/停止游戏；在途手工调用继续属于原历史项。
- 用户点击文件、文件标签或诊断位置时切回代码并定位。后台 renderFiles、编译诊断刷新不抢走 API 模式。
- 切换到 API 卡片时保留阅读位置，键盘焦点留在标签。工作区加载完成并刷新标签栏时，同一个选中标签保留焦点。参数框获得焦点后，Ctrl/Cmd+Enter 执行一次调用并阻止冒泡，长按产生的重复键盘事件不执行。源码 Monaco 保留原有构建快捷键。
- 小屏幕采用上下排列；API 模式的 runStarted 不自动进入专注预览而隐藏调用台。模式切换和关键执行按钮可用键盘操作。
- 每项操作在页面内存保留独立草稿、校验提示和卡片阅读位置，关闭后重开也可继续查看。卡片默认显示该 API 最近的结果，填参使用当前展示的记录。跨 API 填参时，先在共享历史中选择要使用的结果。textarea 只编辑 input，完整请求为只读展示。编辑时可以准备下一份草稿，执行结果按发起调用的 API 归属。
- 首期不复用项目自动保存，也不新增持久化迁移；输入法组合输入期间不响应执行快捷键。

### 3.3 示例与预设

“填入预设”只改变调用草稿。“打开独立示例”是显式 Playground 项目动作：复用未编辑的同款样例，或创建独立副本，保留原项目与已编辑副本；调用 select(..., false)，结束旧预览并准备新项目，但不自动 play。界面直接写明该效果，无需额外确认弹窗。

两条教学流程以有序示例列表呈现，每项可载入修改后执行；没有步骤执行器、自动补跑、脚本断言或隐含等待。原有严格自动回放保持独立。

## 4. 精确操作目录

### 4.1 Summer 组：统一经 summer_call

| op | 默认 input / 来源 | 主要限制与结果 |
| --- | --- | --- |
| engine.get_project_context | `{}` | 本地 context；不支持 include/settings 筛选 |
| engine.play | `{}` | instance 仅省略或 main；返回 accepted/pending 和 attemptId |
| engine.stop | `{}` | 捕获当时 main run 与 pending attempt；不是当前编辑项目专属 stop |
| engine.is_running | `{}` | 不接受 instance；playing 不证明属性/输入 ready |
| engine.get_runtime_tree | `{ "depth": 3, "limit": 500 }` | depth 1–8、limit 1–500；可选 path；返回真实节点与实例 ID |
| engine.inspect_runtime_node | `{ "path": "实际节点路径" }` | 固定 position/rotation/visible，不读 health 或任意 getter |
| engine.runtime_set | `{ "path": "实际节点路径", "property": "position", "value": "Vector2(192, 256)" }` | 不加 runId/expectedInstanceId/field；脚本标量及原生 position 限定仍有效 |
| engine.screenshot | `{ "target": "game" }` | target 必须显式；不支持 scene/camera/size 等参数 |

Summer 兼容标识复用真实返回：input=subset、semantics=partial、payload=godotai-typed-v1、summerNativeFixture=false。保留已有本地 play/stop 语义，不伪造 Summer 原生 before/after/transport 字段。

### 4.2 GodotAI 本地辅助组

| 方法 | input 及来源 | 可取消 |
| --- | --- | --- |
| check | `{projectId, expectedEditorRevision}`，来自当前编辑上下文 | 否 |
| wait_for_event | `{attemptId, until:'running', timeoutMs:60000}` 或 `{runId, until:'exited', timeoutMs:10000}`；两个 ID 二选一 | 是，取消等待 |
| describe_runtime_properties | `{runId,path,expectedInstanceId,names:['health','move_step']}`；节点来自实际 tree | 是 |
| read_runtime_properties | 同一目标 + `properties:[{name:'health',expectedType:'int'}]`；类型来自 describe | 是，getter 可能已进入 |
| game_input | `{runId,gesture:{kind:'key_tap',code:'ArrowRight'}}` | 否，输入不能撤销 |
| wait_for_input | `{runId,operationId,timeoutMs:5000}`，operationId 来自同 run 的 game_input | 是，取消等待不取消输入 |

首期输入预设仅用支持的按键。公共 API 仍支持带实际截图 geometryEpoch 的归一化 primary_click，但本期不增加点选坐标编辑器。

get_run/get_build/get_diagnostics/read_run_events、本地 stop 等不加入菜单；原调试面板、全局 API、自动回放仍可使用。内部读取 getRun/getBuild 的事实用于上下文展示，不意味着菜单扩项。

## 5. 目录、调用与上下文合同

### 5.1 目录单一来源

新增零运行依赖的 `src/summer-operation-spec.ts`，承载现有 allowed/unsupported、默认值、数值范围与展示说明。adapter 与调用台共同读取；dispatcher/SDK 继续负责真实语义校验，不在 UI 复制路径/类型/范围 validator。

`src/workbench/api-console-catalog.ts` 引用该 spec，使用 type-only PlaygroundApi 导入，为 14 项提供明确调用函数、示例生成和结果类型提示；不动态遍历 window，不调用任意键，不引入 RPC/JSON Schema 框架。类型依赖不得形成 adapter → console → adapter 的运行时环。

UI 只解析 JSON 语法并检查草稿/目标是否仍可提交；合法但不支持的 input 交给原 API 返回。缺来源时预设显示“尚缺节点/attempt”等提示，不向 API 发送 `${runId}` 一类占位字符串。用户自行输入的有效 JSON 仍可用于查看真实 API 拒绝。

### 5.2 提交模型

内部模型最少包含以下内容（名称可随实现调整，语义固定）：

```ts
type ConsoleDraft = {
  operationId: string;          // 精确目录键；与 API requestId 无关
  inputText: string;
  anchor: ConsoleAnchor;       // 草稿生成/显式更新时的目标摘要
};
type ConsoleAnchor = {
  editorProjectId: string | null;
  editorRevision: number | null;
  activeRunId: string | null;
  activeRunProjectId: string | null;
  activeRunRevision: WorkerRunIdentity['revision'] | null;
  pendingAttemptId: string | null;
};
type ConsoleCall = {
  callId: string;              // 仅调用台 UI 身份，不冒充引擎 requestId
  draft: ConsoleDraft;         // 提交时复制；以后编辑不改此项
  submittedAt: number;
  settledAt?: number;
  phase: 'pending' | 'settled' | 'thrown';
  resultProjection?: string;   // 有界 JSON 展示；二进制明确摘要
  resultFacts?: ConsoleResultFacts; // 截断展示前提取的有界填参事实
  truncated?: boolean;
  attachmentId?: string;
};
```

ConsoleResultFacts 只保存填参需要的已核验事实：原 attemptId、完整 run identity 与归属摘要、节点 path/instanceId、属性 name/type、同 run 的 operationId、stop 的捕获 run 列表。逐项提取自相应操作的实际返回，不根据 UI 当前运行补齐；保留上游数量限制，不因文本截断而丢失来源关联。C/E 消费这些事实生成“使用此结果”动作，不解析截断后的 JSON 字符串。

```ts
type ConsoleResultFacts = {
  sourceCallId: string;
  sourceAnchor: ConsoleAnchor;
  attemptId?: string;
  run?: {identity: WorkerRunIdentity; projectId?: string; attemptId?: string};
  nodes?: {path: string; instanceId: string; type: string}[];
  propertyTarget?: {runId: string; path: string; expectedInstanceId: string};
  properties?: {name: string; type: RuntimeType}[];
  input?: {runId: string; operationId: string};
  stoppedRunIds?: string[];
  truncated?: true;
};
```

源归属以回执和原请求的已知事实关联；上游没有提供且不能从原绑定证明的字段不生成对应填参动作。sourceAnchor 保留来源运行，不能配上结算时新的 active run。每项最多保留 500 个节点、64 项属性、16 个停止 run，单条历史的来源存储不超过 256 KiB；超额明确 truncated。源历史被淘汰后其填参动作失效，已载入的草稿仍保留原 ID。

提交顺序为：解析 → 取得手工互斥 token → 读取当前上下文并核对 anchor → 保存历史 pending 项 → 同步调用真实 API → await 原返回 → 提取真实阶段/附件 → finally 按 token 释放。目标核对与真实调用之间不得 await。

取消 token、UI callId、engine requestId、attemptId、runId 保持不同用途。返回或 throw 都结算原历史项，迟到响应不覆盖当前草稿。JSON/陈旧目标拒绝显示独立 clientError，不冒充后端 error code；未调用 API 时不创建 pending 项。

### 5.3 运行目标与草稿过期

- readContext 从 recorder 的原始 getContext/getRun 及主应用 playIntent 读取，不通过有 trace 的方法轮询。必须取得 active run 自身的 projectId/revision，不能推断等于编辑项目。
- context/is_running 是当前查询，可直接执行；play 与 check 按编辑项目和 editorRevision 核对；stop 按界面展示的 activeRunId + pendingAttemptId 核对，允许显式停止不同于编辑项目的旧运行。
- tree/inspect/set/screenshot 对比草稿锚定的编辑 projectId/editorRevision、activeRunId 与 pendingAttemptId；提交前确认仍是该 run、且归属当前编辑项目、未停止。改变后显示“目标已变化”，用户显式更新目标再提交；不静默刷新旧请求。运行源码 revision 可以低于当前编辑版本，显式更新目标后仍可操作该旧源码运行，不要求两者相等。
- 本地辅助中的 runId/expectedInstanceId/attemptId/operationId 均使用最终 JSON 的显式值。允许保留旧 ID 查询，以便看到真实 run_ended/not_found；不在提交时替换。
- 本地 describe/read/game_input 若命中当前上下文中已知仍存活、却属于其它编辑项目的 active run，UI 以归属不符拒绝；read 的 getter 也可能执行脚本。不新增多运行登记系统；其它显式旧 ID、已结束或未知 ID 仍交给真实 API 判断并返回 run_ended/not_found 等事实。wait_for_event/wait_for_input 可继续查询原 ID。不因该规则改写旧 ID，也不禁止检查已结束 run 的负例。
- 载入历史恢复原参数与 anchor；“更新目标/填入上下文”是明确动作，恢复当前摘要，并根据模板写入可证明来源的 ID。重新选节点后才能更新实例 ID；更新 run 不可直接沿用旧节点实例或输入 operationId。
- `wait_for_event` 更新上下文时保留已有且唯一的退出目标；退出草稿缺少目标时只填当前 run。只有等待 `running` 时才从上下文填入待启动的 attempt。从结果显式选取的新目标仍可用于填参。
- 更新目标只修改该操作的身份字段并保留 property/value/gesture 等用户参数；若 JSON 当前无法解析，或新目标所需的节点/operationId 来源不完整，则保留整个原草稿、提示缺项，不做部分覆盖。Summer 操作只更新 anchor，不凭空添加身份字段。“填入预设”才允许显式替换整份 input 文本。
- Summer set 每次提交会重新解析 path，只保证本次调用内绑定；跨调用同路径节点被替换不属于 UI 能保证的防护。不偷加参数或新预检协议。
- 来自旧运行的节点、属性描述与输入回执保留在旧结果，不能自动成为新运行的填参来源。属性元数据发现不执行 getter；只有显式 read 才读取。

### 5.4 填参来源

提供小型显式“使用此结果”动作，不引入表达式/变量系统：

| 结果来源 | 可填内容 |
| --- | --- |
| 当前编辑上下文 | check.projectId / expectedEditorRevision |
| Summer play.result.data.attemptId | wait_for_event.attemptId |
| wait.result.run | 该次 runId；必须 outcome=reached 才按目标阶段继续 |
| Summer tree.result.data.run 与 nodes[] | path；本地属性目标还需 runId 和 instanceId→expectedInstanceId |
| describe 中 found 且 type 非 null 的描述 | read.properties 的 name/expectedType；candidate 不保证 getter 成功 |
| game_input.result.operationId 与请求 runId | wait_for_input 的同一对 ID |
| stop.result.data.runs[] | 每一项 runId 可分别用于 exited 等待；不能重新取 activeRunId 代替 |

填参入口随当前操作变化。只有具备该操作所需字段的结果才显示填参按钮。读取属性每批最多 16 项，选择超限时保留原参数和运行绑定。

## 6. 并发、取消与回放协调

只增加一个应用内交互互斥，owner 为 manual / replay / open-example。token 持有到 Promise 或完整回放 finally 结束；旧 finally 只能释放自己的 token。取消不提前放行。

- 手工一次只执行一项；play/stop/game_input 返回接纳后该次调用即结算，不把整个游戏生命周期锁住。
- 固定回放与手工执行/打开示例互斥。回放持锁包含原有收尾，不改其按捕获 attempt/run 退出的逻辑。只有用户显式启动回放时，才按既有打开项目/启动语义替换当前预览；其 finally 不追随后来 activeRunId。
- 检查并启动预览的等待超时后仍跟踪原 attempt。回放占用期间禁用各验证启动按钮，停止按钮可取消该次回放。
- 取消试玩或运行时写入验证时，收尾期间显示「正在取消」，收尾完成后显示「已取消」并恢复验证入口。实际退出以运行记录为准。
- 手工 pending 不禁用页面顶部“停止”。它是用户对当前预览的显式干预，原调用按 run_ended/unconfirmed 等真实结果结算；不因为停止而假装原调用已撤销。回放中该动作调用 abortReplay 后直接 return，仅由原 finally 按其捕获 ID 收尾，不再继续执行普通 global stop。手工 pending 时目录里的 engine.stop 不另开并发控制槽，用户使用顶部停止即可。
- 取消按钮仅针对真正接收 signal 的操作；check/game_input 不显示可撤销承诺。Summer 中只有 tree/inspect/set/screenshot 展示可取消请求；play/stop 不展示取消启动的泛化按钮。
- 不用 Promise.race 伪造终止。使用原方法的期限与 signal，未支持 timeoutMs 的 Summer input 不偷偷加该参数。未确认写入不自动重试。
- 切回代码不取消请求；项目切换/顶部运行仍是既有显式产品动作，调用台只更新过期状态。页面销毁时 abort 可取消请求、移除订阅、释放附件；不可取消的迟到返回不得更新已销毁 DOM。

## 7. 结果展示、历史与资源

调用器直接接收原始返回，生成一条用户历史；不把 subscribe 的内部 context/tree/describe/write 等记录平铺为多条用户操作。本期不做内部 trace 与用户调用的精确父子关联；现有 trace 保持为独立调试事实。

| API 事实 | 显示规则 |
| --- | --- |
| check ok=true | 只有 status=completed 且 error count=0 才称检查通过 |
| play accepted/pending | 显示“已接纳，待启动”；不能仅凭 status=done 显示运行成功 |
| wait ok=true | reached/timeout/no_session/exited_before_condition 分开显示 |
| 属性读 completed | 仍逐项保留 value/unavailable/not_attempted、stopReason；不称同帧事务快照 |
| 写回执 | applied/not_applied/not_written/outcome_unknown 保留各自事实，不自动重试 |
| 输入 operationId / 回执 | 接纳、down/up 分发和 partial/unconfirmed 分开；nativeConsumption 仍未确认 |
| stop | 显示 runs[] 各回执；no_target 不制造退出；正常退出需原 run 的后续事实 |
| thrown | 单独显示调用异常；不改写为 API ok=false 或“未执行” |

PNG 从 Summer reply.result.data 的真实 GameScreenshot 读取：bytes 是 ArrayBuffer，用 `new Blob([frame.bytes], {type: frame.mimeType})`。展示 PNG、尺寸、renderSerial、run/release 关联；JSON 将 bytes 明确替换为 `{kind:'ArrayBuffer',byteLength}`。复制按钮标“复制请求 / 复制结果摘要”，不承诺 JSON 含完整二进制。

应用默认预算固定为：input UTF-8 32 KiB、历史 20 项、单项结果展示 64 KiB、最多 4 个 PNG 且合计 20 MiB。原 API 本身的预算更小时服从原限制。结果文本截断明确标记，不改变操作结果。历史保存无二进制的有界投影；原始返回只在结算时临时处理，PNG 只由附件 Blob 持有，避免历史仍引用原 ArrayBuffer。淘汰、清空和销毁均 revokeObjectURL 并删除 Blob 引用。调用中不清空 pending 项，不将已淘汰项的迟到返回重新插入。

附件超数量或总字节预算时，先淘汰最旧附件，保留其元数据及“附件已释放”标记；单图大于总预算只保留元数据。UI 未保存图片不把真实截图调用改判失败。清空历史只作用于已结算项，pending 仍显示并正常结算。

切走或关闭卡片时释放其历史列表、请求回执、结果与附件视图。重新打开时从共享会话读取仍保留的记录。若仍展示同一条来源记录，恢复尚未应用的节点、属性或停止目标选择。清空或淘汰来源记录时释放对应选择。

调用台独立显示当前主运行的运行时观察、原生属性写入、公开属性访问、截图与输入能力。状态取自实际协商，可用、未就绪、不支持和待确认分别显示。调用继续由原 API 返回真实结果。请求和结果文本通过 textContent 展示，文本内容有变化时才替换节点，保留运行刷新期间的手动选区。

## 8. 两条手工教学流程

### A. Summer 位置修改

前提：显式打开现有标准属性样例，匹配的 Full/debug Worker/direct Chromium 预览可用。

1. get_project_context → play；保存原 attempt。
2. 用户手工 is_running 确认运行，或显式选择本地 wait_for_event。使用后者时标“Summer 读写主链 + 本地等待”，不再称全流程纯 Summer。
3. tree 取得实际 Player path → inspect 读取 position → screenshot 保存前图。
4. set position=`Vector2(192, 256)` → inspect 独立读回 → screenshot 观察白色标记位置。
5. stop 展示捕获 run 回执；若验证实际退出，逐个使用本地 wait_for_event(runId, exited)。

### B. 混合 API 的玩法参数

前提：同一样例具备 runtimeProperties ABI 1 和实际截图/输入能力。

1. check 完成且零类型错误 → play → 显式本地 wait 取得 run。
2. tree 选 Player → describe health(int)/move_step(float) → 显式 read，确认 100/64。
3. Summer set health=40 → 本地 read=40 → screenshot 看血条。
4. Summer set move_step=128 → 本地 read=128。
5. game_input ArrowDown → wait_for_input 完整 down/up；再 ArrowRight → wait_for_input；inspect position=(192,256) → screenshot。
6. stop → 对原 run 等待退出 → play → 用第二次返回的 attemptId 显式 wait(running)，确认 reached → 新 tree 重新选节点 → describe/read health、move_step，确认 100/64 → inspect position，确认 (64,256)。最后再次 stop → wait(exited)，完成收尾。

教学列表不自动断言画面与退出。真实自动验收另用脚本核对；原有 runtime-properties replay 继续承担严格验证，可能使用目录以外的 get_run/get_build/local stop 等方法，不能宣称全部由这 14 项构成。

## 9. 文件责任与并行工作包

| 包 | 单一文件责任 / 输出 | 可以立即开始 | 联调依赖 |
| --- | --- | --- | --- |
| A 目录与模板 | 新 summer-operation-spec.ts、workbench/api-console-catalog.ts、对应单测；负责 adapter 白名单迁移 | 是；按第4–5节固定字段 | 不等待其它包；导出交 B/C/E |
| B 调用状态与结果 | 新 workbench/api-console-types.ts、api-console-session.ts 及共享 fixture；draft/anchor、token互斥、历史、阶段解释、PNG预算和单测 | 是；第一项输出类型/fixture，可用受控 API | 实际目录接 A；与 D 交接上下文 hook |
| C 调用台视图 | 新 workbench/api-console.ts；textarea、参数/结果/历史/附件与组件测试 | 是；按本文 DTO fixture | 接 A/B；不得编辑 main/workbench/web 共享文件 |
| D 工作区与产品整合 | 独占 main.ts、workbench.ts、agent-panel.ts、web/index.html、现有样式文件；焦点/快捷键、小屏幕、示例打开、互斥与停止接线 | 是；先做模式/DOM/hook，保留真实API装配 | 最终接 A/B/C；不让多个包同时修改入口文件 |
| E 教学与验收脚本 | 教学预设数据及独立调用台浏览器脚本；README/操作文档 | 是；按第8节固定请求与报告形状 | UI 接 C/D；真实执行接 F |
| F 环境与基线 | 恢复匹配资产/站点、确认基线cleanup失败、保留本地报告 | 是；先盘点并恢复资产 | 不改A–E业务代码；真实候选需要D/E集成 |

### 9.1 固定的内部交接接口

不增加 window API。B 先物化下列应用内类型及一个包含正常、pending、陈旧目标、PNG 的 fixture；A 的目录、C 的静态布局、D 的模式/快捷键可同时推进，不必等待 B 实现完成。类型文件只做 type imports，目录调用函数继续使用 Parameters<PlaygroundApi[K]> 引用真实输入类型。

```ts
type ConsoleEnvironment = {
  anchor: ConsoleAnchor;
  activeRunState: RunnerState | null;
};
type ConsoleToken = symbol;
interface ConsoleGate {
  acquire(owner: 'manual' | 'replay' | 'open-example'): ConsoleToken | undefined;
  release(token: ConsoleToken): void;
  owner(): 'manual' | 'replay' | 'open-example' | null;
  subscribe(listener: () => void): () => void;
}
interface ConsoleHooks {
  readContext(): ConsoleEnvironment;
  subscribeContext(listener: () => void): () => void;
  openExample(): Promise<string>; // 完成项目切换/预览准备，返回 projectId；不play
}
type ConsoleFillSelection = {
  sourceCallId: string;
  nodePath?: string;
  propertyNames?: readonly string[];
  stoppedRunId?: string;
};
type ConsoleSnapshot = {
  operationId: string;
  draft: ConsoleDraft;
  environment: ConsoleEnvironment;
  owner: ReturnType<ConsoleGate['owner']>;
  history: readonly ConsoleCall[];
  clientError?: {kind: 'json' | 'stale_target' | 'wrong_project' | 'missing_source'; message: string};
};
interface ConsoleSession {
  snapshot(): ConsoleSnapshot;
  subscribe(listener: () => void): () => void;
  selectOperation(operationId: string): void;
  updateDraft(inputText: string): void;
  loadPreset(operationId: string, inputText: string): void;
  loadHistory(callId: string): void;
  updateTarget(source?: ConsoleFillSelection): void;
  submit(): Promise<void>;
  cancel(): void;
  openExample(): Promise<void>;
  getAttachment(id: string): {blob: Blob; metadata: Omit<GameScreenshot, 'bytes'>} | undefined;
  clearSettled(): void;
  dispose(): void;
}
```

D 从 recorder/runner 与 playIntent 组装不可变 ConsoleEnvironment；上下文订阅同时覆盖 recorder 变化，以及 playIntent 创建/取消/清除，不能依赖事件顺序碰巧触发刷新。状态能力只读既有事实，不新增运行管理系统。

B 注入同一个 gate 和上述 hooks；C 只消费 catalog、session 快照与方法，不访问 main 内部变量。B 拥有 Blob 引用，C 按 attachmentId 创建/释放 URL，附件淘汰后 C 删除相应 URL；dispose 同时释放各自所有权。E 的教学预设是有序目录项及参数示例数据，不另定义执行器。

回放接口只增加活动协调与 `abortReplay(): boolean`：有回放持锁时请求取消并返回 true（包括已在收尾状态）；顶部 Stop 据此直接 return。实际 lease 直到回放 finally 完成才释放。原有 run/attempt 清理所有权不迁入 session。

合入/联调顺序：A → B/C 并行落地 → D 集成 → E 受控与真实入口。F 从第一天独立恢复基线资产，待 D 集成后构建匹配站点，供 E 的真实专项消费；不等 E 完成才开始准备。所有包可同时开始各自独立部分，不等于最终联调可以无序进行。

## 10. 验收合同与开工环境

| 层次 | 必须验证 | 通过代表什么 |
| --- | --- | --- |
| 目录/调用器单测 | 8+6准确集合、原API映射、JSON拒绝零调用、陈旧anchor、历史恢复不执行、token finally、阶段投影与附件回收 | 应用合同正确，不证明引擎执行 |
| 受控浏览器 | 代码/API切换、文件/诊断跳转、Ctrl/Cmd+Enter单次路由、小屏不隐藏、14项入口、截图显示、并发/取消/停止及旧结果归属 | UI与接线正确；报告 engineExecuted=false |
| 真实 Chromium | 页面完成A/B两条主链、实际读回与PNG、stop/restart初值、旧run本地请求拒绝、原属性回放回归 | 报告 engineExecuted=true，绑定真实run与匹配release |

真实范围限 Full/debug + Dedicated Worker/direct + Chromium；本期不以完整浏览器/设备矩阵、性能预算或完整 Summer wire 黄金样例为前置。真实验收记录候选/release、运行身份、请求与读回、PNG及退出事实；状态采样与PNG分别计数，不称同帧证据。

现有本地命令继续可用：

```sh
export PATH="/workspace/.godotai-tools/node_modules/.bin:$PATH"
pnpm --filter @godot-js/playground typecheck
node --test apps/playground/scripts/summer-adapter.test.mjs \
  apps/playground/scripts/playground-api.test.mjs \
  apps/playground/scripts/runtime-properties-demo.test.mjs
pnpm --filter @godot-js/playground test:browser:debug-panel
```

实现时新增调用台专用单测和浏览器入口，不能把上面现有命令的通过当作新调用台已经通过。开发完成再运行相关包测试和真实专项；不用重复无关发行矩阵。

开工时环境盘点：只有既有原生 QuickJS SDK，未找到匹配 Web WASM、engine report、完整站点或 Emscripten 工具链。V2 设计末尾记载的 .godotai-sites/.godotai-artifacts 当时不在本机；历史验收不是可直接执行的资产。本轮恢复结果见第 11 节。[历史交付记录](runtime-properties-and-summer-api-v2.zh-CN.md#十五-实施记录2026-年-11-月-22-日)

前轮全套检查留下两项 cleanup 标记缺失（project-tools native-startup、Playground production React bootstrap）；本轮不把它们称已修复，也不据此判定本调用台方案不可开发。F 需确认匹配引擎下的基线并处理或保留明确阻塞，不能放宽测试掩盖。当前已有的受控面板/类型/专项检查只支撑应用层开发准备。

最终判定：**设计与实现可全面开工；受控联调随模块集成推进；真实 Web 验收须先恢复匹配资产，现阶段不得宣称端到端完成。**

## 11. 实施记录（2026 年 11 月 23 日）

本节记录实施进展；第 10 节的缺资产与 cleanup 状态为开工时盘点，最终交付以本节为准。

14 项目录、单一 Summer spec、独立 input 编辑区、逐操作草稿、运行目标检查、结构化结果填参、有界历史与 PNG、代码/API 切换、快捷键、回放互斥及两条教学流程均已落地。未新增公共引擎 API 或原生 ABI。

| 检查 | 结果与证据 |
| --- | --- |
| 固定工具版本 | Node 24.15.0、pnpm 10.11.0；Chromium 154.0.8037.57 |
| engine / project-tools | 143/143、123/123 通过；`/workspace/.godotai-logs/api-console-engine-tests.log` |
| Playground | 类型检查及 433/433 通过；`/workspace/.godotai-logs/api-console-playground-tests.log` |
| 调用台受控浏览器 | 5/5 通过，engineExecuted=false；`/workspace/.godotai-logs/api-console-controlled/report.json` |
| 真实 main 壳集成 | 7/7 通过，未替换 main/Compiler Worker，engineExecuted=false；`/workspace/.godotai-logs/api-console-shell/report.json` |
| 原调试面板与取消协调 | 通过；`/tmp/api-console-review-debug-panel.log` |
| 原生 cleanup 基线 | 正式 prepare-native-engine 补丁应用到外部 SDK 并重编译后，两项专项均通过；`/workspace/.godotai-logs/api-console-native-cleanup-checks.log`，未放宽断言 |
| 真实 Web 调用台 | 4/4 通过，engineExecuted=true；`/workspace/.godotai-logs/api-console-real/report.json` |
| 匹配 Web 模板 | Full/debug、Godot 4.6.1、Emscripten 4.0.11，built/sourceCertified；实际 WASM SHA-256 为 `33388ad635a1bddd5b5b5f830822d236cc8ae40a9ff13c714d64dd0523d6da9f` |
| 完整站点与便携模板 | `/workspace/.godotai-sites/api-console`；`/workspace/.godotai-artifacts/api-console-engine` 已创建并独立 verify |

真实验收经页面执行全部 14 项操作，验证位置写入与独立读回、health/move_step 修改、输入完整边沿、同源码重启初值恢复、旧 run 拒绝，以及原严格属性回放。保存 4 张实际 PNG，记录 5 个真实 Worker session；3 个手工 run 的 sourceHash 相同，各自确认 host-report、nativeExit.code=0、hostCleanup=complete。受控报告仍保留 engineExecuted=false，没有升级为真实引擎证据。

初次验收的 releaseId 为 `4cf98f639012f62a175fcd1c3c57c6244e1a36a86d0365e2d0953846e132b463`，candidateId 为 `a5f56aaa6b0a568a39c2df297f17abd96a5415b8628d63210c252ca0a2d7038f`。工具链与资源恢复见 `/workspace/.godotai-logs/api-console-environment.json`。

演示入口为 `http://localhost:4173/` → 左栏 **API 调用** → 选择 API → **打开独立示例** → 修改参数或选取教学步骤后执行。调用台不自动执行预设；截图、输入与重启均保持实际 API 语义。重启本机演示可运行：

```sh
cd /workspace/GodotAI
PLAYGROUND_DIRECTORY=/workspace/.godotai-sites/api-console PORT=4173 \
  /workspace/.godotai-tools/node-24.15.0/node-v24.15.0-linux-x64/bin/node \
  apps/playground/scripts/serve.mjs
```

本期 A–F 全部完成。范围仍是已声明的 Summer 输入子集与 GodotAI 本地结果，不声称完整 Summer wire 兼容或同帧 probe。

### 实现审查后的修复

结构化填参复用引擎的运行身份校验，接受真实 Worker 的字符串 `generation`。教学步骤只覆盖部分参数时保留草稿的原运行绑定，仍需显式更新目标才能提交旧草稿。自动验证在检查期间即可通过顶部或面板停止，检查结算后释放互斥，取消后跳过构建。浏览器将页面保存在往返缓存时，保留调用台草稿、历史和订阅，页面实际销毁时清理资源。

Playground 类型检查与 433 项测试全通过。受控调用台 5/5、真实主应用壳 8/8、真实 WASM 5/5 通过。真实 WASM 脚本使用节点树和属性结果填参，检查重启后的教学步骤仍受旧草稿保护，并验证无活动运行时可取消自动检查。主应用壳覆盖从浏览器往返缓存恢复后继续执行请求。

首次修复后的候选为 `55d33c658b4a0d37c319cf200fcceec92f915debc8662472e3dda3973ed3887e`，报告保存在 `/workspace/.godotai-logs/api-console-fixes/`。

### 全量评审后的修复

退出等待的上下文填参保留显式目标；等待启动才会自动选中待启动 attempt。长按执行快捷键只提交一次。回放超时后继续跟踪原 attempt，期间可以停止，跟踪结束后恢复启动按钮。原真实调试验收改从「自动验证」进入回放，浏览器后退测试改用带图标声明的测试页面，保留草稿、历史、后续调用和零控制台错误断言。

Playground 类型检查与 434 项测试通过。受控调用台 5/5、真实主应用壳 8/8、调用台真实 WASM 5/5、原调试 API 真实 WASM 21/21 通过，原受控调试面板也通过。本轮候选为 `f37dd2a2e05b548606c904cee07932c436dd7f71ec9242197d2e90fd17c5fa04`，报告保存在 `/workspace/.godotai-logs/api-console-review-fixes/`。

### 方案对照后的修复

调用台显示当前运行实际协商的能力状态，按当前操作提供对应的结果填参。属性读取填参保留 SDK 的 16 项上限。基础回放占用期间禁用其它验证入口，直到收尾结束。请求和结果文本内容有变化时才更新，运行日志刷新期间保留选区。

Playground 类型检查与 435 项测试通过。受控调用台 6/6、主应用壳 8/8、调用台真实 WASM 5/5、原调试 API 真实 WASM 21/21 通过，原受控调试面板也通过。真实 Direct 和 Bitmap 用例核对各自的能力提示。额外真实项目枚举出 25 项可选属性，选择 17 项时保留草稿，减至 16 项后读回全部值。该运行连续发出四条日志时，选中的结果文本保持完整。

本轮候选 `87177fe0fefa67a0f5692ae414ab1dbe7c350a2290a7cf6bbed99aa93d1c527d` 通过启动和截图冒烟验证，报告保存在 `/workspace/.godotai-logs/api-console-contract-fixes/`。

### 取消终态与最终验收

试玩验证和运行时写入验证完成取消收尾后会显示「已取消」，释放互斥并恢复验证入口。真实站点的新增停止用例确认了取消终态，并验证迟到的构建跳过预览。

该轮构建候选为 `f7663bcfa7ba3aa0010a761af3236c10f41de759944eb8c9b452e1e167e8b914`。Playground 类型检查和 435 项单测通过，受控调用台 6/6、主应用壳 8/8、调用台真实 WASM 5/5、调试 API 真实 WASM 22/22 通过。报告和 PNG 校验值已绑定到该候选。

### API 列表与独立标签

左栏 14 条 API 简介均在桌面单行显示。浏览器用例覆盖标签去重、关闭和重开、独立草稿与结果、跨标签载入、切走后取消，以及从移动端抽屉打开调用卡。回归还验证了同一来源的填参选择与操作限制能够恢复、切换标签后快捷键只在参数框内执行、清空历史时释放隐藏卡片视图并保留在途请求。

构建候选为 `f317400f7cdb660e5630721cbb8b6e11dfa636cce3029270c7902ed676821180`。Playground 类型检查和 435 项单测通过，受控调用台 7/7、主应用壳 8/8、调用台真实 WASM 5/5、调试 API 真实 WASM 22/22 通过。延迟加载项目目录的用例验证了初始化后仍可用方向键切换标签。[机器可读验收摘要](../verification/playground-api-console.json)
