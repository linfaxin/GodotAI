# 引擎最小合同与核心回归实施方案

本文为初版，保留用于评审追溯。当前实施依据为[三轮子会话评审后的 V4](engine-minimum-contracts-v4.zh-CN.md)。

状态：待实施方案。日期：2026 年 11 月 17 日。源码基线：`a518dab`。

## 目标与完成结果

让 Playground 后续的项目控制器与 AI 助手能够取得准确的引擎环境，将确定的项目输入交给检查和构建，再运行对应产物，获取可关联的诊断与退出结果。

本轮固定四组合同：**环境、检查与构建、产物到运行的衔接、运行生命周期与结果**。交付已有实现上的薄装配、明确的字段和失败语义，以及一条匹配真实引擎的核心回归链。

依照 [CONTRIBUTING](../../CONTRIBUTING.md#framework-development-stage-and-reviews) 的初期开发原则，内部函数可以随调用者一起调整。本轮合同是当前集成和回归依据，不提前承诺长期公开 ABI 或所有平台组合。

## 本轮边界

| 本轮引擎工作 | Playground 或后续工作 |
| --- | --- |
| 当前 release、API、类型、模块、资源与执行能力的准确描述 | AI 上下文挑选、token 预算、会话和模型通信 |
| 一致的项目输入、检查和构建结果 | 多文件修改提交、协作冲突、项目检查点与持久化事务 |
| 编译产物到默认 Worker 输入的衔接与校验 | 创作任务编排、修改后是否自动运行、重试策略 |
| 可消费的运行事件、错误、取消和退出事实 | 将事实关联到用户、会话、轮次，展示给用户和 AI |
| 相关包测试及真实 Worker 核心回归 | 公共截图、输入自动化、场景 inspector、帧步进与玩法判断 |

主验收目标选当前默认 Dedicated Worker、direct 呈现、`full-engine-v1` 和一套固定版本 Chromium，覆盖普通场景、显式 `start(ctx)` 及按需 React。bitmap、2D profile、pthread、其他浏览器与设备沿用各自范围；它们不作为本轮所有改动的先决条件。

## 当前基础与需要补齐的部分

| 合同 | 已有实现 | 本轮补齐 |
| --- | --- | --- |
| 环境 | `EngineApiIR`、类型快照、release 身份、执行合同、资源格式和 registry | 投影为可查询事实；将浏览器编译环境的通用装配从工作台中分离 |
| 输入与构建 | `SourceSnapshot`、`BuildPlan`、`CompilerEnvironment`、`checkProjectTypes`、`compileProject` | 明确输入捕获、check 范围、最终构建身份、错误与取消约定 |
| 产物衔接 | `CompileResult`、`compileResultMetadata`、`BrowserArtifact`、`VerifiedRelease` | 统一字段映射与默认 Worker 资产装配，保留 single-pack 和 pack-set 差别 |
| 运行 | `WorkerPreviewRunner`、运行身份、状态与事件、`SessionFacts` | 固定 ready 和终态含义，保留完整身份、原始退出事实与命令接纳语义 |
| 回归 | 隔离包消费、编译一致性、资源及真实 RuntimeHost 测试 | 补真实启动取消、新运行替换等缺项断言，汇总本轮实际执行范围 |

实施主要复用 `packages/engine`、`packages/project-tools` 和既有浏览器测试；不新建通用服务包或另一套 compiler、runner、产物协议。

## 合同一 当前引擎环境

### 权威输入与输出

环境描述来自当前实际选择的发布资产和编译环境。资源读取、认证和部署位置由宿主注入。

| 输出事实 | 权威输入与规则 |
| --- | --- |
| 引擎与目标 | 校验后的 release：完整 release 身份、原生 engine 身份、可选扩展身份、profile、引擎和绑定版本 |
| API 与命名 | 当前 release 封印的 API IR 与 snake 或 camel 类型快照；沿用 `EngineApiIR` 的类、方法、属性、信号与模块描述 |
| 类型与模块 | 实际声明内容、模块声明路由、所选运行模块和 vendor；区分 release 可提供内容与本次实际装载内容 |
| 编译环境 | `CompilerEnvironment.identity`、现有 compiler policy、TypeScript 版本和目标 |
| 执行 | 选中的浏览器宿主、呈现方式、原生 execution 合同、隔离要求和实际声明 ABI |
| 资源 | 直接 API 符号、ResourceLoader 路线、当前 registry 中的生产器和限制，分别表达 |
| 配额 | 本次调用实际生效的源、资源解码、输出和打包限制，标明由哪一层配置 |

环境视图使用只读、可 JSON 化数据。编译环境对象、读取器、Worker 和其它服务引用作为本地句柄返回，不能与视图一起当作工具 JSON 发送给模型。完整声明和 IR 可以按需读取，首轮不额外建设面向模型的语义检索服务。

复用现有身份即可关联环境，首版不增加全局 environmentId。缺少事实时明确返回 unknown；能力不具备时返回 unsupported 或现有对应错误。环境声明与真实运行验收分别记录。

### 编译环境的薄装配

建议在 `project-tools` 增加一个内部共享入口，暂名 `prepareCompilerEnvironment`。下列是设计参数，尚未实现：

```ts
prepareCompilerEnvironment({
  release,
  naming,
  mode,
  runtimeSelection,
  readAsset,
  signal,
  limits,
});
// 返回只读环境视图与现有 CompilerEnvironment。
```

明确以下行为：

- `release` 使用当前已有发布格式，执行现有完整身份校验；版本标签或 profile 名不能代替实际字节和目标。
- `readAsset` 取得指定资产的原始存储字节。通用代码按描述验证长度、hash、编码和解码后身份，再使用内容；网络、文件、凭据与缓存位置由宿主处理。优先抽取现有校验和解码实现。
- 在首次 await 前捕获 release 描述及其嵌套字段、命名、模式、模块选择和限制；配置数据持有副本，读取器与原 AbortSignal 保留服务引用。完整身份校验本身也可能异步，不能等到校验之后才捕获配置。输入资产在 hash 前取得字节所有权。
- 首版保留普通引擎项目与现有完整 SDK 扩展两条明确路径；普通项目无需下载 React vendor。SDK 选择沿用已有模块与依赖闭包，不承诺任意裁剪。
- 校验完整的实际声明快照；不能删去未使用的声明后沿用原 hash。平台给 AI 的上下文节选与编译器实际声明不同，前者留在平台。
- 复用 `createCompilerEnvironment`，返回对象继续使用现有缓存与声明路由。宿主工具 helper 的 d.ts 留在工具包，不自动进入游戏声明快照。

Playground 的 compiler Worker 首先消费该入口。Node adapter 复用相同的纯装配规则，保留自己的文件读取、输出发布和 CLI 逻辑。

### 资源能力描述

| 维度 | 可以说明什么 | 需要保留的条件 |
| --- | --- | --- |
| 直接 API | 所选 IR 中所需符号存在、缺失或未知 | 符号存在不证明实际输入已解码或加载成功 |
| ResourceLoader | 原生格式可加载，或依赖已经生成的导入输出 | 直接解码 API 不等于 ResourceLoader 可读取源格式 |
| 生产器 | 当前 registry 实际注册的 id、版本、扩展名、输出类型和目标 ABI | 静态格式目录中的名称不能代替真实注册和目标匹配 |
| 参数与预算 | 内建生产器已声明的选项与有效限制 | 自定义生产器未声明的选项保持未知，执行时仍经过 parameters 和 preflight |

复用 `resource-formats.ts`、converter registry 和已有预检。只增加暴露内建生产器元数据所必需的只读方法，不建设通用插件 schema。

PNG、JPEG、PCM WAV 使用现有实现。SVG、GLTF/GLB、OGG 的 API 路线保持其真实范围，不能投影为已提供浏览器自动导入。已有缓存缺少来源证明时继续保留原有评估；显式导入请求与直接 API 读取源数据分别处理。

编辑器的 64 文件、8 MiB 源总量等产品限制继续由 Playground 配置；引擎环境查询不能把它们写成所有平台的固定上限。

## 合同二 一致的检查与构建

### 输入捕获

每次操作使用确定的 `SourceSnapshot`、launch、编译环境、SDK 模式、资源配方、准备选项、打包选项和取消信号。配置先捕获，随后才进行异步工作。

```text
源文件 → SourceSnapshot → BuildPlan
匹配 release 与资产 → CompilerEnvironment
同一 plan 与 environment → check 或 checked build
```

源快照沿用当前字节所有权规则：外部二进制在异步 hash 前捕获，公开读取返回副本，内部复用自己拥有的字节。生成 bootstrap、转换资源和编译输出进入 overlay，原始源文件保持独立。

平台负责按自己的基础版本提交修改和持久化。引擎处理已提交给本次操作的不可变输入；本轮不引入引擎数据库或项目事务服务。

### 检查和构建的含义

| 操作 | 实现与结果 |
| --- | --- |
| check | 复用 `environment.createTypeEnvironment` 和 `checkProjectTypes`；返回本次输入关联及类型诊断，明确 scope 为 typecheck |
| build | 复用 `compileProject`，对同一 plan 检查，再执行准备、资源转换、overlay 与打包；返回既有 checked `CompileResult` |
| 资源预检 | 需要时显式调用已有 converter 校验；不能以 check 通过代替资源预检或真实 native load |

第一版 build 可以重新执行类型检查。只有存在明确复用需要时再优化检查结果缓存；不能用另一个编辑版本的成功 check 为当前构建放行。

### 诊断与失败

编译继续使用 `CompilerDiagnostic` 和 `EngineProjectBuildError.diagnostics`，保留 code、category、文件、行列、范围和消息。运行继续使用 `PreviewDiagnostic` 与 `ExitReport`；真实位置未知时保留缺失值或原始 stack，不伪造作者源码行列。

保留现有 Promise 和错误约定，不把所有函数改成新的 Result 框架。新增装配错误包含明确阶段与错误码，已有错误经过适配时保留诊断。正常类型错误、资源不支持、输入损坏和版本不匹配必须可机器区分。

取消或替换请求后，接入层撤销旧结果发布权限。同步 TypeScript 执行不能仅凭 AbortSignal 宣称立即结束；已执行的资源工作也可能需要完成后才能释放。构建 pin 在 finally 释放。平台决定是否终止执行容器，并记录其影响。

### 身份和调用关联

| 字段 | 语义 |
| --- | --- |
| sourceHash | 当前源快照的路径、编码和内容身份；launch 单独进入构建输入 |
| engineId | 现有原生引擎、宿主和 API 等对应闭包的身份 |
| extensionId | 实际游戏 SDK 扩展模块、vendor 和声明的身份 |
| engineReleaseId | 当前完整 release 的身份 |
| buildKey | 最终语义构建输入的身份，包含实际环境、准备、资源及打包等输入 |
| artifactId | 现有单包外层收据或 ArtifactSet 对应的产物身份 |
| revision、operationId | 由调用者提供的编辑版本与操作关联，不加入内容构建身份 |
| runId、generation | 本次运行与运行输入的关联，不能冒充源、构建或产物 hash |

以返回的 `result.buildKey` 为权威；准备和打包会补充构建输入，不能提前把最初 plan 的 buildKey 当作最终结果。平台的用户、会话、轮次和重试信息留在外层任务记录。

## 合同三 产物与预览衔接

### 保留现有产物分支

| 分支 | 必须保留 |
| --- | --- |
| single-pack | 实际 PCK、最终 buildKey、sourceHash、pack hash、schema 2 receipt、artifactId，以及诊断和导入元数据 |
| pack-set | ArtifactSet manifest 与实际 packs、最终 buildKey、sourceHash、artifactSetId，以及诊断和导入元数据 |

外层 JSON 元数据统一复用 `compileResultMetadata`。集合的 artifactId 对应 artifactSetId；集合没有虚构的 single-PCK hash 和收据。集合挂载要求实际目标提供 artifactSetAbi 1。

产物到 `BrowserArtifact` 的映射先保持一个小型纯适配：接收编译结果、revision 和 generation，按分支填字段，再复用已有捕获与校验。它不能直接 transfer compiler 或缓存仍在使用的 backing buffer。

映射还必须保留当前 `assertCompiledRelease` 和 `assertArtifactTarget` 的配对规则，校验 engineReleaseId、profile、engineId 与项目实际要求的可选 extensionId；集合另外校验其 manifest.target。普通项目未要求扩展时保持允许。`captureBrowserArtifact` 和 runner 的校验不能单独替代这些检查；通用规则复用 `engine/identities`，Playground 的额外产品上下文校验仍由其适配负责。

若该适配接受 `CompileResult` 并需要跨调用方共享，放在 `project-tools` 的可选 browser 入口；`engine` 保持不反向依赖编译器。首版是否导出该 helper 由实际两个调用者的复用需要决定，字段映射和验证行为则必须通过测试固定。

### 默认 Worker 的发布资产装配

建议在 `engine/browser` 增加内部共享入口，暂名 `prepareWorkerRelease`：输入当前 release、实际 runtime 资产描述、资产基础 URL、允许来源和加载策略，输出既有 `VerifiedRelease`。

该入口在首次 await 前拥有 release、runtime 资产描述及嵌套字段、规范化 base URL、allowedOrigins、加载策略和限制的配置副本，捕获读取器及原 AbortSignal 引用。后续调用方修改配置不能改变本次校验目标、资产来源或配对结果。

默认 Dedicated Worker 的 runtime Worker、worklet 和 ABI 来源包括站点 runtime 清单。原生 executionModel 的历史 `window` 值不能被解释为默认产品在页面线程运行。装配需核对选中宿主和实际资产闭包。

继续使用当前 release 和站点格式，不另造发布格式或 identity。发布描述、类型、JS/WASM、runtime Worker、worklet 与已声明 host 的字节校验继续生效。预览来源独立校验自己实际执行的资产；Playground 的 demo、URL query、布局及产品配置留在应用。

能力不足、资产缺失、错 target、错 hash、声明不匹配或集合 ABI 不支持时拒绝本次操作，不通过补 descriptor 字段或静默更换后端绕过。

## 合同四 运行事件与终态

### 生命周期与 ready

沿用 `WorkerPreviewRunner` 的 run、subscribe、stop、command 和 dispose。共享状态与 wire protocol 保持原有版本；本轮优先明确语义和类型，不新增通用 RPC。

```text
调用前校验与捕获
  → 创建 session
  → 加载页面与握手
  → downloading / preloading / initializing / starting / waiting-ready
  → running
  → stopping
  → exited
```

`run()` 返回 running 表示匹配引擎完成当前 `engine.init/start` 合同并发出 running 阶段。它不等待任意异步 `start(ctx)`、首帧或游戏业务就绪。需要业务 ready 的平台自行订阅相应项目事件，并保留其来源。

复用现有阶段 deadline 和停止期限。业务运行时长策略由调用方选择；不为所有游戏增加统一运行时间上限。

### 身份与事件

默认 Worker 保留 `runId`、revision、buildKey、generation、documentId、workerId 和 runConfigurationHash。匹配 release 与产物通过本次运行输入关联，不能只按 revision 归并事件。

当前公共 `RunnerEvent` 以共享 `RunIdentity` 声明；Dedicated 实现实际携带更完整身份。本轮为该后端补准确的事件和退出类型投影，保留共享与兼容入口，不为了类型补齐改变消息协议版本。

| 事件 | 合同 |
| --- | --- |
| state | 当前运行阶段；running 采用上述含义 |
| log | 有界，保留级别与运行身份，继续标记 untrusted；底层未提供的细分来源保持未知，error 文本不自动等于 fatal |
| project | 项目自报的有界 JSON；可用于业务协作，不提升为引擎认证事实 |
| exit | 已创建 session 的唯一终态，保留原始 ExitReport、SessionFacts 和清理结果 |

Playground 可以据此维护有界反馈记录，再关联到 AI task/turn。引擎不负责保存创作会话，也不能将界面显示的“已停止”作为真实清理结果。

### 取消与停止

| 时点 | 调用结果与事实 |
| --- | --- |
| 输入或资产校验失败，session 尚未创建 | run 拒绝；没有运行就不制造 exit 或 native exit code |
| 预创建阶段被 stop 或新 run 撤销 | 按现有行为拒绝 AbortError；已取得资源按拥有者释放 |
| session 已创建、ready 前结束 | run 按现有 E_RUN_ENDED 行为拒绝，session 的 exit 仍仅结算一次 |
| running 后停止 | 等待 stop Promise 和 exit，保留实际原生退出、强停与清理事实 |
| 新 run 替换旧 run | 旧 session 结算后启新运行；旧 ready、project、log 和 exit 不能改变新运行 |

保留 `failure`、nativeExit、forcedTerminationIssued、runtimeSummary、entryCleanup 和 hostCleanup 的独立事实。exit 0 不能覆盖首个 fatal；移除 iframe 不能证明 Worker 或 native 正常退出。协作关闭未确认时返回相应事实。

`command(): boolean` 继续表示本地接纳。transport receipt 表示同步分发结束或丢弃后归还额度，不表示异步 handler 完成。业务执行完成需要平台协议或后续观察，不能在本轮重解释既有 ACK。

## 模块改动清单

以下新增文件名为建议，实施可随调用方调整。

| 位置 | 改动 |
| --- | --- |
| `packages/engine/src/api.ts`、`identities.ts`、`execution.ts` | 复用实际 API、身份和执行事实，按需补纯 DTO 或投影方法 |
| `packages/project-tools/src/environment.ts` | 新增 release 到现有 CompilerEnvironment 的薄装配及环境视图组合 |
| `packages/project-tools/src/resource-formats.ts`、`resource-converters.ts` | 暴露实际内建 producer 的只读描述，复用已有预检 |
| `packages/project-tools/src/compiler.ts` | 保持检查构建主链；按必要补关联和诊断消费，避免重写输出 |
| `packages/engine/src/browser/release-adapter.ts` | 新增默认 Worker 的 VerifiedRelease 装配，复用当前验证和资产读取机制 |
| `packages/engine/src/browser/protocol.ts`、`dedicated/worker-runner.ts` | 补准确的 Worker 事件身份类型，保持运行与退出语义 |
| `apps/playground/src/compiler.worker.ts`、`engine-assets.ts`、`engine-preview.ts` | 改为消费薄装配，保留 demo、界面、存储和产品策略 |
| Node adapter 与现有测试 | 复用纯规则，验证实际调用链和身份一致 |

函数跨包需要复用时增加实际 package export 和声明；不让调用者导入其它包的 src。纯 DTO 与环境投影保持无 DOM 运行时依赖，浏览器入口显式承担 DOM 类型与能力。

## 身份与构建资产的更新规则

| 实际变化 | 更新范围 |
| --- | --- |
| 新增纯工具或装配 helper | 包 JS/d.ts、实际编译 bundle、相应 SDK source/output proof 和受影响站点 |
| 游戏 SDK 声明、vendor 或运行模块改变 | 实际游戏扩展闭包、typesHash、extensionId 及完整 release 引用 |
| 原生 API 或 native 声明改变 | 实际 API、declarationsHash、engineId 和匹配目标 |
| `preview.js` 宿主字节改变 | host hash、HTML SRI、engineId 及 release/站点封印 |
| runtime Worker 或 worklet 改变 | 实际 runtime 资产、candidate/site 闭包与相应证明 |
| converter 输出语义改变 | producer 版本、收据、最终构建与产物身份 |

SDK 工具源码或输出变化不必然要求原生 WASM 重编译，也不要求所有 ID 同时改变。以实际闭包为依据更新；旧 source proof 与新源码不匹配时，重建受影响 SDK 与站点，不绕过冻结校验。

## 核心回归方案

### 包级合同与字节回归

| 组 | 必须验证 | 复用入口 |
| --- | --- | --- |
| 环境与声明 | snake/camel、普通/SDK 路径、实际模块、unknown/unsupported、错声明与资产拒绝 | engine identities、packed consumer；project-tools compiler；Playground type-snapshot |
| 一致输入 | check/build 使用相同快照；异步后修改外部 bytes/options 不污染本次输入；取消不发布、pin 释放 | compiler、incremental、node-output-ownership |
| 资源与产物 | 实际 registry 投影、坏参数/坏输入、单包/集合、缓存冷热一致、集合无伪单包收据 | resource-converters、binary-resource-converters、artifact-set |
| 生命周期 | 首 fatal、command receipt、run race、停止与唯一终态、旧消息拒绝 | runtime-host、session-facts、worker-runner/runtime/session |
| 分发闭包 | 打包后真实隔离安装、新 export、普通入口无 React 运行依赖、声明与源码证明一致 | 既有 packed-consumer、bootstrap-bundle-parity、project-react-template、worker-sdk-proof |

仓库已经有 engine SDK 的真实 npm pack 与离线安装检查，也有静态 Web 引擎包的外部消费验证。本轮扩充已有入口，不再建设一套 publisher。项目工具的新增调用链通过打包后的消费或现有独立测试入口验证，避免 workspace 源码路径掩盖依赖问题。

### 真实浏览器与匹配引擎

先复用现有 `browser-runtime-host-test.mjs`、`browser-schema4-flow-test.mjs` 和 `browser-resource-converters-test.mjs`。增加缺失断言或短模式；只有现有脚本无法清楚表达核心范围时才新增薄 fixture。

| 用例 | 必须观察到的结果 |
| --- | --- |
| 普通场景与显式脚本 | 实际 WASM 与正确输入运行，受控原生节点创建/读回成功，运行关联正确 |
| 按需 React | 同一引擎 realm 运行；普通项目无需加载 vendor；切换入口保持对应环境 |
| 类型错误与修复 | 原始文件诊断明确；错误版本不启动；修复后新产物可运行 |
| 运行异常与修复 | 同步或异步启动失败保留 fatal 和作者栈；随后新运行恢复，旧失败不污染新运行 |
| 正常停止重启 | 记录实际 exit 与 SessionFacts，关闭和清理结果符合对应事实；新运行获得新身份 |
| 启动取消与新版本替换 | 真实请求取消或替换；旧 ready/事件不能进入新运行；区分 session 创建前后 |
| 素材及产物分支 | PNG/WAV 实际加载和替换；JPEG 保留包级 parity；目标声明支持集合时实际验证早期挂载，单包入口仍可用 |
| 拒绝错误输入与失联 | 错 target/hash 拒绝；停止期限或 Worker 失联保留强停/未确认事实；后续会话可恢复 |

类型和字节关系可以用合成 fixture 与生产声明生成器验证，真实引擎用例使用匹配资产。受控 fixture 的原生读回、宿主运行事实和必要画面观察用于验收；任意项目自报 passed/ready/stats 不能单独构成通用成功证明。

测试可使用现有 Playwright 交互或测试侧画面采集，不因此新增产品级截图和输入 API。首条工程回归通过不等于自动玩法验证或跨设备发行认证。

### 执行入口

以下命令均为现有入口。实施后按实际改动选择相关组合；匹配站点必须先按当前构建流程准备，不能用旧 SDK 或旧模板替代。

```sh
pnpm build:packages
pnpm test:engine
node --test scripts/jsb.react-browser/test/worker-runner.test.mjs scripts/jsb.react-browser/test/worker-runtime.test.mjs scripts/jsb.react-browser/test/worker-session.test.mjs
pnpm test:playground
```

真实运行宿主核心回归：

```sh
PLAYGROUND_TEST_DIRECTORY=/absolute/matching-site BROWSER=chromium PLAYGROUND_RUNTIME_HOST_REPORT=/workspace/work/engine-minimum-contracts/runtime-host.json pnpm --filter @godot-js/playground test:browser:runtime-host
```

涉及 Schema 4 适配与素材加载时，复用：

```sh
PLAYGROUND_TEST_DIRECTORY=/absolute/matching-site BROWSER=chromium PLAYGROUND_SCHEMA4_REPORT=/workspace/work/engine-minimum-contracts/schema4.json pnpm --filter @godot-js/playground test:browser:schema4
PLAYGROUND_TEST_DIRECTORY=/absolute/matching-site BROWSER=chromium PLAYGROUND_RESOURCE_REPORT=/workspace/work/engine-minimum-contracts/resources.json pnpm --filter @godot-js/playground test:browser:resource-converters
```

这些脚本的实际浏览器参数、软件 GL 或其它覆盖继续如实进入结果范围。需要验证默认设置时使用对应现有产品回归，不能将工程覆盖结果改写为默认设备认证。

### 报告与 CI

沿用包检查和已有 matching browser job，按改动增加用例。报告至少保留：实际源码与构建来源、站点与 release/资产身份、浏览器版本和启动设置、执行后端与 presenter、每个 case 的输入版本及结果、原始诊断、run identity、退出与清理事实。

基础环境失效或缺少匹配资产时标记 blocked 或未执行；不能使用 mock 或跳过后统计为真实通过。某个用例失败后，独立用例继续收集，依赖其前提的用例明确标注阻塞。失败也上传报告。

本轮只要求明确选定范围内的相关包测试和核心真实回归通过。其余浏览器、设备、压力、性能和发布门禁维持原范围，后续影响到它们时再执行。

## 实施顺序与验收门槛

| 步骤 | 交付 | 完成判定 |
| --- | --- | --- |
| 1 固定合同 | 环境字段、检查范围、产物映射、运行身份与 ready/终态语义 | 对照当前类型和实现完成评审；用例与职责明确 |
| 2 环境装配 | 编译环境薄装配与资源描述，Playground Worker 消费 | 普通/SDK、命名、错资产和同输入测试通过 |
| 3 运行衔接 | VerifiedRelease 装配、产物映射、完整 Worker 事件类型 | 单包/集合与目标校验通过，原有 runner 生命周期行为保持 |
| 4 短真实回归 | 补启动取消、版本替换及必要原生加载断言，记录匹配资产 | 指定 Chromium 与默认 Worker/direct 的核心用例通过 |
| 5 接入交付 | Playground 与非 UI 测试 consumer 使用说明、相关包导出和证明 | 调用方可获得环境并提交输入，取得对应构建、运行和退出结果 |

步骤 2 和步骤 3 可以在字段含义确定后并行。主要工作为 TypeScript 适配与测试，原生重编译仅由实际 ABI 或 native 修复触发；工期取决于匹配资产是否可直接复用，在步骤 1 后按具体改动估算。

本轮完成要求：Playground 可以在既有引擎上接入项目与任务控制器，AI 不需要解析 DOM 文案或模拟点击来调用引擎；关键失败和取消均有准确关联；普通项目、可选 React、资源和启停主链有真实证据。

AI 会话、项目批次回退、画面理解与自动试玩分别沿平台或后续运行能力计划推进。完整第二商业平台、公开 npm 发布和全量矩阵不作为这个前置子方案的交付条件。

## 主要源码与测试依据

- [引擎目标与平台边界](../engine-goals.zh-CN.md)和[下一阶段建议](../engine-next-stage.zh-CN.md)。
- [API IR](../../packages/engine/src/api.ts)、[身份验证](../../packages/engine/src/identities.ts)、[执行合同](../../packages/engine/src/execution.ts)。
- [编译主链](../../packages/project-tools/src/compiler.ts)、[快照和构建计划](../../packages/project-tools/src/build-plan.ts)、[资源格式](../../packages/project-tools/src/resource-formats.ts)。
- [公共预览协议](../../packages/engine/src/browser/protocol.ts)、[Worker runner](../../packages/engine/src/browser/dedicated/worker-runner.ts)、[Worker runtime](../../packages/engine/src/browser/dedicated/worker-runtime.ts)、[退出事实](../../packages/engine/src/session-facts.ts)。
- [当前资产装配](../../apps/playground/src/engine-assets.ts)、[预览适配](../../apps/playground/src/engine-preview.ts)、[预览来源验证](../../apps/playground/src/preview-release-context.ts)。
- [隔离包消费](../../packages/engine/test/packed-consumer.test.mjs)、[真实 RuntimeHost 回归](../../apps/playground/scripts/browser-runtime-host-test.mjs)、[Schema 4 流程](../../apps/playground/scripts/browser-schema4-flow-test.mjs)、[资源真实加载](../../apps/playground/scripts/browser-resource-converters-test.mjs)。
