# Playground 首期 API 文档与运行调试

首期实现与验收。代码基线 `e942c1e`。

## 交付目标

首期在 Playground 交付 API 文档和只读调试。开发者使用现有按钮运行和停止项目，通过「API 调试」页签查看实际构建、运行阶段、日志和退出事实。API 文档提供可执行示例。页面、DevTools 和浏览器测试消费同一组只读查询。项目源码读写由 Agent 已有工具处理。

首期以 Summer Engine 的「先诊断，再按范围查证据」为参照。对齐 `engine.get_project_context` 的上下文入口，`engine.get_diagnostics` 与 `engine.get_script_errors` 的结构化诊断，以及 `engine.get_console` 与 `engine.recent_events` 的日志过滤和事件游标。Playground 合同使用 GodotAI 的发布、构建和运行身份。方法名和传输兼容由实际接入需求决定。首期只读数据位于当前工作台页面，后续的图像采样、输入和外部传输按各自的接入需求推进。 [引擎目标](../engine-goals.zh-CN.md#通用设计原则) · [Summer 操作参考](https://docs.summerengine.com/mcp/operations/engine) · [Summer 调试流程](https://docs.summerengine.com/mcp/building-a-game#debugging-workflow)

## 三个子会话的评审结论

| 评审方向 | 纳入方案的决策 |
| --- | --- |
| API 和执行语义 | 预览关联必须活到首个运行事件或异步请求结算。固定查询空值、诊断可用性、运行引用的构建记录以及事件过滤和省略的返回形状。 |
| Playground 接入 | 已在真实站点验证目标拒绝夹具。补全启动日志标记、宿主失联前台条件、可执行文档样例和独立的调试产品回归入口。 |
| 环境与验收 | 单独跟踪项目命令往返的间歇失败、独立准入捕获参数和 React 关闭进度。保留失败与复跑通过的报告，应用工作可并行。 |

## 四项查询

应用提供版本化、可 JSON 序列化的只读 DTO。工作台顶层页面通过 `window.godotPlayground` 提供这些查询，`schemaVersion` 为 `1`。[完整 API](playground-agent-api-p0.zh-CN.md#agent-工具合同)查询同步读当前快照。成功返回 `{ok: true, result}`，参数错误、无可用记录和无效游标返回 `{ok: false, error: {code, message}}`，代码分别为 `invalid_input`、`not_found` 和 `invalid_cursor`。一次失败构建的详情仍是查询成功，编译失败由记录的状态表达。

| 方法 | 返回内容 |
| --- | --- |
| `get_project_context()` | 始终可读取页面快照。返回 `projectId` 和 `editorRevision`、已验证的 release/profile、已配对的后端和呈现配置。发布和预览可用性分别表示加载中、可用、失败或不支持，失败时附可用的诊断。提供 `latestBuildAttemptId`、`activeRunId` 和 `lastExitedRunId`。 |
| `get_build({attemptId})` | 项目 ID、提交时的编辑版本、构建状态、诊断、产物和 `preview`。按实际回执提供 `sourceHash`、编译事实与编译环境身份。产物生成后提供 `buildKey`、`artifactId` 和 `single-pack` / `pack-set`。会话创建后 `preview.runId` 指向该运行，准备被拒绝时 `preview.error` 给出已知阶段和诊断。 |
| `get_run({runId})` | 完整 Worker 运行身份、可查询的 `attemptId`、当次产物和发布配置、最新运行阶段。已结算时附 `exit: {evidence, report}`，`evidence` 为 `host-report` 或 `editor-local`。`report` 保留对应来源提供的退出原因、诊断、`engineOutcome`、`hostCleanup` 和 `SessionFacts`。 |
| `read_run_events({runId, after?, limit?, kinds?, levels?})` | 按页面接收顺序读取 `state`、`log`、`project` 和 `exit` 事件。支持 `after`、`limit`、`kinds`、`levels`。返回 `items`、`nextCursor`、`oldestAvailableSeq`、`hasMore` 和可选 `gap`。 |

查询指针的范围固定。`latestBuildAttemptId` 取当前项目按发起顺序的最新保留记录。`activeRunId` 和 `lastExitedRunId` 取当前页面预览容器，切换项目时可能指向上一项目。未建立的项目、编辑版本和三个 ID 指针为 `null`，非空指针均指向可查记录。旧构建里的 `preview.runId` 是历史事实，运行淘汰后返回 `not_found`。预览初始化失败归到可用性，最新构建的准备拒绝直接由 `get_build({attemptId: latestBuildAttemptId})` 读取。

站点后端和呈现方式从已配对的预览适配器取得。Web 模板报告的 `executionModel: window` 可对应实际产品的 Dedicated Worker 执行。类型首批交付覆盖加载中、shell-only、初始化失败、宿主终态和页面兜底五种可序列化样例。 [产品适配](../../apps/playground/src/engine-preview.ts#L26-L58)

工作台资源加载失败且预览尚未启动时，`preview` 返回 `unsupported` 和原因。控制台显示实际的加载错误。

诊断使用同一结构。列表计数表达实际收到的错误、警告和信息条数，`omittedCount` 记录列表中被省略的条数，单项正文裁剪使用 `omitted`。

```ts
type DebugDiagnostic = {
  severity: 'error' | 'warning' | 'info'
  message?: string
  code?: string | number
  location?: {file?: string; line?: number; column?: number}
  omitted?: true
}

type DebugDiagnostics = {
  observed: boolean
  counts?: {error: number; warning: number; info: number}
  items: DebugDiagnostic[]
  omittedCount: number
}
```

已收到的有效空诊断列表使用 `observed: true` 和零计数。取消回执附带的空数组、通信失败和其他未收到诊断列表的情形使用 `observed: false`。准备、通信等错误由 `{ stage, diagnostic }` 表达，阶段采用已知执行边界。已知错误码通过 `diagnostic.code` 返回，诊断消息保留原文。原始运行诊断随退出报告保留。

所需事实已有生产来源。环境来自已校验的 release，构建数据来自编译 Worker 的结构化响应，运行数据来自 Dedicated Worker runner 的事件和退出回执。调试读取通过应用内记录获得数据。任何为了补字段而额外发出的编译 Worker 请求都可能导致正在进行的构建失效。 [交付记录](../engine-minimum-contracts-delivery.zh-CN.md#已落地的接入链) · [编译请求与回执](../../apps/playground/src/compiler.worker.ts#L32-L123) · [Worker 事件类型](../../packages/engine/src/browser/dedicated/worker-runner.ts#L21-L38)

### 构建、预览和退出

- 在 `rpc('compile')` 前分配 `attemptId` 并捕获项目 ID、编辑版本。构建状态为 `pending`、`succeeded`、`failed` 或 `cancelled`。以工作台收到的已结算响应记录构建。有效产物回执标记成功，Worker 明确取消才标记取消，RPC 拒绝则记录工作台请求失败及其阶段。RPC 包括快照 pin 的释放，发生拒绝时 Worker 是否完成可能未观测。先结算原尝试，再由现有 `runSerial` 和 revision 决定是否继续预览。 [现有 RPC 结算](../../apps/playground/src/compiler-worker-client.ts#L32-L48)
- 首期记录现有生产构建，包括通过「运行」及打开项目时自动发起的 checked build。后台类型检查和补全沿用现有问题面板。诊断保留真实的文件、行列、错误码和严重级别。通信、资源和发布错误记录可观测的阶段与来源，Worker 的占位位置和错误码按未知显示。缺少诊断时显示未知，计数描述实际收到的诊断。
- `preview.status` 初值为 `not-requested`。构建成功且被选中用于预览时，在工作台校验 manifest 前进入 `preparing`。成功构建在发起预览之前被工作台弃用，或已进入准备且在创建会话前被 runner 确认撤销时，标为 `skipped`。已发生的校验或加载失败标为 `rejected`。更新的运行意图可能先进入编译，之前仍在准备的预览应按它实际创建会话或拒绝的结果结算。
- 产品运行路径由预览适配层统一分配 `generation`，在第一次异步准备前登记它和尝试、`buildKey`、revision 的关联。关联保留到首个 `loading-frame` 完成移交，或 `await runner.run(...)` 实际结算。适配器的 `finally` 围绕实际异步结算执行。原始事件先绑定新 `runId`，再进入时间线，构建预览状态转为 `session-created`。后续按完整运行身份接收。运行事件在工作台的 revision 过滤前记录。兼容预览路径在 `get_project_context()` 标记预览调试不支持，构建详情的 `preview` 可缺省。Shell-only 提供环境与空态。编译 RPC 的 `documentId` 属于项目，runner 的同名字段属于本次预览文档。
- 准备拒绝只结算本次准备，之前的活跃预览可以继续运行。已经创建会话的启动失败和迟到的旧会话退出归到各自的 `runId`，只从 runner 的 `exit` 事件结算。收到 `state: exited` 仍从同次结算的 `exit` 取得报告。
- `running` 表示引擎达到启动合同的阶段。项目就绪、首帧和业务事件分别使用相应的观测。日志中的 `error` 级别表达日志严重程度。致命故障、原生退出和清理分别取自结构化的退出事实。页面兜底退出时，未观测的原生字段保持缺失。

[工作台运行入口](../../apps/playground/src/main.ts#L150-L192) · [预览准备和关联移交](../../apps/playground/src/engine-preview.ts#L63-L81) · [运行事件与终态合同](engine-minimum-contracts-v4.zh-CN.md#合同四-运行事件与终态)

### 事件与保留

- 记录存在当前标签页内存。保留最近 16 个构建、活跃运行和最近两次已结束运行。运行引用额外保留至多三个构建。尚可能创建会话的预览调用保留同一份受限构建投影，即使该构建已落出最近 16 条。首条运行事件接管投影，调用结算释放临时关联。构建详情在移交后仍具备原诊断和产物字段。已淘汰的普通回执继续由产品处理，调试查询中按 `not_found` 结算。
- 每个构建的诊断正文最多 100 条和 64 KiB UTF-8，同时保留已收到的各级别计数、已知省略数和诊断可用状态。一条过大诊断保留可用的位置、错误码和省略标记。每个运行的事件缓冲按 500 条和 256 KiB UTF-8 保留，超大事件保留小型替代记录和原序号。当前运行阶段和终态独立保留，事件淘汰后仍可查询。预算按投影字节计算，涵盖嵌套文本和错误字段。
- 事件按每次运行的页面接收顺序从 `seq: 1` 起编号，条目采用 `{seq, event}`，`event.type` 保留既有分类。超大事件的 `event` 保留 `type` 和 `omitted: true`，区别于整段事件淘汰的 `gap`。启动时的项目事件可能在引擎进入 `running` 后成批到达。游标绑定页面与 `runId`。查询默认 50 条，`limit` 接受 1 至 100 的整数。`levels` 只筛选日志，其余事件由 `kinds` 决定。
- 首次读取的逻辑位置为序号 0。每次查询以调用开始时的最大序号为读取高水位，游标前进至最后扫描的记录，包含被筛掉的项。缓冲为空时 `oldestAvailableSeq` 为 `null`，返回的游标仍可继续使用。扫描到高水位时 `hasMore: false`，活跃运行可以继续用同一游标读取。跨页面、跨运行及超前游标返回 `invalid_cursor`。若应用已淘汰游标之后的前缀，返回 `gap: {fromSeq, toSeq}` 并从最早保留项继续，首读同样报告已知缺口。上游预算的丢弃范围按未知处理。
- 日志保留 `level`、`text` 和 `untrusted`。来源明确到预览 Worker，项目事件标为项目自报。数据通过纯文本和 JSON 渲染，对外返回字段白名单的快照副本。首期记录只含调试所需的元数据、诊断和事件。

[现有日志配额](../../packages/engine/src/browser/dedicated/worker-log.ts) · [运行事件投递](../../packages/engine/src/browser/dedicated/worker-runner.ts#L183-L213)

## 调试面板与文档

在工作台现有 Dock 增加「API 调试」。最新构建和当前运行分别展示，默认日志跟随活跃运行，结束后显示最近终态。预览准备失败时，旧活跃运行的卡片显示其关联构建，可读诊断并展开 JSON，日志继续按原 `runId` 读取。提供近期终态的直接跳转。日志可按级别筛选，构建和运行可展开 JSON，加载、空记录、过期引用和保留缺口有明确状态。选中的历史运行淘汰时，面板清除该运行的日志并显示过期提示。调试页已选中时就地显示该页可见记录中的新错误和诊断。其他工作台错误打开控制台。Dock 保留现有页签键盘导航和紧凑布局。

API 文档逐项说明参数、字段、缺失值和使用范围。正文、复制和执行引用同一份内置示例，Playwright 读取页面展示的示例并在工作台顶层执行。执行按钮运行对应的预定义只读查询，示例和运行按钮各自有明确入口。首期摘要在面板和文档示例里由四项查询组合。 [现有 Dock 与页面布局](../../apps/playground/web/index.html) · [页签和键盘交互](../../apps/playground/src/workbench/workbench.ts)

```js
const api = window.godotPlayground;
const { result: context } = api.get_project_context();
const runId = context.activeRunId ?? context.lastExitedRunId;
if (context.latestBuildAttemptId) console.log(api.get_build({attemptId: context.latestBuildAttemptId}));
if (runId) {
  console.log(api.get_run({runId}));
  console.log(api.read_run_events({runId, kinds: ["log"], limit: 30}));
}
```

## 工作包与开工顺序

| 工作包 | 改动位置和交付 | 开工条件 |
| --- | --- | --- |
| A 查询合同与内存记录 | 在 Playground 应用层提供四查询类型、状态样例及纯记录层，覆盖同 revision 重跑、过滤空页、跨运行游标、淘汰和终态保留。 | 立即开工，优先交付可供其他任务直接引用的类型和样例。 |
| B 采集与页面接入 | 负责 `main.ts` 和 `engine-preview.ts` 的接缝与公共查询对象挂载。在 UI 投影前采集，处理编译通信错误、迟到响应、准备拒绝和实际退出。 | A 的类型约定就绪后开工，独立验证采集接缝。 |
| C API 文档与调试页签 | 负责 `web/index.html`、Dock 页签、独立调试面板和文档示例。消费 A 的查询对象，由 B 接入入口。 | 用 A 的受控记录与 B 并行，先验收渲染、空态和键盘交互。 |
| D 浏览器样例与断言 | 新增 `browser-debug-api-test.mjs` 和 `test:browser:debug-api`，报告路径由 `PLAYGROUND_DEBUG_API_REPORT` 指定。复用双 origin、Schema 4 项目与被动运行观察。 | 用例脚手架可立即开工，端到端验收使用 A–C 的实现和匹配站点。 |
| E 产品基线与独立准入 | E1 维护匹配站点，诊断项目命令往返并复跑核心合同。E2 修复 profile gate，验证双命名捕获和原生/React 四用例。 | E1 和 E2 并行。E1 如需修改 `main.ts`，由 B 的接入负责人一并处理。若修复触及 SDK，重建匹配站点后复验。 |

## 验收

用记录层单测验证窄窗口、顺序和淘汰，以受控 DTO 验证错误显示，以 shell-only 验收空态、页签键盘交互和字面文档示例。真实产品验收使用 Chromium 和 `full-engine-v1/template_debug`、Dedicated Worker/direct 站点，从正常产品页面触发构建和运行。导入 fixture 会自动运行，先等待这次尝试结算，再触发有独立断言的「运行」。从公开 API 读取被测结果，从协议和 Worker 的被动观察独立核对运行身份、日志和回执。

| 场景 | 通过条件 |
| --- | --- |
| 类型错误 | 最近构建可查到失败及源码诊断，该次构建没有产物或新运行。 |
| 预览准备拒绝 | 先运行带 `print()` 的 Schema 4 fixture。Playwright 在下一次真实编译的成功回执被产品监听前，仅替换 `manifest.engineId` 为另一有效格式的值。保留发布上下文和产物字节。该次构建成功，准备收到 `E_RUNTIME_TARGET_ENGINE`，没有新 `runId`，原运行保持活跃且没有新增退出记录。原运行及日志可按原 ID 读取。 |
| 创建会话后启动异常 | 在 Schema 4 的异步 `start(ctx)` 中先发出可识别的原生 `print()`，再抛出异常。经同一个 `runId` 关联构建、日志和实际退出，按收到的事件核对已到达的阶段与确定的退出事实。 |
| 正常运行、停止、同输入再运行 | 读到实际 Worker `print()`，正常停止只有一条退出记录，并有真实原生退出与清理事实。两次尝试和运行身份各自独立。 |
| 编辑后重新运行并取消启动 | 原运行退出后，仍可用「停止」取消尚在握手的新运行。终态关联到新 `runId`，页面报告预览已回收。 |
| 工作台示例目录加载失败 | 模拟目录返回 HTTP 503。已验证的引擎发布仍可读取，预览标为不可用，控制台显示目录加载错误。 |
| 预览宿主失联 | 保持工作台在前台并核对页面可见，再移除活动预览 iframe，等待 watchdog。可查到页面兜底终态，未收到的原生退出和清理字段为空。 |
| 并发与保留边界 | 在采集层受控测试中让 A 进入异步预览准备，B 开始编译，继续插入记录让 A 退出最近构建窗口，再交付 A 的首个会话事件。A 的运行仍可查到完整构建，最新构建按发起顺序更新。另覆盖同步和异步拒绝、调用撤销、游标缺口和筛选空页。采集层测试直接控制准备过程，避开产品运行按钮的等待状态。 |

在新产品用例中复用双 origin 运行和报告代码。正例、准备拒绝、启动异常和宿主失联使用独立 browser context。合法没有会话的负例由新报告按操作预期判定。报告记录 profile、releaseId、descriptorHash、candidateId、运行身份和 `engineExecuted`。原有 `test:browser:contracts` 继续上报自己的五组核心合同。 [Schema 4 产品测试](../../apps/playground/scripts/browser-schema4-flow-test.mjs) · [真实 Worker 回执注入原型](../../apps/playground/scripts/browser-resource-converters-test.mjs#L138-L144) · [运行终态观察](../../apps/playground/scripts/browser-runtime-host-test.mjs#L66-L79) · [核心回归入口](../engine-minimum-contracts-delivery.zh-CN.md#构建与回归入口)

### E1 项目命令往返

以同一候选站点重跑 `lifecycle` 和核心合同，在失败步骤内保留关联的运行 ID、工作台本地命令受理结果、编辑器和宿主的命令序号、匹配回执、项目同步与异步事件及当前 revision/generation。派发回执确认通道处理进度，业务接收由项目事件确认。使用旧站点的无返回值命令入口时，由匹配的同步与异步项目回包证明往返。停止回执随同一次命令记录保存。复验覆盖该组单跑和整套顺序，出现失败时用同一批证据定位在哪一层中断。 [工作台命令派发](../../apps/playground/src/main.ts#L49) · [核心生命周期步骤与失败收集](../../apps/playground/scripts/browser-runtime-host-test.mjs#L330)

### E2 独立准入

本地运行 `browser-engine-profile-gate.mjs` 时通过 `--engine-report` 传入同一个原生构建报告。准入脚本启动 Chromium 前用 `executionFromReport` 核对 profile 及实际 JS、WASM 和两份 worklet 与报告中的资产摘要，再将保留 `hostResourceAbi` 的完整执行配置传给 snake 和 camel API 捕获。`window` 执行的 `workerAssets` 可以为空，四份模板资产应单独核对。生产站点使用实际导出后的 `exportedExecution`。

独立准入还包含原生和 React 各两种命名的四个实际运行用例。React fixture 在有界的引擎帧内等待真实引用和属性提交，检查信号和更新。关闭时逐帧调用 `getCloseProgress()` 推进已释放节点的回收，等 `close()` 报告完成、待释放数和原生子节点数均为零，再启动下一棵树并再次验证清理。报告逐项记录两次 API 捕获和四次真实运行。前置失败时注明后续哪些用例阻塞。 [准入 fixture 与矩阵](../../apps/playground/scripts/browser-engine-profile-gate.mjs#L19-L111) · [React 关闭与进度查询](../../scripts/jsb.react/src/engine.ts#L1128-L1161)

## 评审基线与验收条件

合并验收要求新调试用例通过、核心合同五组通过、本地独立准入两次捕获和四次真实运行通过。发布按现有设备、呈现和批准门禁执行。 [现有交付](../engine-minimum-contracts-delivery.zh-CN.md) · [浏览器发布门槛](../browser-worker-runtime.zh-CN.md#能力-ledger-与-go-gates)

- 已将当前提交和上一版交付使用的两个 full/debug 候选 ZIP 下载到评审临时目录，分别核对 GitHub 摘要，并对内部 portable 模板、原始报告和证明运行 `package-browser-engine-artifact.mjs --verify`，均通过。当前提交的候选包提供可信模板和诊断记录。 [当前候选](https://github.com/linfaxin/GodotAI/actions/runs/44233390118/artifacts/14397399010) · [交付使用的候选](https://github.com/linfaxin/GodotAI/actions/runs/44046900983/artifacts/14314188455)
- 当前提交 CI 的 full/debug 准入在 `captureEngineApi` 等待退出时超时，默认产品站点随后未生成。合同汇总因缺少 `manifest.json` 在 preflight 处阻塞，五组均未执行到真实引擎。 [CI 工作日志](https://github.com/linfaxin/GodotAI/actions/runs/44233390118/job/134565383006)
- 评审时使用 Chromium 154 在两个模板上复现了未传执行配置时的退出超时。原独立准入 fixture 在 React snake 的首次渲染处失败。评审原型等待实际提交后，React snake 通过渲染、信号和更新，关闭阶段超时。加入关闭进度查询后，评审原型通过两次 API 捕获和四次真实运行，保留报告 `round3/profile-combined/gate.json`。 [独立准入实现](../../apps/playground/scripts/browser-engine-profile-gate.mjs#L205)
- 以校验过 SHA-256 和官方 SHA-512 的 Godot 4.6.1 完成资源导入、Web 导出和产品构建。构建使用仓库指定的 Node 24.15.0 和 pnpm 10.11.0，通过实际导出字节的双命名 API 捕获，生成 source-certified 的 full/debug 站点，releaseId 为 `0e5d86d8a65c446b54c55ed2426ada42ba5c65b097b9b4ced167bda7a882ed42`。评审工作区站点位于 `/workspace/scratch/playground-debug-review/product-site-e942`。 [构建入口](../../apps/playground/README.md#build-and-run)
- 同一站点的 Schema 4 专项通过，`engineExecuted: true`。以真实 Worker/direct 执行 `start(ctx)` 并读取原生打印，使用工作台停止，观测到 `clean-exit`、原生退出码 0、入口和宿主清理完成。真实编译回执注入异引擎身份时，产品返回 `E_RUNTIME_TARGET_ENGINE`，原 iframe 和 runId 保持活跃。
- 评审阶段整套核心合同为 4/5 组通过。`lifecycle` 的命令往返失败，后续 stop-restart 步骤阻塞。同一候选的两次独立生命周期复跑均通过，包括一次使用原脚本和一次附加旁路观察。两次复跑都使用 40 秒步骤等待。评审报告包括 `product-contracts-e942.json` 和 `round3/lifecycle-isolated-original.json`。
- 现有 Chromium shell 回归已通过。此前本机 headless 普通脚本和 React 各有一个退出清理断言失败，作为独立基线问题保留。真实浏览器结果按该站点的实际回执记录。

## 实现验收

在 `e942c1e` 的经过校验的 full/debug 模板上刷新前端，以 Node 24.15.0、pnpm 10.11.0、Chromium 154 验收 Dedicated Worker/direct。实际产品候选为 `a6e4235371096633f9e6aa768922a528ef4616a02de7ca6387218587b5a817fe`。前端刷新保留同一引擎发布 ID，浏览器报告按刷新后的候选身份核对站点字节。

| 验收项 | 本地结果 |
| --- | --- |
| API 记录层和相邻回归 | Playground 类型检查和 49 项定向回归通过。覆盖诊断预算、构建淘汰与运行关联、游标和预览准备竞态。 |
| API 调试面板 | 受控 Chromium UI、实际 shell 回归和 6 项 shell 构建测试通过。验证键盘选页、错误原地展示、日志纯文本、缺口、窄屏和复制与执行。 |
| 调试 API 真实浏览器 | 五个场景全部通过。验证构建产物和原始 Worker 配置、日志、停止重启、类型诊断、准备拒绝、启动异常和宿主失联。 |
| 核心真实浏览器合同 | 五组全部通过。`normal-host-roundtrip` 和 `stop-restart` 各确认命令受理、同步与异步项目回包、退出码 0、入口和宿主清理完成。生命周期单跑也通过。 |
| 独立引擎准入 | 已走正式 CLI。snake 和 camel 均捕获 902 个类，原生/React 四组全部退出码 0，两个 React 用例各两次收到 `complete`、零待释放和零原生子节点的关闭结果。 |

本地并发测试期间曾出现原生终止回执超时，报告显示项目命令和两个业务回包已完成。串行复验收到了完整原生退出回执，间歇超时的原因尚未确认。工作区报告分别为 `/workspace/scratch/playground-debug-implementation/contracts.json`、`contracts-final.json` 和 `debug-api-final.json`。独立准入报告为 `/workspace/scratch/playground-debug-review/e2-implementation-full-final/gate.json`。

完整 Playground 本机测试为 372/373 通过。剩余的历史失败为 headless React fixture 缺少 `ENGINE_PROJECT_REACT_CLEANUP` 标记，记录在 `unit-final.log`。 [本机 fixture](../../apps/playground/scripts/engine-project.test.mjs#L349)

验收表记录工作区的本地运行结果。受控 UI、真实产品调试 API 回归和独立引擎准入均可在本地复跑。[本地构建与回归入口](../engine-minimum-contracts-delivery.zh-CN.md#构建与回归入口)

复核修正后的候选 `33537e082349ef9e3da3392091c96e9114b45b39f24ab4667b371acddb08ee12` 通过调试 API 五个场景和核心合同五组。真实预览拒绝用例核对 `diagnostic.code`、原运行和关联构建 JSON，受控 Chromium 用例核对淘汰后清除日志和恢复当前运行。工作区报告位于 `/workspace/scratch/playground-debug-audit-fix/`。 [真实预览拒绝回归](../../apps/playground/scripts/browser-debug-api-test.mjs#L221) · [面板回归](../../apps/playground/scripts/browser-debug-panel-test.mjs)

全量评审修正后的候选 `1b3e0c33e1f69227fd1eba3f50e172ade5b5962efab47812597f4b63093ca818` 再次通过调试 API 五个场景和核心合同五组。真实站点打开调试页后导入超限城市地图，控制台显示错误。`e942c1e` 候选的命令往返和停止重启也通过。工作区报告位于 `/workspace/scratch/playground-showcase/`。

站点准备和回归使用以下入口。导入器需支持所选 profile 的资源，历史交付使用完整 Godot 4.6.1。`test:browser:debug-panel` 使用受控记录验证实际工作台组件，可独立运行。

```sh
pnpm --filter @godot-js/playground test:browser:debug-panel
node scripts/test/package-browser-engine-artifact.mjs --verify --out "$PLAYGROUND_DEBUG_ARTIFACT_DIR"
GODOT="$PLAYGROUND_DEBUG_EXPORTER" GODOT_IMPORTER="$PLAYGROUND_DEBUG_IMPORTER" \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
  node apps/playground/scripts/build.mjs --profile full-engine-v1 --target template_debug \
    --engine-report "$PLAYGROUND_DEBUG_ARTIFACT_DIR/engine-report.json" \
    --work-dir "$PLAYGROUND_DEBUG_BUILD_WORK" --out "$PLAYGROUND_DEBUG_SITE"
PLAYGROUND_TEST_DIRECTORY="$PLAYGROUND_DEBUG_SITE" BROWSER=chromium \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
  pnpm --filter @godot-js/playground test:browser:contracts
PLAYGROUND_TEST_DIRECTORY="$PLAYGROUND_DEBUG_SITE" BROWSER=chromium \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
  PLAYGROUND_DEBUG_API_REPORT="$PLAYGROUND_DEBUG_BUILD_WORK/debug-api.json" \
  pnpm --filter @godot-js/playground test:browser:debug-api
```

应用层迭代时可复制已验证站点，在 SDK 冻结证明、声明和预览宿主匹配的情况下用 `build:frontend --out <site>` 刷新前端。记录刷新后的候选身份并重跑受影响的用例。 [前端刷新条件](../../apps/playground/scripts/build-shell.mjs#L89-L120)
