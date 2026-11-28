# Summer 运行错误查询与项目恢复实施方案

基线为 GodotAI `5f7a82f` 与 Summer CLI/MCP `4.9.2`（`5d0bc70`）。本期交付构建关联的运行错误查询、Playground 启动失败与恢复演示，以及用打包 SDK 独立完成恢复、素材替换与项目往返。三项开发均可并行启动。最终验收共用一份匹配的 Full/debug Dedicated Worker Direct 候选。 [引擎目标](../engine-goals.zh-CN.md) · [Summer 固定版契约](https://github.com/SummerEngine/summer/blob/5d0bc70c6228a2f718485913449f20482434b47b/src/mcp/tools/debug-tools.ts#L177-L198)

## 一次确定的共享合同

- **项目。** 单一 Schema 4 原生 TS 项目，使用 `launch.kind: 'script'` 和 `res://src/start.ts`。在 `start(ctx)` 内先跨一个 microtask，再根据源码中的布尔开关抛出带固定标识的错误。修复只切换该开关，随后加载 `res://main.tscn`，检查实例化成功并挂载到 `ctx.mount`。复用现有 `move_right`、60 Hz 物理配置、每步 16 像素和初始位置 64。玩家路径已在原生 PCK 验证为 `/root/PlaygroundEngineBootstrap/Main/Player`，浏览器验收再次从实际树或 Probe 回执核对。独立纹理使用 4×4 饱和色 PNG，在固定的 `(384, 128)` 位置放大绘制，与白色玩家和 Reset 区域分开取样。共享 fixture 提供项目源、故障标识、修复内容和探测点，Playground 与浏览器测试各自装配。
- **结果归属。** Playground 将 `projectId → editorRevision → attemptId → sourceHash/buildKey/artifactId → runId` 串起来。SDK 客户端通过自己捕获的 workspace 版本、构建和已订阅的 Worker 事件建立同等关联。跨调用核对完整 Worker 身份，包括 `generation`、`documentId`、`workerId` 和 `runConfigurationHash`。局部 ID 仅在对应宿主和页面内使用。
- **兼容范围。** Playground 继续使用 `summer_call` 和 `godotai-typed-v1`。本期纳入显式脚本启动异常和同一采集路径观测到的首次致命错误。项目输出、可恢复告警、实时错误流和完整 Summer wire 兼容留给独立工作。SDK 使用共享 Worker 结果和项目工具，浏览器验收依赖实际候选的能力与就绪状态。 [帧输入示例](../../apps/playground/src/input-script-demo.ts) · [脚本启动路径](../../packages/project-tools/src/runtime-entry.ts) · [既有启动失败用例](../../apps/playground/scripts/browser-debug-api-test.mjs#L596)

## PR 1 · 运行错误查询

### 错误证据从 Worker 随退出传回

现有 `host-report` 证明回执来自宿主。终态 `SessionFacts.failure` 也可能来自宿主丢失、心跳超时、启动准备和强停逻辑。为 Worker 实际观测到的运行绑定致命错误保留独立字段，同时保留现有退出分类和清理事实。 [Worker 宿主](../../packages/engine/src/browser/dedicated/worker-host.ts) · [Worker runner](../../packages/engine/src/browser/dedicated/worker-runner.ts)

1. 运行绑定直接收到首个致命错误时，在既有 `worker-fatal` 的 `diagnostic` 旁标记 `runtimeFailureCapture: 'observed'`。`pendingFatalSource` 区分由 Worker 回注的错误。报告范围包括脚本启动、项目经公共 host 接口提交的致命错误，以及同一路径送达的清理错误。
2. `native-exit` 可以附 `runtimeFailureCapture: 'settled_empty'`。真实退出码须为 0，运行 epoch 已 sealed、未溢出且没有已知致命报告。
3. 宿主和 runner 校验会话身份及标记。出口仍使用既有 `diagnostic` 和 `sessionFacts`，由可选标记说明诊断来源或空采集结果。调用者从现有 `WorkerRunnerExit` 读取。缺失或无效的标记按无采集证据处理，基础终态照常结算。退出码为 0 时也可查询实际观测到的运行错误。 [运行绑定](../../packages/engine/src/runtime-host.ts#L139) · [脚本入口报错](../../packages/project-tools/src/runtime-entry.ts)

### Playground 接口

```js
await window.godotPlayground.summer_call({
  op: 'engine.get_debugger_errors',
  input: {max_errors: 50, include_stack: true},
})
```

- `max_errors` 默认 50，接受 1–200 的整数作为本地预算。范围内至多返回一条。 `include_stack` 默认 `false`，为 `true` 时返回有界的实际堆栈。无堆栈时省略。关闭堆栈时，结果中的嵌套字段同样省略堆栈。
- `raw` 和 `include_warnings` 接受省略或 `false`，`true` 返回 `unsupported`。把上游操作参考列出的 `maxCharacters` 标为已知 `unsupported`。错误类型、无效范围及未知字段返回 `invalid_input`。
- 请求同步绑定当前编辑项目和版本，使用该版本最新已接纳的构建及其关联会话。无有效编辑上下文时返回 `not_ready`。身份冲突按现有 `revision_conflict` 处理。构建 `succeeded` 到 `beginPreview` 之间可能仍为 `not-requested`，先检查同一个 attempt 的启动意图是否开放，再判断是否已结束。历史复查通过已捕获的 ID 调用本地 `get_run`。
- `result.data` 必含 `status`、`projectId`、`editorRevision` 和 `entries`。可用时附 `build`（`attemptId`、`sourceHash`）和 `runId`。用 `get_run({runId})` 读取完整 Worker 身份、退出和清理事实。`observed` 的条目包含来源 `runtime-binding` 及诊断。`no_session` 的原因为 `no_retained_attempt` 或 `attempt_ended_without_session`，`unavailable` 的原因为 `run_evicted` 或 `capture_unconfirmed`。堆栈可指向本次构建生成的 JavaScript。

| `status` | 判定 |
| --- | --- |
| `observed` | 匹配的宿主终态含通过校验的运行绑定诊断 |
| `pending` | 关联构建或预览正在准备，同一次启动意图仍开放，或已建会话尚待终态 |
| `no_session` | 当前版本无留存尝试，或本次尝试已确认结束且未创建会话。无留存尝试无法判断更早的运行历史 |
| `unavailable` | 已知的会话记录被淘汰，或终态缺少可确认的运行绑定证据，包括编辑器本地失联、旧资产和单纯宿主故障 |
| `no_reported_error` | 匹配的宿主终态证明干净退出，且当前采集路径已正常结算、未报告该类错误 |

落点为 `worker-runtime.ts`、`worker-host.ts`、`worker-runner.ts`、`debug-api.ts`、`playground-api.ts`、`summer-adapter.ts` 和 `summer-operation-spec.ts`。单测覆盖错误来源、错身份和乱序、旧消息、无会话、失联、栈字段和新旧运行隔离。加入编译通知发生在 `beginPreview` 前，以及畸形扩展不影响正常退出这两项断言。复用现有 `session-start-failure` 浏览器用例。阴性浏览器用例打印同样的故障标识到 `console.error` 后正常退出，仍应返回 `no_reported_error`。 [现有适配器](../../apps/playground/src/summer-adapter.ts) · [现有诊断投影](../../apps/playground/src/playground-api.ts#L281)

## PR 2 · Playground 故障恢复演示

沿用 API 调用台、独立示例入口和 PNG 附件。独立示例按 Full/debug 和玩法能力开放，打开时切换项目并停止上一预览。教程的 9 个预设只填草稿，每次调用由用户执行。

1. 启动故障版，等预览退出后用 `engine.get_debugger_errors` 查看错误。将 `/src/start.ts` 中的 `startupBroken` 改为 `false`。
2. 启动修复版并等待探测和输入就绪。探测得到 x=64，执行 0/4 帧输入，再探测到 x=128。
3. 停止修复版，用同一源码重启。首次探测应回到 x=64，使用工具栏停止预览。

浏览器测试通过同一 UI 执行这些步骤，使用现有 `wait_for_event` 按 attempt 或 run 等待。验证原错误归属、两次正常退出、同帧截图、实际四个物理帧和重启身份。离线校验只匹配验收候选并用现有像素校验器核对原始 PNG。 [恢复测试](../../apps/playground/scripts/browser-runtime-recovery-test.mjs) · [像素校验](../../apps/playground/scripts/verify-summer-pixels.py)

## PR 3 · 独立 SDK 接入与项目往返

扩展现有打包 SDK 消费者。测试夹具可接收共享项目文件和配方，浏览器内的实现从安装的 tarball 导入公开 API。消费者在调用 `runner.run()` 前订阅事件并记下事件起始位置。若启动失败使 Promise 以 `E_RUN_ENDED` 拒绝，用新产物的版本、generation 和 buildKey 从 `loading-frame` 确认完整运行身份，再从匹配的 `exit` 事件读取诊断和终态。故障版已捕获的 workspace 版本是修复 delta 的基础。夹具串行执行编辑、编译和交接，只将成功产物交给 runner。同一候选和配置复用 runner。编译、资源验证和产物装配出现错误时，已有 run 保留自己的状态和退出事实。快照 pin 无论结果如何均释放。

1. **恢复。** 捕获故障版源快照，取得确定的失败终态。用带 `baseRevision` 的 delta 改同一文件，核对新构建、新 run 和四帧试玩。重交旧基线和向旧 run 发 Probe 都必须被拒绝。旧 run 的诊断只归属旧构建。
2. **换素材。** 同路径、同显式 `godotjs/png-ctex` 配方替换确定的 PNG 字节，配方固定 `mipmaps: false`。用实际发布的 `facts.resources`、浏览器注册表和资源预算传入 `compileProject` 的 `preparation`。核对源哈希、生产收据、输出哈希和产物身份的变化。通过 `ResourceLoader` 在游戏中呈现新纹理，独立消费者保存原始 Probe PNG 并对固定区域核对颜色。缺源负例使用 `applySourceSnapshotDelta` 派生未提交的快照。缺生产器负例保留配方并提供不含该生产器的注册表。二者均为 `E_RESOURCE_CONVERTER`，用各自的诊断区分。两项均需证明无新会话、原 run 仍能 Probe、主 workspace 版本未受负例影响。已成功的 `captureChanges` 会提交编辑版本，后续编译失败时保持已提交版本。
3. **搬迁。** 用公开 Schema 4 文档 API 导出源文件、PNG、启动入口、profile 和配方。生成物和本次收据单独存为验收证据。新页面用空 workspace 读取 JSON，从 `read.document.resourceImports` 取得配方并重新执行转换。编译、运行、核对相同玩法和新颜色，再用同一 JSON 在 Playground 导入并跑一遍。只有构建选项、目标、转换输入和收据策略一致时，才比较构建身份或字节。

独立验收将 profile、debug、Dedicated Worker Direct 和 Probe/Input ABI 作为硬前置。缺少能力时报阻塞并退出，专项用例不能通过有条件跳过来结算。报告应可对应到实际候选、原始图像、资源输出与每个退出回执。 [打包浏览器入口](../../packages/project-tools/test/fixtures/packed-browser-consumer.mjs) · [消费者回归](../../apps/playground/scripts/browser-engine-contracts-consumer-test.mjs) · [公开项目文档](../../packages/project-tools/src/project-document.ts) · [资源目标和收据](../../packages/project-tools/README.md#shared-compiler-and-node-adapter)

## 开工与候选准备

| 工作 | 开工判断 | 合入与验收门槛 |
| --- | --- | --- |
| PR 1 接口与诊断传递 | **可立即开工**。参数、来源字段和状态已可作为交接合同，可用合成回执测试各分支 | 可先在匹配的 2D 站点验证脚本启动失败和干净终态，再随两端在最终 Full 候选复跑 |
| PR 2 Playground 教程与回放 | **可立即并行**。共享项目、预设和受控测试先做 | 联调使用 PR 1 实际返回，真实回放需要匹配候选 |
| PR 3 SDK、素材与往返 | **可立即并行**。打包安装、编译事务、转换和项目文档先做 | 诊断分支接入 PR 1 的公开退出字段。跨宿主验收使用与 PR 2 同一份候选 |
| Full/debug 产物 | **可立即准备**。可用匹配归档通过校验后复用，或根据已通过的源码快照流程独立重建 | 候选要绑定最终 SDK、宿主 JS/WASM、引擎报告和站点身份。实际 Chromium 预检通过后开始两端验收 |

本机已核对 Godot `4.6.1-stable` 的干净 Git 源码、Emscripten `4.0.11`、SCons `4.10.0`、Chromium 和 Pillow。使用官方 Godot 4.6.1 准备 Full 资源。原有 2D/debug 站点的冻结 SDK 早于本次基线，直接刷新前端会被 `E_WORKER_SDK_SOURCE_DRIFT` 拒绝。复用它的原生模板并重新组装后，2D 站点通过验收预检，可用于终态诊断和项目导入的补充测试。带 Probe 和 Input Script 的 Full/debug 站点用于最终验收。

### 本机候选命令

在仓库根目录使用 Node `24.15.0`（`.node-version`）与 pnpm `10.11.0`。系统默认 Node 为 `24.19.0`，已验证可通过 `npm exec --package node@24.15.0` 获取锁定版本。原生工作目录、站点工作目录与站点产物分别设置。模板的 `window` 执行标记对应普通单线程模板，站点仍由 Dedicated Worker 运行。

```bash
source /workspace/.godotai-web/emsdk/emsdk_env.sh
export PATH="/workspace/.godotai-tools/node_modules/.bin:/workspace/.godotai-tools/python/bin:$PATH"
task_root="$(mktemp -d /tmp/godotai-full-recovery.XXXXXX)"

node scripts/test/build-browser-engine.mjs \
  --godot-source /workspace/.godotai-web/godot-source \
  --build-dir "$task_root/native-build" --out "$task_root/engine-report.json" \
  --profile full-engine-v1 --target template_debug --execution-model window \
  --module-mode baseline --lto none --jobs 4
node scripts/test/package-browser-engine-artifact.mjs \
  --report "$task_root/engine-report.json" --out "$task_root/native-artifact"
node scripts/test/package-browser-engine-artifact.mjs \
  --verify --out "$task_root/native-artifact"

pnpm build
unset GODOT_WEB_TEMPLATE
export GODOT=/workspace/.godotai-web/exporter/Godot_v4.6.1-stable_linux.x86_64
export GODOT_IMPORTER="$GODOT"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium
node apps/playground/scripts/build.mjs \
  --engine-report "$task_root/native-artifact/engine-report.json" \
  --profile full-engine-v1 --target template_debug --execution-model window \
  --work-dir "$task_root/site-work" --out "$task_root/site" --skip-sdk-build
node apps/playground/scripts/seal-site-acceptance.mjs \
  "$task_root/site" "$task_root/evidence" --begin
```

原生准备可并行进行。若已有归档通过同一校验，可复用其模板。站点用最终联调版本的 SDK 和 Worker 宿主组装，验证 snake/camel API 捕获、Probe 和 Input Script 证明。现有验收封印固定站点、测试和运行资产，专项报告另存所用 SDK tarball 和消费者 bundle 的身份。三项按接口、演示、SDK 顺序集成，在最终同一候选上复跑并保存独立报告、原图、可导入 JSON 和离线校验结果。 [引擎构建与站点组装](../../apps/playground/README.md#build-and-run) · [匹配候选和真实验收](../../apps/playground/README.md#reproduce-the-summer-input-demo-and-evidence)

## 评审验证记录

- 基线 Playground 定向测试 49 项通过。项目工具资源、增量和项目测试 40 项通过，其中包含实际原生 ResourceLoader 读取转换结果。隔离 SDK tarball 安装与浏览器 bundle 测试另有 1 项通过。
- 共享项目的脚本入口、场景和 PNG 配方已联合构建。实际 PCK 验证了异步 `start` 故障、修复后的玩家路径和 x=64。2D Chromium Worker 实验通过同一项目的导入、Monaco 修改、`ResourceLoader` 纹理加载和宿主清理。故障堆栈为生成 JavaScript 位置。
- 用官方编辑器完成 Full 资源准备检查，共处理 22 个 GLB 和 77 个输入。使用旧 2D 原生模板和当前 SDK 重新组装的临时 2D 站点（候选 `2da7ede92927`）通过 `seal-site-acceptance --begin`。Chromium 的 `session-start-failure` 和 `agent-check-play-and-targeted-stop` 基线实机测试均通过。两项只覆盖已实现的诊断和启停，专项同帧 PNG、Input Script 及新增诊断接口由实施后的候选验收。
- 使用实际 2D 发布描述符和公共编译器完成同路径 PNG 替换、收据核对及 Schema 4 往返。省略可选旧收据时，相同输入重建获得相同产物。携带旧收据会影响构建身份。并发提交同一 `baseRevision` 只有一个成功，缺源及缺生产器分别返回明确诊断。

## 实施验收

评审修复后，三项实现在同一份 Full/debug Dedicated Worker Direct 候选重新验收。候选 ID 为 `3d3ed75ebf18cb543085ca5b21617352f2c45807f660e708afea8241720cb29b`，使用 Chromium `154.0.8037.57`。复用了已通过便携归档校验及 19 项 Input Script G0 用例的原生模板。本轮开发中 Playground、engine 和 project-tools 的 768 项测试已通过。合并前复跑的 65 项定向测试、Playground 类型检查与调用台浏览器回归也已通过。

- 真实启动异常返回 `observed`。输出同名 `console.error` 后正常退出返回 `no_reported_error`。预览宿主失联返回 `unavailable`。多字节长堆栈测试确认完整退出事件仍可从历史读取。
- Playground 记录了一次结构化启动失败和两次干净退出。三张原始 PNG 的像素校验确认位置为 `64 → 128 → 64`。既有生命周期回放及离线像素核验也在同一候选通过。
- 隔离 SDK 验收覆盖故障、修复、同路径 PNG 替换、空工作区重建，以及同一份 JSON 在 Playground 的导入。核对了 9 张原始 Probe PNG 和项目 JSON 的哈希。原运行在缺源和缺生产器两项负例后仍能响应。

本地站点和证据位于 `work/summer-runtime-recovery/merge-final/`。其中 `site/` 是可运行站点，`context/site-start.json` 是验收上下文。`playground/`、`sdk/`、`diagnostics/` 和 `lifecycle/` 保存报告。可导入项目为 `sdk/sdk-roundtrip-project.json`。在站点 API 调用台打开 `engine.get_debugger_errors` 的独立示例，按「Summer：定位启动错误并恢复试玩」执行。
