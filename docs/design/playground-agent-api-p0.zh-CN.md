# Playground Agent API P0 实施方案

分析基线为 `cf32cc2`。P0 让 Agent 对指定项目版本做类型检查、读取诊断、启动预览、确认运行并停止指定会话。Playground 通过现有编译 Worker、浏览器预览和调试记录提供结果。Summer Engine 的项目上下文、独立脚本检查、运行和事件等待是这条工作流的参照。[引擎目标](../engine-goals.zh-CN.md) · [Summer 调试流程](https://docs.summerengine.com/mcp/building-a-game#debugging-workflow)

**P0 各工作包可以开工。** 业务实现、受控测试和真实站点准备可以并行。真实 Worker 验收需要合入后的匹配站点和可运行的浏览器门禁。现场接入的 Agent 使用自身的 `read_file`、`write_file` 等工具修改源码，再调用 Playground 工具检查和预览对应项目版本。后续 API 对齐聚焦运行时状态的读写和验证。 [引擎与平台的职责](../engine-goals.zh-CN.md#引擎与平台的职责)

## 评审决定

| 评审方向 | 纳入方案的决定 |
| --- | --- |
| API 合同 | 分开类型检查、构建和运行的事实。等待按指定尝试或会话结算，检查、构建和运行都保留自己的身份。已接纳的操作在等待期间仍可查询。 |
| Playground 与 runner | UI 和 Agent 共用运行入口。新运行意图在接纳时生效。旧请求必须在替换会话前再次核对。为 Agent 增加严格按 `runId` 停止的入口。 |
| 验收与环境 | 用同时覆盖正常链路、故障和竞争的工具调用测试。受控测试与真实 Worker 测试分别报告。把站点准备作为独立工作包，使用重新构建的 SDK 和匹配的原生模板。 |

## Agent 工具合同

Playground 在当前标签页通过 `window.godotPlayground` 提供版本化接口。查询和操作使用同一组方法名、参数对象和返回格式。页面示例和调用方共用参数校验与处理函数。返回为 `{ok: true, result}` 或 `{ok: false, error: {code, message}}`，其中 `check` 和 `wait_for_event` 异步结算。请求通过校验后的业务结果保留在对应记录内，参数无效、版本冲突、能力未就绪和记录缺失由结构化错误表示。[查询记录协议](playground-debug-api.zh-CN.md#四项查询)

| 工具 | 输入与结果 |
| --- | --- |
| `get_project_context()` | 返回项目 ID、编辑版本、已校验的 release 和预览状态，也提供各工具当前的可用性。类型检查取决于编译环境可用性。执行工具要求已就绪且可产生调试记录的 Dedicated Worker 预览。 |
| `check` | 接收 `projectId`、`expectedEditorRevision`。结算返回 `checkId`、项目版本、`scope: "typecheck"`、可确认的 `sourceHash`、诊断和 `status`。`completed` 表示收到有效回执，可包含类型错误。Worker 初始化、通信或源码同步失败使用 `failed`，附失败阶段和诊断观测状态。 |
| `get_diagnostics` | 接收 `projectId`、`editorRevision`，可指定 `checkId`、`attemptId`、`runId` 和 `path`。默认查该版本最近的检查和构建，有 ID 时按 ID 查并校验归属。运行诊断通过指定 `runId` 查询。检查和构建保留诊断总计、观测状态和省略量。运行保留故障投影及回执来源。路径只筛选返回条目，项目检查仍使用完整上下文。 |
| `play` | 接收 `projectId`、`expectedEditorRevision`。通过校验后同步捕获构建输入并创建 `attemptId`，随即返回。后续由 `get_build` 读取构建结果和 `preview.runId`。同版本的两次有效调用分配不同的尝试 ID。 |
| `wait_for_event` | 接收恰好一个 `attemptId` 或 `runId`、目标 `running` 或 `exited`，以及有界的 `timeoutMs`。结算结果为 `reached`、`no_session`、`exited_before_condition` 或 `timeout`，附可用的构建、运行与退出事实。 |
| `stop` | 接收 `runId`。对匹配的活动会话请求停止，返回 `stopping`。进行中的重复请求共用该会话的停止过程。已有退出记录时返回 `exited` 和原报告。已淘汰或未知 ID 返回 `not_found`。调用方可等待 `exited` 或查询 `get_run` 取得最终回执。 |
| `get_build({attemptId})`、`get_run({runId})`、`read_run_events({runId, after?, limit?, kinds?, levels?})` | 返回构建结果、完整 Worker 身份、终态和运行事件分页。事件游标绑定页面和会话。 |

`get_diagnostics` 可把构建和运行关联到同一个工作流。若调用同时指定了 `attemptId` 和 `runId`，两者必须属于同一构建。对当前版本的默认查询保留显式标识，供 Agent 追查。同版本多次构建有各自的结果。运行诊断来自结构化的运行故障回执，Worker 日志在事件查询中保留原来源与严重程度。

## 检查与构建输入

- Agent 工具、手动检查和后台检查共用检查入口。请求在发出前核对当前项目和编辑版本。编译 Worker 的有效类型检查回执形成检查记录，标注实际 `sourceHash`。迟到结果可按自身 `checkId` 查询，只能投影到对应版本的 UI。
- `play` 与运行按钮、快捷键和自动运行共用同一个启动函数。在任何异步处理之前固定源码、入口、运行方案、构建选项和 release，并沿用已有快照 pin 与释放机制。
- 示例滑杆保留实时控制语义。构建使用接纳时捕获的 `controls`，产物由 `buildKey` 区分。运行中的控制值仍由 UI 的实时通道更新。`editorRevision` 用于校验编辑快照，`sourceHash` 用于核对实际编译源，`buildKey` 用于核对包含启动配置的产物。
- 检查、构建和运行分别结算。构建成功但预览被拒绝时，构建记录保留产物与拒绝原因。会话创建后的故障归入该次运行。每次查询使用自身的 ID，页面的活跃预览指针只用于定位当前预览。

[工作台入口](../../apps/playground/src/main.ts#L153) · [编译 Worker](../../apps/playground/src/compiler.worker.ts) · [构建与预览记录](playground-debug-api.zh-CN.md#构建预览和退出)

## 运行竞争与等待

### 启动与替换

每次有效的 `play` 接纳都产生一个新运行意图，旧的未建会话意图随即失效。编辑版本变化、切换项目及全局停止也使关联的未建会话意图失效。由工作台控制器提供 `AbortSignal`，通过可选的 `run(artifact, {signal})` 参数传给 runner。编译回执先按原尝试记录。若构建成功但运行意图已经失效，则结算为预览 `skipped`。

runner 在完成产物和配置校验后、向旧会话发出停止前检查意图。旧会话停止结束后，在创建新会话前再检查一次。若较新的请求在旧会话已经收到停止请求后到来，旧会话按实际情况结算，失效候选也不能创建会话。已经创建的会话继续由实际 runner 生命周期结算。

### 指定会话停止

在 `WorkerPreviewRunner` 中增加 `stopRun(runId)`。runner 在同一同步边界捕获当前会话并核对 ID，匹配时发出停止请求并返回该会话的退出 Promise。无匹配时同步返回 `undefined`，调用方可回读保留的退出记录。指定 ID 的停止请求与替换各自结算，正在准备的另一个候选可继续。工作台的全局停止保留其撤销待启动请求的产品语义。两条路径复用现有 Worker 停止消息。

### 等待与记录保留

- 等待 `running` 时，匹配条件是返回快照中的当前状态为 `running`。若会话先退出，返回该次退出结果。历史状态可通过事件查询读取。等待 `exited` 以附有 `exit` 记录为准。
- 以 `attemptId` 发起的等待通过 `build.preview.runId` 绑定后续会话。遇到构建失败、取消、预览跳过或准备拒绝时，返回该构建的未创建会话结果。`running` 是启动合同的观测阶段，画面与玩法验证属于后续合同。
- 先安装记录订阅，再立即读取快照。事件、超时及工具调用取消走同一个结算入口，释放订阅、计时器和记录引用。默认等待 30 秒，单次上限 60 秒。超时只结束本次等待，底层尝试与会话继续按实际状态结算。
- `wait_for_event(input, signal)` 接受可选的 `AbortSignal`。无效信号返回 `invalid_input`。取消等待返回 `cancelled`，构建和运行继续按原状态结算。
- 未结算的 Agent 尝试和有效的等待持有有界的记录引用。类型检查按完成顺序保留，默认诊断查询从保留记录中选用发起顺序最新的检查。已退出会话和完成后的尝试使用有界保留。超过容量时明确返回繁忙或记录不可用。应用兜底退出保留 `editor-local` 来源，宿主实际回执保留 `host-report`。

[预览适配](../../apps/playground/src/engine-preview.ts) · [Worker runner](../../packages/engine/src/browser/dedicated/worker-runner.ts#L115) · [Summer 事件等待](https://docs.summerengine.com/mcp/operations/engine#wait_for_event)

## 工作包与开工条件

| 工作包 | 第一批交付 | 开工与集成 |
| --- | --- | --- |
| 工具合同与记录 | 输入校验、检查记录、诊断投影、等待与工具接口。用受控记录验证并发和时间边界。 | 可开工。先以本方案的输入、返回和终态为共同合同。 |
| Playground 控制入口 | 收敛 `main.ts` 和 `engine-preview.ts` 中的检查与启动入口，捕获输入并传递运行意图。 | 可开工。以共享接口接入工具层和 runner。 |
| Worker runner | 检查替换边界，增加按 ID 停止，用受控异步准备和退出测试竞争。 | 可开工。与 Playground 共享预览意图信号及停止入口签名。 |
| 页面与验收 | 在现有调试面板显示工具实参和结果。保留同入口回放，复用双 origin 真浏览器脚手架。 | 可开工。页面和受控测试可先接合同，真实用例等待前三包合入。 |
| 浏览器站点与本地验收 | 核验可用原生模板，重新构建匹配 SDK 和站点。 | 可开工。已有原生候选可用于准备，匹配站点通过预检后方可验收。 |

合入顺序为工具与 runner 小接口、工作台接入、页面与真实用例。工作包共享文件时以控制入口和记录层的边界拆分。P0 的编程接口和浏览器回放可先交付。产品演示的模型工具选择与自动改源码分别接入宿主提供的能力。

## 验收

| 场景 | 通过条件 |
| --- | --- |
| 类型检查与诊断 | `TS2322` 所在文件和行号可查。查询诊断时不新增编译 RPC。检查阶段无新构建或会话。修正后复查成功，新检查与其后构建的 `sourceHash` 和编译环境身份一致。迟到的旧检查保留自身版本，Worker 通信失败有独立执行错误。 |
| 错误版本与失败构建 | 过期版本在派发前被拒绝。对当前坏版本显式调用 `play`，构建记录可查，且该尝试无产物和新会话。先前运行仍活跃。 |
| 正常运行和停止 | 工具返回独立的 `attemptId` 与 `runId`。被动 Worker 观察证实阶段、日志和运行身份。停止后读到该次 `host-report`、原生退出码和清理状态。 |
| 替换期间的竞争 | 分别在应用准备、runner 校验、等待旧会话退出期间接纳较新请求。失效请求无新会话，旧会话已经收到的停止如实结算。 |
| 按 ID 停止与重复请求 | A 运行中且 B 准备时停止 A，B 仍能继续。B 启动后重复停止 A，B 不受影响。多次停止 A 仅产生一个终态。 |
| 等待与保留 | 覆盖订阅前条件已达成、先退出、构建失败、超时、取消、记录淘汰与同版本的两次运行。所有结算释放等待资源。 |
| 真浏览器故障 | 预览校验拒绝能关联到构建而无新会话。启动异常的宿主回执和宿主失联的页面兜底分别保留实际来源。 |

真实门禁使用 `full-engine-v1 / template_debug`、Dedicated Worker、`direct` 和 Chromium。测试通过公开工具入口触发，使用被动 Worker 观测独立核对阶段、日志、退出与清理事实。报告记录 `releaseId`、`candidateId`、构建与运行身份。缺少候选、关键用例未执行或身份不符时，门禁不能通过。[现有双 origin 真浏览器回归](../../apps/playground/scripts/browser-debug-api-test.mjs)

## 当前验收条件

开工前的类型检查、18 项定向测试和受控 Chromium 面板回归通过。`cf32cc2` 的 Browser Playground CI 在分享链接的 shell 回归失败后跳过了原生产品任务，因此该次运行没有产出匹配站点。[CI 失败作业](https://github.com/linfaxin/GodotAI/actions/runs/44476727957/job/135398965481)

真实站点准备可以核验历史 full/debug 候选里的原生模板及报告，或在本地重新构建匹配的模板。按 ID 停止改动会更新 SDK，集成验收需重新构建 SDK 与站点并校验新身份。历史站点只能作为材料来源，前端刷新路径会校验冻结的 SDK 证明。[历史原生候选](https://github.com/linfaxin/GodotAI/actions/runs/44233390118/artifacts/14397399010) · [站点构建和校验](../../apps/playground/README.md#build-and-run)

## 实现入口

「API 调试 → API 文档」提供完整方法说明、查询示例和运行回放。示例通过 `window.godotPlayground` 读取记录、执行检查、启动预览、等待和按 ID 停止，并显示实际入参与返回。回放超时后继续等待同一构建尝试，新的回放会取消此前的等待。[接口实现](../../apps/playground/src/playground-api.ts) · [调用示例](../../apps/playground/README.md#agent-tools)

分享链接的启动流程使用同一次保存来提交导入内容和选中项目。保存成功后先清除链接片段，再显示已自动保存。工作台项目回归覆盖清除片段、重新加载和后续编辑。[项目回归](../../apps/playground/scripts/browser-project-test.mjs)

## 首轮本地验收记录

使用 Godot `4.6.1-stable` 源码和 Emscripten `4.0.11` 构建原生 Web 模板，使用 Node `24.15.0`、pnpm `10.11.0` 和已校验的 Godot `4.6.1` 官方导入器重建 SDK 与站点。真实验证使用 Chromium `154.0.8037.57`，目标为 `full-engine-v1/template_debug`、Dedicated Worker 和 `direct`。

| 验收 | 结果 |
| --- | --- |
| Playground 类型检查和定向测试 | 类型检查通过。23 项工具、编译合同、调试记录和工作台竞争测试通过。 |
| 浏览器单元测试 | 663 项通过，2 项跳过，零失败。其中包含严格停止与两处异步替换检查的 runner 回归。 |
| Chromium shell | 当时的五项 CI shell 回归通过，覆盖分享链接、项目隔离、资源持久化、release 上下文与受控工具回放。 |
| 真实 Worker 公开 API | 九个场景通过，核对唯一全局入口与完整方法清单。类型检查与失败构建独立结算，修正后的预览有实际 Worker 日志，两项 Agent 运行场景均取得 `host-report`、原生退出码 `0` 和完整清理回执。 |
| 真实引擎合同 | `preflight`、`lifecycle`、`failure-recovery`、`replacement`、`entry-resources` 全部通过。 |

真实 API 与合同报告均记录 `engineExecuted: true`。两份报告使用同一 `releaseId` `a0480bda6885c0cc7544addd6f5dbaacfa209572e3c28376a5294b5aa7e1643c` 和 `candidateId` `9b9dbe2c220a6fcce1a08dbe2169fb716fa0f35f20ae2b7a90fb0a3f62b4466b`。刷新后的站点位于 `/workspace/work/playground-agent-p0/site-public-api.HoPZ51`，原始报告位于上一级目录。

| 报告 | SHA-256 |
| --- | --- |
| `public-api-browser-report.json` | `f9eaf3a19309ca5ee91a04d4a73d52bedd6e49f37ff8da8c2ecb137bbc02561e` |
| `public-api-engine-contracts.json` | `bfa523a1f9111765f1b3a3d90ecb7653c277f4694199249a43977d4aada12b43` |

附加的本地 headless 全量验证中，原生重命名测试在串行复验通过。普通脚本与 React 各有一项退出清理断言在串行复验仍缺少预期标记，记录于 `headless-recheck.log`。

2026 年 11 月 21 日复验前，用 `pnpm prepare:native` 将本仓库的集成补丁应用到 Godot 4.6.1 并重建测试编辑器。普通脚本与 React 的退出清理断言均通过。
