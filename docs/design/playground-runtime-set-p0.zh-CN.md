# Playground 运行时属性写入 P0 实施方案

**评审结论（2026 年 11 月 20 日）**。原生、Worker、发布证明、Playground 和构建环境准备可以按下列契约并行开工。真 WASM 验收在通过源码认证的新候选站点上执行。当前环境具备本机原生测试和受控浏览器测试所需的基础工具，Web 构建工具链与匹配产物仍待准备。

首期交付 `window.godotPlayground.runtime_set` 和 `WorkerPreviewRunner.setRuntimeProperty`，让 Agent 修改指定会话中一个 `Node2D` 的本地 `position`，并拿到原生引擎读回的值。Playground 用真实 Godot WASM 演示「定位节点 → 读取位置 → 写入 → 再读和截图 → 停止并重启」。项目文件由 Agent 自身的工作区工具管理。 [引擎目标](../engine-goals.zh-CN.md#引擎与平台的职责)

基线 `6ef854b` 已有 `get_runtime_tree`、`inspect_runtime_node`、`screenshot` 和 `game_input`。本期对齐 Summer 4.9.2 `engine.runtime_set` 的运行态单属性写入与读回语义，GodotAI 使用结构化坐标和明确的运行、节点身份。MCP 参数映射、更多属性与节点类型、运行时方法调用和同帧观察可随接入用例独立扩展。 [Playground Agent API](../../apps/playground/README.md#agent-tools) · [Summer 4.9.2 操作定义](https://github.com/SummerEngine/summer/blob/5d0bc70c6228a2f718485913449f20482434b47b/src/core/ops/engine.ts#L355) · [Summer 写入实现](https://github.com/SummerEngine/summer/blob/5d0bc70c6228a2f718485913449f20482434b47b/src/core/capabilities/runtime-control.ts#L334)

## 公共 API

`runtime_set(input, signal?)` 返回 Promise。调用方先从节点树或属性查询取得 `path` 和字符串格式的 `node.instanceId`，再提交单项写入。

```ts
const result = await window.godotPlayground.runtime_set({
  runId,
  path: player.path,
  expectedInstanceId: player.instanceId,
  property: 'position',
  value: {x: 192, y: 256},
  timeoutMs: 5000,
}, signal)
```

| 输入 | 约束 |
| --- | --- |
| `runId` | 指定当前运行会话。复用已有运行身份校验 |
| `path` | 复用运行时查询的规范绝对路径、长度与层级限制 |
| `expectedInstanceId` | 必填。使用查询返回的正 uint64 十进制字符串，首位非零。按字符串校验范围，原生端核对完整 ObjectID |
| `property` | 首期仅支持 `position`，坐标相对节点父级 |
| `value` | 普通数据对象，恰好包含 `x`、`y` 两个有限数属性。原生端校验 `real_t` 范围，将输入转换为 `Vector2` 后逐分量比较 |
| `timeoutMs`、`signal` | 默认 5000 ms，整数范围 1–30000 ms。可选有效的 `AbortSignal` 用于撤销等待并尽力取消待执行请求 |

沿用 `{ok, result/error}` 返回形式。runner 使用接纳时复制的参数和运行上下文组装回执，调用方读取 `outcome` 判断效果。写入用 `requestId` 关联，后续独立查询继续用 `sampleSeq`。 [读接口结果类型](../../packages/engine/src/browser/dedicated/worker-runtime-observation.ts#L24)

```ts
type Position = {x: number; y: number}
type RuntimeSetReceipt = {
  requestId: string
  run: WorkerRunIdentity
  releaseId: string
  path: string
  expectedInstanceId: string
  property: 'position'
  requestedValue: Position
}

type RuntimeSetResult =
  | {ok: true; result: RuntimeSetReceipt & {
      outcome: 'applied' | 'not_applied'
      observedValue: Position
    }}
  | {ok: true; result: RuntimeSetReceipt & {
      outcome: 'unconfirmed'
      reason: 'timeout' | 'cancelled' | 'run_ended' | 'transport_lost'
        | 'target_changed' | 'readback_failed'
    }}
  | {ok: false; requestId?: string; error: {code: RuntimeSetError; message: string}}
```

| 返回 | 条件与调用方行为 |
| --- | --- |
| `ok: true, outcome: 'applied'` | 原生 setter 已执行，读回同一节点的值与引擎精度下的目标值一致 |
| `ok: true, outcome: 'not_applied'` | 执行后读回同一节点，实际值与目标不同。调用方可依据 `observedValue` 判断下一步 |
| `ok: true, outcome: 'unconfirmed'` | 请求可能已经执行，执行事实由 `reason` 解释。后续读取只证明采样时的状态 |
| `ok: false, error` | 已确认未调用 setter。已分配请求 ID 时同时返回 `requestId` |

`RuntimeSetError` 采用固定错误码。输入格式、属性名或坐标范围无效为 `invalid_input`。未知与已退出的运行分别为 `not_found` 和 `run_ended`。运行未就绪、缺写入 ABI、写入槽已占用分别为 `not_ready`、`unsupported`、`busy`。目标路径不存在或节点已离开公开树为 `node_not_found`，同路径的 ID 不同为 `node_changed`，目标匹配但类型不支持为 `unsupported_node_type`。已确认未派发为 `dispatch_failed`。已确认执行前到期或取消可返回 `timeout` 或 `cancelled`。

`get_run({runId}).result.runtimeWrite` 返回 `{supported, ready, version?}`。协商未完成时 `supported: null`，确认缺能力时为 `false`，协商通过后为 `true` 且 `version: 1`。只有当前活跃且已运行的匹配会话为 `ready: true`。并发容量由写入调用返回 `busy`，查询能力保留独立的 `observation` 字段。 [现有能力发现](../../apps/playground/src/playground-api.ts#L252)

每次派发都有独立的请求 ID，调用方将它视为不透明标识。收到 `busy` 或 `not_ready` 后，可在条件恢复时重新发起。收到 `unconfirmed` 后先重读目标，再决定是否提交新的写入。相同值的 setter 仍可能触发通知。自动化重试以新的写入意图为前提。

## Worker 协议与结算

写入沿用 Worker protocol 2 的完整运行信封。读取与写入各有一个待执行槽位，复用现有数据通道和完成迭代后的执行钩子。共用检查点先执行一项写入，再重新检查会话并采样一项读取。读接口继续使用原有结算规则。 [运行信封](../../packages/engine/src/browser/dedicated/worker-protocol.ts#L19) · [主循环钩子](../../packages/engine/src/browser/dedicated/worker-runtime-observation.ts#L233)

| 消息 | 字段和处理 |
| --- | --- |
| `runtime-write-request` | runner 复制有界纯数据参数，分配当前运行内单调递增的正安全整数 `writeSequence`，构造 `requestId = runId + ':' + writeSequence`。携带绝对 `deadline`、路径、实例 ID、属性和值。宿主仅转发一次，用独立的 `dataSequence` 跟踪通道消费 |
| `runtime-write-cancel` | 携带匹配的 `requestId` 和 `writeSequence`，经数据通道转发。Worker 只撤销匹配且尚未进入原生执行的请求 |
| `runtime-write-result` | 沿控制回程转发，携带 `requestId`、`writeSequence` 和终态。宿主和 runner 校验完整运行身份、请求身份及结果形状。Worker 只返回执行事实，runner 用接纳的上下文生成公共回执 |

宿主和 Worker 在验证运行信封、编号及其绑定后，以各自的每会话最高写入序号去重，再做有效请求的准入判断。宿主忽略重放。Worker 对收到的相同或更早序号只回数据消费凭证。即使重放包换了更大的 `dataSequence`，写入身份也保持一致。消费回执以对应的 `dataSequence` 回收额度，终态匹配本次写入身份后才可回收其额度。 [宿主转发](../../packages/engine/src/browser/dedicated/worker-host.ts#L91) · [Worker 数据处理](../../packages/engine/src/browser/dedicated/worker-runtime.ts#L253)

`deadline` 使用现有 `performance.timeOrigin + performance.now()` 量纲。Worker 在进入同步原生写入导出前做最后一次时间与会话校验。到期后不进入原生写入，截止前进入的调用完成原生校验与读回，即使执行期间跨过截止。Stop 走控制通道，写入与取消走数据通道。Worker 收到停止、进入本机关闭或到期即停止接纳执行。runner 的停止意图先于 Worker 收到时，公共回执依据当时已确认的事实结算。 [时钟](../../packages/engine/src/browser/dedicated/worker-interaction.ts#L58) · [停止路径](../../packages/engine/src/browser/dedicated/worker-host.ts#L202)

| runner 结算时掌握的事实 | 公共结果 |
| --- | --- |
| runner 尚未发送，或在本地等待结束前收到可信的宿主未转发或 Worker 未执行回执 | 以 `ok: false` 返回对应错误 |
| 本地等待仍有效，先收到完整匹配的原生结论 | 返回 `applied`、`not_applied` 或原生 `unconfirmed` |
| 已发送且执行事实未知，本地截止、取消、停止或连接断开先结算 | 返回 `unconfirmed` 和对应原因。取消尽力发送撤销消息 |

runner 只结算一次。收到结果时如已达到本地截止，按超时路径处理。宿主与 runner 的逻辑写入槽在收到有效终态、达到原截止或会话退役时释放。取消后在原截止前保持占用，除非已有终态。尚未消费的写入和取消包各占一个物理槽，分别由匹配消费回执、对应写入终态或会话退役回收。迟到回执只释放对应请求的占用。数据已被消费而结果丢失时，截止后可接纳下一次写入。Worker 每次接纳先清理已到期的待执行项，同一线程串行执行旧操作和后续请求。 [现有下行额度](../../packages/engine/src/browser/dedicated/worker-runtime-observation-transport.ts#L71)

## 原生执行与读回

首期新增 `_godotjs_runtime_write_abi()` 和 `_godotjs_runtime_write_execute(inputBytes)`。版本函数返回 `1`。执行入口使用现有 `_godotjs_runtime_observation_buffer()` 的有界 UTF-8 JSON 缓冲区，输入固定为 `{path,expectedInstanceId,property,value}`，返回写入结果的字节长度。原生 JSON 只含 `{ok,result}` 或 `{ok,error}` 的执行事实，采用公共回执中的结果、原因和错误码。Worker 在同步调用后从当前 WASM heap 复制回执，长度、JSON 或结果无效且已进入原生调用时为 `unconfirmed/readback_failed`。

1. 使用现有绝对路径解析与公开树过滤，校验 owner 线程、完成迭代、物理帧、互操作深度和 `NativeWorld::can_commit()`。解码并复制输入，完整比较字符串 ObjectID。在转为 `real_t` 前检查表示范围，转换后再检查有限性。
2. 保存目标 ObjectID，在 `NativeInteropScope` 内调用 `Node2D::set_position`。观察与写入导出共用同步重入防护，重入调用在进入原生业务和缓冲区前被拦截。setter 可能同步触发 Godot 通知。 [原生上下文检查](../../bridge/jsb_runtime_observation.cpp#L229) · [互操作范围](../../bridge/jsb_native_world.h#L111) · [Godot 变换通知](https://github.com/godotengine/godot/blob/4.6.1-stable/scene/main/canvas_item.h#L173-L177)
3. 离开 setter 后重取当前 world、SceneTree 和根节点，按原路径和 ID 重新确认目标。世界或目标变化、节点离树或已排队释放时返回 `unconfirmed/target_changed`。仍匹配时通过 `get_position` 读取有限坐标，按原生 `Vector2` 逐分量比较，给出 `applied` 或 `not_applied`。非法读回为 `unconfirmed/readback_failed`。 [目标解析](../../bridge/jsb_runtime_observation.cpp#L73)

## Web 构建与能力握手

首期只在经过认证的 `full-engine-v1 / template_debug / window` Web 配方声明 `runtimeAbi.runtimeWrite: 1`，依赖 `observation: 1` 和 `lifecycle: 1`。该配方在 Playground 使用普通 Dedicated Worker。`direct` 是首期开放写入的呈现方式。其他配方、旧的只读候选和 `bitmap` 预览返回 `unsupported`，继续依据各自的观察能力执行查询。声明了写入 ABI 的候选加载后核对实际导出与版本，Worker 在 `running` 握手中用 `runtimeWriteVersion` 报告协商结果，宿主和 runner 按发布声明和呈现方式核对。声明存在但导出或版本不符时，启动在发布运行状态前失败。

| 交接位置 | 负责的证明和校验 |
| --- | --- |
| [原生导出](../../SCsub#L592)与 [Web 构建报告](../../scripts/test/build-browser-engine.mjs#L90) | 无线程构建加入两个导出。对首期配方生成 `runtimeWrite` 证明，记录 `abi`、导出清单、编译输入哈希和已解码 WASM 哈希，绑定源码快照 |
| [共享证明](../../scripts/release/web-release-utils.mjs#L30)与 [模板打包](../../scripts/test/package-browser-engine-artifact.mjs#L54) | 在打包、发布及读取时双向核对 ABI 声明和证明，校验依赖、导出清单、输入、WASM 与目标配方 |
| [通用 Web 发布](../../scripts/release/build-web-release.mjs#L179)与 [Playground 发布](../../apps/playground/scripts/full-engine-release.mjs#L110) | 通用发布在 attestation 保留证明。Playground 描述符在 ABI 和 build 证明字段保留能力，候选和站点封印核对同一发布产物。 [候选验证](../../apps/playground/scripts/worker-candidate.mjs#L20) · [站点封印](../../apps/playground/scripts/seal-site-acceptance.mjs#L36) |
| [构建 ABI 枚举](../../scripts/release/engine-profiles.mjs#L75)与 [浏览器 ABI 校验](../../packages/engine/src/browser/release-adapter.ts#L52) | 扩展允许字段，严格校验依赖和版本，在 `VerifiedRelease`、Worker、宿主和 runner 传递并校验协商值。 [VerifiedRelease](../../packages/engine/src/browser/verified-loader.ts#L15) · [现有宿主握手](../../packages/engine/src/browser/dedicated/worker-host.ts#L396) |

## Playground 演示

在「API 调试」加入「运行时写入验证」。与现有试玩共享互斥状态和调用轨迹，沿用工作台的样例准备和待启动尝试撤销。打开样例前验证发布与呈现能力，启动后用 `get_run` 检查 `runtimeWrite.ready`。运行与观察通过公开 API 执行。 [Agent 面板](../../apps/playground/src/workbench/agent-panel.ts#L225)

1. 启动隔离试玩样例，等待指定尝试进入运行状态。从节点树找到运行时创建的 `Player`，记录路径、实例 ID、初始位置 `{x:64,y:256}`，并截图。
2. 调用 `runtime_set` 写入 `{x:192,y:256}`。校验 `applied`、`observedValue`、`requestId` 及发布和运行身份。随后独立调用 `inspect_runtime_node`，断言同一运行、同一实例返回新位置。
3. 在有界等待内采集后续 PNG，直到 `renderSerial` 增长、旧位置的白色标记消失且新位置出现。面板展示前后截图、位置、请求 ID 和运行 ID。截图与状态查询以运行身份关联，各有采样序号。
4. 按 `runId` 停止并读取正常退出回执。用同一项目编辑版本和 `sourceHash` 重启，核对新 `runId` 中 `Player` 的位置回到 `{x:64,y:256}`。验收用例用旧 `runId` 再发起写入，确认返回 `run_ended`，并读回新会话的位置确认隔离。重启会话同样按 ID 停止并确认退出。

能力未就绪时显示原因。每次启动在失败或用户取消回放时按已捕获的 `attemptId` 或 `runId` 收尾。退出确认使用独立的有界等待，回放取消后仍可获取实际回执。前后结果区保留两次运行的 ID、写入回执和退出状态，调用轨迹按现有容量滚动。 [现有回放收尾](../../apps/playground/src/workbench/agent-panel.ts#L270) · [真实观察用例](../../apps/playground/scripts/browser-debug-api-test.mjs#L647)

## 并行开工与合入条件

| 工作包 | 开工条件与负责范围 | 交接产物 |
| --- | --- | --- |
| 原生 | 可开工。负责 `bridge/`、`SCsub` 和 C++ 测试，按固定载荷和导出实现位置写入与读回 | 带 `tests=yes` 的本机原生验证、写入导出和原生测试夹具 |
| Worker | 可开工。负责 `packages/engine` 的 DTO、runner、宿主、Worker、能力解析和受控测试。用原生导出测试替身先验证协议 | `setRuntimeProperty`、`runtimeWriteState`、版本握手及竞态回归 |
| 发布证明 | 可开工。负责 Web 构建报告、模板打包和两条发布链的证明校验。以合成证明先验证字段保留和篡改拒绝 | 真实构建可生成、发布可验证的 `runtimeWrite` 证明 |
| Playground | 可开工。负责公开 API、面板、受控 Chromium 回归和真实专项脚本。按已定的 runner 接口使用测试替身 | 一键回放、公开 API 回归、新旧候选验收脚本 |
| 构建环境 | 可立即准备工具链和旧模板。新版 Web 模板在原生导出与构建证明接通后生成 | 固定工具版本、源码提交、导入器哈希和两份候选报告 |

集成顺序为原生与构建证明产出匹配 Web 模板，Worker 与 Playground 产出同源 SDK 和站点，最后跑两个真实专项。旧 ABI 使用同配方且只有观察 ABI 1 的历史模板和原始认证报告，配合当前 SDK 完整构建兼容站点。两套站点分别记录各自的 `releaseId` 和 `candidateId`。 [匹配报告输入](../../scripts/release/browser-engine-artifacts.mjs#L29) · [站点构建说明](../../apps/playground/README.md#build-and-run)

当前环境有本机 GodotJS 编辑器、SCons 4.10.0、pnpm 10.11.0、Playwright 和 Chromium。本机原生测试需先从本轮代码重建。Web 验收还需 Emscripten 4.0.11、Godot 4.6.1-stable 的 Git checkout（`14d19694e0c88a3f9e82d899a0400f27a24c176e`）和有 glTF 支持的固定版 4.6.1 导入器。现有 4.6.1 目录是解压源码树，缺少可用于源码认证的 Git HEAD。系统官方 Godot 为 4.6.3。当前也缺新版匹配站点，旧兼容站点可从认证模板归档获取或按历史基线构建。 [Web 工具链](../browser-worker-engine.zh-CN.md#构建候选) · [源码认证](../../scripts/test/build-browser-engine.mjs#L212) · [资源工具验证](../../apps/playground/scripts/seal-site-acceptance.mjs#L83)

## 验收与命令

| 验收层 | 可判定的通过条件 |
| --- | --- |
| 原生 | 实际改变节点本地坐标，边界数值按引擎精度读回。覆盖非法/溢出坐标、非法 ID、错误类型、目标删除和同路径替换。同步通知回写不同值时可见 `not_applied`，通知中目标离树时可见 `unconfirmed/target_changed` |
| Worker | 用受控时钟验证到期前/后的原生入口、先收到停止/取消以及已进入后丢回执。注入同序号、同逻辑请求加新 `dataSequence`、请求 ID 与写入序号不匹配、旧会话的结果。验证 setter 调用次数、唯一终态、额度归还与下次写入恢复 |
| 发布与 UI | 验证缺少依赖、证明缺失、错误导出、源码或 WASM 哈希、错误配方和握手失配。面板测试检查协商前 `null`、已知不支持、活跃时 ready 和停止后 ready 为 false。能力不足时在打开样例前给出原因。新旧候选的公开方法清单均包括 `runtime_set` |
| Chromium 旧 ABI | 真实只读候选在新版 SDK 下运行。公开写入返回 `unsupported`，节点观察及游戏截图继续成功 |
| Chromium 新 ABI | 使用双来源站点。预检要求 `site.engineTarget === 'template_debug'`、Full、Dedicated Worker 和写入 ABI 1，运行现场确认 Direct。专项步骤实际执行并通过，证据包括 `engineExecuted: true`、发布/候选 ID、被动观察到的运行身份、写入回执、PNG 与哈希，以及两次 `host-report`、原生退出码 0 和 `hostCleanup: 'complete'` |

从仓库根目录准备冻结依赖和新鲜产物。用 `tests=yes` 重新构建原生编辑器，再执行匹配的测试名并检查至少运行一个匹配用例。源构建脚本输出认证报告路径，用它构建新候选。旧候选用只读版认证报告和相同 SDK 构建到独立目录。输出 JSON 和 PNG 保留在各自候选目录之外。 [本地验证策略](../../CONTRIBUTING.md#local-verification) · [真实 API 验收入口](../../apps/playground/README.md#validation)

```sh
pnpm install --frozen-lockfile
pnpm build:engine-js
pnpm prepare:native --godot-source /absolute/godot-4.6.1
# 使用本仓库模块和 tests=yes 重新构建 GodotJS 编辑器。
/absolute/godotjs-editor --headless --test --test-case='*runtime write*'

pnpm test:engine
pnpm --filter @godot-js/playground typecheck
node --test apps/playground/scripts/playground-api.test.mjs \
  apps/playground/scripts/worker-candidate.test.mjs \
  apps/playground/scripts/full-engine-release.test.mjs \
  scripts/release/test/web-release.test.mjs
pnpm --filter @godot-js/playground test:browser:debug-panel

GODOT_SOURCE=/absolute/godot-4.6.1 ENGINE_PROFILE=full-engine-v1 \
ENGINE_TARGET=template_debug ENGINE_EXECUTION_MODEL=window \
bash apps/playground/scripts/build-web-engine.sh

GODOT=/absolute/godotjs-editor GODOT_IMPORTER=/absolute/godot-editor \
node apps/playground/scripts/build.mjs \
  --engine-report /absolute/engine-report.json --out /absolute/site-new

GODOT=/absolute/godotjs-editor GODOT_IMPORTER=/absolute/godot-editor \
node apps/playground/scripts/build.mjs \
  --engine-report /absolute/read-only-engine-report.json --out /absolute/site-old

PLAYGROUND_TEST_DIRECTORY=/absolute/site-new \
PLAYGROUND_DEBUG_API_CASE=runtime-set-position \
PLAYGROUND_DEBUG_API_REPORT=/absolute/results/runtime-set-position.json \
pnpm --filter @godot-js/playground test:browser:debug-api

PLAYGROUND_TEST_DIRECTORY=/absolute/site-old \
PLAYGROUND_DEBUG_API_CASE=runtime-set-unsupported \
PLAYGROUND_DEBUG_API_REPORT=/absolute/results/runtime-set-unsupported.json \
pnpm --filter @godot-js/playground test:browser:debug-api
```

首期完成需要上表受控回归与两个匹配候选的真实专项均通过。专项验收用于写入能力交付，站点完整发布沿用既有封印流程。
