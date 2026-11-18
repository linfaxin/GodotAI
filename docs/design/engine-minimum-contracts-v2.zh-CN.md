# 引擎最小合同与核心回归实施方案 V2

状态：历史评审稿，当前依据为[第三轮评审汇总的 V4](engine-minimum-contracts-v4.zh-CN.md)，尚未实施。日期：2026 年 11 月 17 日。源码基线：`a518dab`。本版在当时替代[初版](engine-minimum-contracts.zh-CN.md)。

## 开工结论

**可以启动整轮实施。共享合同先落入代码后，编译环境、Worker 发布与事件、产物映射三路可并行；调用方切换和最终回归按依赖合流。** 本文已选定原方案中影响开工的接口和文件归属，无需再进行产品选型。

当前环境具备 Node、相关 JavaScript 依赖和系统 Chromium；尚未定位到匹配的 Web 引擎归档、build report 和产品站点。资产准备可以立即开始，真实引擎回归执行与最终验收等待匹配资产及新 SDK/站点就绪。

“全部开工”表示全部工作包可以按自己的起始条件进入实施或准备，不表示全部最终代码能无依赖并行，也不表示当前已经具备全部验收条件。

## 五个子会话的评审收敛

| 评审视角 | 必须补实的问题 | V2 采用的决定 |
| --- | --- | --- |
| API 与依赖 | raw/decoded 字节混用、共享输入与 exports、runtime 来源被列为开工前 P0；选择、返回值和 target 参数不够具体 | 原始 JSON bytes 输入、唯一 RawAssetReader、共享校验解码、固定新增子路径与返回类型 |
| 构建与资源 | naming IR 缺失、资源 ABI 来源、有效配额虚报、producer 描述与实际执行不一致 | 明确 IR fallback 与 unknown、资源 target 边界、分阶段预算、describe(target) 与执行共用选择规则 |
| 运行与预览 | 站点封印/context 丢失、终态类型不准确、取消与替换顺序过于绝对 | 完整 site 原始字节输入；保留本地镜像和 SRI；observed/local 两分支；沿用实际错误优先级 |
| 实施拆分 | 名称与导出待定、共享文件冲突、新旧逻辑双轨、非 UI consumer 只有说明 | 六个工作包、单一文件 owner、同批切换调用方、实际执行隔离消费者 |
| QA 与环境 | 预检失败无报告、首断言失败不继续独立用例、匹配站点缺失 | 预检纳入报告边界、分组独立运行、短模式汇总、单列环境阻塞 |

这些评审问题已在设计层作出决定；对应代码、测试和环境交付仍由下述工作包完成。当前未发现需要更换架构方向的结论。

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

主验收目标选当前默认 Dedicated Worker、direct 呈现、`full-engine-v1` 和一套明确记录版本的 Chromium，覆盖普通场景、显式 `start(ctx)` 及按需 React。bitmap、2D profile、pthread、其他浏览器与设备沿用各自范围；它们不作为本轮所有改动的先决条件。CI 采用已有固定 Playwright 浏览器，本地系统 Chromium 的工程结果单独记录版本与启动设置。

## 当前基础与需要补齐的部分

| 合同 | 已有实现 | 本轮补齐 |
| --- | --- | --- |
| 环境 | `EngineApiIR`、类型快照、release 身份、执行合同、资源格式和 registry | 投影为可查询事实；将浏览器编译环境的通用装配从工作台中分离 |
| 输入与构建 | `SourceSnapshot`、`BuildPlan`、`CompilerEnvironment`、`checkProjectTypes`、`compileProject` | 明确输入捕获、check 范围、最终构建身份、错误与取消约定 |
| 产物衔接 | `CompileResult`、`compileResultMetadata`、`BrowserArtifact`、`VerifiedRelease` | 统一字段映射与默认 Worker 资产装配，保留 single-pack 和 pack-set 差别 |
| 运行 | `WorkerPreviewRunner`、运行身份、状态与事件、`SessionFacts` | 固定 ready 和终态含义，保留完整身份、原始退出事实与命令接纳语义 |
| 回归 | 隔离包消费、编译一致性、资源及真实 RuntimeHost 测试 | 补真实启动取消、新运行替换等缺项断言，汇总本轮实际执行范围 |

实施主要复用 `packages/engine`、`packages/project-tools` 和既有浏览器测试；不新建通用服务包或另一套 compiler、runner、产物协议。

## 本轮采用的接口与归属

函数和子路径按下表实施，后续可随调用者一起重构，不构成长期公开 ABI 承诺。

| 入口 | 职责 | 生产消费者 |
| --- | --- | --- |
| `@godot-js/engine/release-assets` | 最小资产描述、原始 release 输入、RawAssetReader、公共 verifyAndDecodeAsset | 新环境装配、现有浏览器与 Node 资产 wrapper |
| `@godot-js/project-tools/environment` | prepareCompilerEnvironmentInput、基础环境事实、资源事实组合 | Playground compiler Worker、Node adapter、隔离 consumer |
| `@godot-js/engine/browser/release-adapter` | prepareWorkerRelease、发布与站点配对、VerifiedRelease 装配 | Playground 预览适配与测试 consumer |
| `@godot-js/project-tools/browser` | prepareBrowserArtifact：现有编译响应数据到 BrowserArtifact | Playground 运行入口、非 UI consumer |
| 既有 Dedicated Worker runner 入口 | WorkerRunnerEvent 和 WorkerRunnerExit 的精确类型 | Playground、兼容 reexport 与类型消费 fixture |

共享数据和字节接口固定为以下最小形状。代码为本轮实施合同，当前尚不存在这些新增实现。

```ts
type StoredAsset = Readonly<{
  path: string; sha256: string; bytes: number;
  encoding?: 'gzip'; decodedSha256?: string; decodedBytes?: number;
  maxDecodedBytes?: number;
}>;
type ReleaseInput = Readonly<{descriptorBytes: Uint8Array}>;
type AssetReadLimits = Readonly<{
  maxStoredBytes: number; maxDecodedBytes: number;
}>;
type RawAssetReader = (
  asset: StoredAsset,
  options: {signal?: AbortSignal; maxStoredBytes: number},
) => Promise<Uint8Array>;

type RuntimeSelection =
  | {kind: 'engine'}
  | {kind: 'sdk'; mode: 'development' | 'production'};
type ReleaseFacts = Readonly<{
  releaseId: string; descriptorSha256: string; engineProfile: string;
  engineId?: string; extensionId?: string;
  artifactReceiptVersion?: 2; artifactSetAbi?: 1;
}>;
interface CompilerEnvironmentInputFacts {
  readonly release: ReleaseFacts;
  readonly naming: 'snake' | 'camel';
  readonly selection: RuntimeSelection;
  readonly requiredExtensionId?: string;
  readonly bindingVersion?: string;
  readonly compilerPolicy: string;
  readonly typescriptVersion: string;
  readonly baseRuntimeModules: readonly string[];
  readonly assetReadLimits: AssetReadLimits;
  readonly api: Readonly<{
    status: 'available' | 'unknown'; reason?: string;
  }>;
  readonly resources: Readonly<
    | {status: 'available'; target: ImportTarget}
    | {status: 'unknown'; reason: string}
  >;
}

declare function verifyAndDecodeAsset(
  bytes: Uint8Array, asset: StoredAsset,
  options: AssetReadLimits & {signal?: AbortSignal},
): Promise<Uint8Array>;

declare function prepareCompilerEnvironmentInput(input: ReleaseInput & {
  naming: 'snake' | 'camel'; selection: RuntimeSelection;
  readRawAsset: RawAssetReader; signal?: AbortSignal;
  assetReadLimits?: Partial<AssetReadLimits>;
}): Promise<{
  input: CompilerEnvironmentInput;
  facts: Readonly<CompilerEnvironmentInputFacts>;
  api?: EngineApiIR;
}>;

declare function prepareWorkerRelease(input: ReleaseInput & {
  siteManifestBytes: Uint8Array;
  previewBaseUrl: string;
  presentationBackend: 'direct' | 'bitmap';
  allowedOrigins: readonly string[];
  cachePolicy: 'revalidate' | 'public-immutable';
  signal?: AbortSignal;
}): Promise<{
  release: VerifiedRelease;
  facts: ReleaseFacts & Readonly<{candidateId: string}>;
}>;
```

`CompilerEnvironmentInputFacts` 必须包含 release facts、naming、捕获的 selection、bindingVersion、compilerPolicy、typescriptVersion、基础 runtimeModules、assetReadLimits、API 查询状态和资源目标。它描述通用 helper 已验证的基础输入，不能含函数、凭据、缓存或 Worker。调用方扩展后的实际环境，以最终 `CompilerEnvironment.identity` 和 runtimeModules 为准，不能把基础 facts 当作最终适配身份。`api` 存在时是已经校验且命名匹配的 IR，缺失时相关查询为 unknown。

release facts 中的 extensionId 表示发布可提供的扩展。`environment.identity.target` 仅在 SDK 被选择时包含该扩展，不直接展开全部 release facts 作为构建 target；facts 另记录本次 requiredExtensionId。完整 native descriptor 保留原 JSON 格式与现有验证，无需为所有未来字段新建公共 schema。

上述资产入口使用 Node/浏览器共有的 Web 标准能力，不依赖 Document、Worker 构造或 Node fs。原有 runtime/session-facts 的 ES2022-only 消费合同保持不变；涉及 AbortSignal 的工具入口使用其宿主的相应类型声明，不把它们自动加入游戏类型。

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
| 配额 | 环境装配报告实际执行的资产读取和解码限制；源、资源、pack 与集合限制由对应构建步骤报告 |

环境视图使用只读、可 JSON 化数据。编译环境对象、读取器、Worker 和其它服务引用作为本地句柄返回，不能与视图一起当作工具 JSON 发送给模型。完整声明和 IR 可以按需读取，首轮不额外建设面向模型的语义检索服务。

复用现有身份即可关联环境，首版不增加全局 environmentId。缺少事实时明确返回 unknown；能力不具备时返回 unsupported 或现有对应错误。环境声明与真实运行验收分别记录。

### 编译环境的薄装配

按上述 `@godot-js/project-tools/environment` 的 `prepareCompilerEnvironmentInput` 合同实施，返回 `{input, facts, api?}`。input 复用现有 `CompilerEnvironmentInput`，持有本次已校验的声明、路由、模块与 vendor 字节。两条 selection 由调用者根据该次源快照的实际依赖选择；helper 不根据 scene/script launch 猜测框架。

明确以下行为：

- `descriptorBytes` 是原始 release JSON 文件的精确字节，在首次 await 前取得副本，再解析完整描述并执行现有 `assertNativeReleaseIdentity`。descriptorSha256 计算原始字节，releaseId 沿用既有 canonical 身份；两者不能混用。
- `readRawAsset` 只取得与描述存储 hash 对应的内容字节，尚未应用 descriptor.encoding。网络、文件、凭据和缓存位置由宿主处理；读取阶段执行 maxStoredBytes，返回后通用代码仍检查实际长度。
- 从现有 loader/Node wrapper 抽取唯一 `verifyAndDecodeAsset`：先拥有精确视图的副本，检查长度与存储 hash，再限额解码并核对 decodedBytes/decodedSha256。未声明编码则不解码；解码额度取调用上限、描述上限和已有实现硬限制的最小值。
- 现有 `fetchVerifiedAsset`、应用 `fetchReleaseAsset` 和 Node `releaseAsset` 返回已解码字节，不能直接作为 RawAssetReader。迁移时拆开 IO 与 verify/decode；旧 wrapper 委托同一验证解码实现。已解码缓存不能送入 raw 回调，HTTP 传输编码不能导致同一显式 gzip 被处理两次，不增加自动猜测分支。
- 所有配置在首次 await 前捕获，包括原始 bytes、命名、selection 嵌套字段、限制。读取器与原 AbortSignal 保留引用；替换调用方 options.signal 不改变本次取消信号，原信号后续 abort 仍有效。
- `engine` 选择不读取 vendor/runtimeModules，也不把 available extensionId 当作构建依赖。`sdk` 选择当前 release 中对应 mode 的完整 vendor、moduleContract 和 runtimeModules；现代 release 缺项即失败，不从另一 mode、其它 release 或内置常量补齐。
- 校验完整的实际声明快照；不能删去未使用的声明后沿用原 hash。平台给 AI 的上下文节选与编译器实际声明不同，前者留在平台。
- 返回 input 的容器和字节由本次调用拥有；不能把可变缓存缓冲区直接交出。调用方完成显式扩展后仅调用一次现有 `createCompilerEnvironment`，由它捕获最终真实输入并计算身份。宿主工具 helper 的 d.ts 留在工具包，不自动进入游戏声明快照。

Playground 与 Node 的生产调用在同一集成工作包切换到该实现。普通调用直接 `createCompilerEnvironment(prepared.input)`；Playground 将已有 demo 声明与模块合入基础输入，Playground/Node 对历史项目应用现有模块路由适配，再创建一次最终环境：

```ts
const prepared = await prepareCompilerEnvironmentInput(options);
const finalInput = applyExistingHostAdapters(prepared.input); // 调用方现有逻辑
const environment = await createCompilerEnvironment(finalInput);
// check 与 build 使用同一个 environment；最终 identity 由真实字节决定。
```

这里的 `applyExistingHostAdapters` 仅示意调用方现有组合，不是新增引擎 API。组合保留基础 release/native target 和资源证明，不再次选择、下载或验证基础资产；扩展声明、路由、模块、vendor 与现有 compatibilityAdapter 身份共同进入最终环境。历史启动适配原有 `preparePlan/adapterIdentity` 继续保留，demo、历史框架策略不进入通用 helper，也无需给 CompilerEnvironment 增加 getters。普通选择中出现 SDK runtime import 时，现有构建依赖检查返回缺少模块/选择的诊断，不假装 SDK 已装载。

### 命名与 API IR 选择

1. 优先使用 `api.namingProfiles[naming]` 的完整 typeSnapshot；默认 snake 可沿用既有顶层快照 fallback。camel 未提供对应类型快照时明确拒绝该环境，不能默取 snake。
2. 对实际快照执行完整类型内容校验。项目 `project.godot` 的 naming 设置发生变化后，接入层重新选择匹配环境；不能复用旧 naming 的已检查结果。
3. IR 优先取所选 profile.ir。仅默认 snake 可使用顶层 IR fallback，并核对实际 bindingNaming；camel 缺对应 IR 时不借用 snake。
4. IR 存在时核对其资产字节、parseEngineApi 结构、bindingNaming、engine.version、绑定与命名版本，以及封印的模块/目标信息。使用现有 producer 的规则，不另造 canonical hash 算法。
5. 对应 IR 缺失但类型快照有效时，编译环境仍可成立，API 与依赖它的直接符号查询报告 unknown。已经提供的 IR 读取失败、hash 错误或 naming 不匹配属于失败，不能降级为 unknown 或切换其它 profile。

完整声明快照保留原字节与内容身份。给模型的节选不进入 compiler；普通路径虽可校验包含 SDK 声明的快照，也不因此下载 SDK vendor 或把扩展加入运行 target。

### 资源能力描述

| 维度 | 可以说明什么 | 需要保留的条件 |
| --- | --- | --- |
| 直接 API | 所选 IR 中所需符号存在、缺失或未知 | 符号存在不证明实际输入已解码或加载成功 |
| ResourceLoader | 原生格式可加载，或依赖已经生成的导入输出 | 直接解码 API 不等于 ResourceLoader 可读取源格式 |
| 生产器 | 当前 registry 实际注册的 id、版本、扩展名、输出类型和目标 ABI | 静态格式目录中的名称不能代替真实注册和目标匹配 |
| 参数与预算 | 内建生产器已声明的选项与有效限制 | 自定义生产器未声明的选项保持未知，执行时仍经过 parameters 和 preflight |

复用 `resource-formats.ts`、converter registry 和已有预检。registry 增加 `describe(target)`，与 `run()` 共用“有效 producer 选择”规则，返回捕获的 id/version/extensions/output、目标 recipe 兼容状态和已声明的选项说明。legacy target 下 WAV 可能采用兼容生产器，描述必须与实际执行一致。

描述内建参数依据注册时捕获的实际内建对象及版本，不能按同名 id 给自定义 producer 套用内建能力。查询不执行自定义 parameters、preflight 或 convert；未声明选项和目标支持保持 unknown。实际字节与参数校验继续在执行时完成。

PNG、JPEG、PCM WAV 使用现有实现。资源 target 由共享的当前支持映射和实际已校验 release 引擎版本产生，并绑定实际 engineId；当前 binary producer 的输入 ABI 仍是 `godot-4.6.1-resources-v2`，不是 execution 清单现有字段。未知版本不凭 registry 或 profile 推断支持；描述为 unknown，显式转换无法配对时拒绝。输入 target ABI 与 CTEX/RSRC 输出 ABI 分开。

该目标通过 `facts.resources` 返回：已配对时为 available 和现有 `ImportTarget`，调用方将同一 target 交给 `registry.describe(target)` 与 `PrepareBuildPlanOptions.resourceTarget`；未知时返回 unknown/reason，不能由 Playground 或 Node 再解析 release、继续硬编码 ABI。helper 不持有 registry，生产器事实由调用方选定的实际 registry 查询。目标及嵌套 features 是捕获的只读 JSON 数据。

SVG、GLTF/GLB、OGG 的 API 路线保持真实范围，不能投影为浏览器自动导入。已有缓存缺少来源证明时保留原有评估；显式导入请求与直接 API 读取源数据分别处理。

### 配额的执行范围

| 分区 | 执行者与报告规则 |
| --- | --- |
| assets | RawAssetReader 有界读取，verifyAndDecodeAsset 检查与限额解码；环境 facts 只报告这一组有效值。编译资产默认沿用当前读取器的 64 MiB 存储/解码上限，可按现有校验配置 |
| source | createSourceSnapshot/applySourceSnapshotDelta 实际捕获时执行文件数和源字节限制；调用关联记录该次使用值 |
| conversion | registry.run 执行单资源解码与整个转换批次输出预算；最终 maxOutputBytes 与 packBudget 取现有规则的最小值 |
| pack | 现有 PCK writer 计入头、目录和对齐后执行每包限制 |
| artifactSet | 现有集合实现执行每包、包数、索引与全集限制；每包 pack.maxBytes 不能冒充集合总量额度 |

沿用现有可配置字段和硬上限，不为每个内部常量新增开关。未实际执行的额度只标作 default/configured/unknown；不能在环境视图中声称后续任意构建已经应用这些限制。

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

产物到 `BrowserArtifact` 的映射确定为 `@godot-js/project-tools/browser` 导出的 `prepareBrowserArtifact`。本轮已有 Playground 与非 UI consumer 两个实际消费者，统一使用该实现。

```ts
type CompiledArtifactData =
  | {variant: 'single-pack'; pack: Uint8Array;
     manifest: Readonly<Record<string, unknown>>}
  | {variant: 'pack-set'; artifactSet: ArtifactSet;
     manifest: Readonly<Record<string, unknown>>};

declare function prepareBrowserArtifact(input: {
  output: CompiledArtifactData;
  target: ReleaseFacts;
  revision: Revision;
  generation: Revision;
}): Promise<BrowserArtifact>;
```

这是现有编译响应字段的视图，不新增 wire protocol。编译位置先调用 `compileResultMetadata(result)` 形成 manifest，再传单包或集合。完整 plan、CompilerEnvironment 和 services 不跨 Worker 传输。适配在首次 await 前捕获 expected target、元数据和精确包字节/集合闭包，复用已有 capture/identity 函数，不能转移 compiler/cache 正在复用的 buffer。

target 来自已校验的准备上下文，不能由产物自报生成。映射保留当前 target 配对规则：将 target.releaseId 对应到 manifest.engineReleaseId，比较 profile、engineId 与项目实际要求的可选 extensionId；集合另外核对 manifest.target、artifactSetAbi 和集合身份。普通项目未要求扩展时保持允许。单包还核对实际 pack、receipt、buildKey/sourceHash 与外层 artifactId；集合不伪造 source 收据或 single-PCK hash。

`captureBrowserArtifact` 和 runner 不能单独代替 expected target 检查。通用规则复用 `engine/identities`；Playground 的 candidate、demo 和 canonical 来源 context 检查留在应用。`engine` 不反向依赖 compiler，`project-tools/browser` 不从纯根入口重新导出，以保留浏览器依赖边界。

### 默认 Worker 的发布资产装配

按 `@godot-js/engine/browser/release-adapter` 的 `prepareWorkerRelease` 合同实施。输入原始 descriptorBytes、完整 schema 3 siteManifestBytes、previewBaseUrl、明确 presenter、allowedOrigins 和 cachePolicy，返回 `{release: VerifiedRelease, facts}`。

首次 await 前捕获两份精确 JSON bytes、规范化 URL、presenter、allowedOrigins、cachePolicy 和原信号；不能在 hash 后再读取调用方的可变 site/runtime。验证完整 release 身份，site 中 engine-release.json 的原始 hash/bytes 封印、profile/releaseId、runtime backend/ABI、presenter 及 entry/worklet/payload 引用。candidateId 是 site 原始字节的 SHA，不是重序列化 JSON 的 hash。

runtime 必须从已经配对的完整 site 内取得，不能传裸 runtime 对象后称为已验证。默认 Dedicated Worker 的实际宿主由该 runtime 合同确定，原生 executionModel 的历史 `window` 值不代表页面线程执行。该函数只验证描述与引用、准备 URL，不提前下载全部 JS/WASM/worklet；真实内容仍由现有 loader 消费时逐项校验。

来源与预览镜像分开：Playground 捕获的 ReleaseContext.releaseRoot 保持编辑器 canonical 来源；previewBaseUrl 只决定实际预览资产 URL，合法镜像可以使用不同 origin 和路径。首版沿用完整镜像策略，所有实际 engine/runtime/worklet 资产相对该 preview root；allowedOrigins 不使任意 CDN 混合部署自动成为受支持范围。public-immutable 只用于站点实际声明公开的资产，其余保持 revalidate。

通用 facts 返回 descriptorSha256/candidateId 和 release 目标。Playground 将它们与自己捕获的 releaseRoot、demoDescriptorHash、publicAssets 组成原有 ReleaseContext，并继续附加在传给 runner 的 release 对象上、保留在编译 metadata 中。`preview.ts` 的 verifyRelease callback、预览端独立读取本地镜像、host 实际字节和正在执行 script 的 SRI 检查全部保留。prepare 成功不取代这些检查。

继续使用当前 release 和站点格式，不另造发布格式或 identity。新旧 helper 的生产路径在统一迁移后只保留一份通用实现；demo、URL query、布局和产品策略留在应用。

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

共享 `RunnerEvent`、`ExitReport` 和兼容 PreviewRunner 的四字段身份保持原状。Dedicated 增加 `WorkerRunnerEvent`、`WorkerRunnerExit`，状态/日志/项目事件顶层携七字段，exit 的七字段位于 report，run 返回七字段加 releaseId。兼容 reexport 指向同一定义，不复制。

终态固定区分以下两种现有事实形状，不新增 wire discriminator：

```ts
type WorkerObservedExit = Omit<ExitReport, 'reason' | 'cleanup' | 'sessionFacts'>
  & WorkerRunIdentity & {
    reason: SessionExitReason;
    engineOutcome: Readonly<WorkerEngineOutcome>;
    hostCleanup: Readonly<WorkerHostCleanupOutcome>;
    sessionFacts: SessionFacts;
  };
type WorkerLocalExit = Omit<ExitReport, 'reason' | 'cleanup' | 'sessionFacts' | 'code'>
  & WorkerRunIdentity & {
    reason: 'crashed' | 'forced-frame-disposal';
    code?: never; engineOutcome?: never;
    hostCleanup?: never; sessionFacts?: never;
  };
type WorkerRunnerExit = WorkerObservedExit | WorkerLocalExit;
type WorkerRunnerEvent =
  | (Exclude<RunnerEvent, {type: 'exit'}> & WorkerRunIdentity)
  | {type: 'exit'; report: WorkerRunnerExit};
```

observed 分支来自 runner 校验过的真实 host 回执，reason 仍由 SessionFacts 投影；local 分支覆盖页面/握手失败、停止通道丢失或期限等本地兜底，不伪造 host/native 事实。`worker-session.ts` 现有 WorkerExitReport 是内部 ledger，不能直接当成公共最终终态。Worker 的 hostCleanup 不与旧 PreviewRunner 的计数型 cleanup 混用。

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
| 新输入同步或异步校验失败，尚未替换 active session | 本次 run 拒绝实际错误，旧运行保持有效；失败的新调用不制造 exit/native code |
| 预创建操作被 stop 或新 run 撤销 | 在 await 成功后的失效检查点拒绝 AbortError；若 await 本身失败，保留实际校验错误。已取得资源按拥有者释放 |
| session 已创建、ready 前结束 | run 按现有 E_RUN_ENDED 行为拒绝，session 的 exit 仍仅结算一次 |
| running 后停止 | 等待 stop Promise 和 exit，保留实际原生退出、强停与清理事实 |
| 新 run 替换旧 run | 默认 Worker 先完成新输入预检查和捕获，再停止旧 active session、创建新 session；旧事件不改变新运行 |
| stop 时没有 active session | 返回 undefined，不制造退出事实；准备中的请求仍按序号撤销规则处理 |

兼容 PreviewRunner 的既有时序与默认 Worker 不同，不能通过共用新 helper 悄悄统一。超时、失联或强停的 reason 可能因已有 fatal 被投影为 crashed，验收应检查实际 facts，不能要求所有 watchdog 都得到 unresponsive。

保留 `failure`、nativeExit、forcedTerminationIssued、runtimeSummary、entryCleanup 和 hostCleanup 的独立事实。exit 0 不能覆盖首个 fatal；移除 iframe 不能证明 Worker 或 native 正常退出。协作关闭未确认时返回相应事实。

`command(): boolean` 继续表示本地接纳。transport receipt 表示同步分发结束或丢弃后归还额度，不表示异步 handler 完成。业务执行完成需要平台协议或后续观察，不能在本轮重解释既有 ACK。

## 模块改动清单

以下归属用于本轮并行分工；变更由对应 owner 合流，避免多个实现者同时改应用或 exports。

| 位置 | 改动 |
| --- | --- |
| `packages/engine/src/release-assets.ts` | W0 落共享 DTO 与实际类型入口，随后 W1 独占公共 verify/decode 实现；不发布假成功 stub |
| `packages/project-tools/src/environment.ts`、资源格式/registry 与对应包内测试 | W1：环境输入装配、资源目标和只读事实；复用现有 compiler，不同时修改应用调用点 |
| `packages/engine/src/browser/verified-loader.ts` | W1：原有 IO wrapper 委托公共 verify/decode；W2 不重复改解码逻辑 |
| `packages/engine/src/browser/release-adapter.ts`、`dedicated/worker-runner.ts` 及对应测试 | W2：发布装配、事件与 observed/local 终态；共享 protocol 仅作必要类型复用 |
| `packages/project-tools/src/browser/prepare-artifact.ts` 与对应测试 | W3：编译响应数据、expected target 与产物捕获映射；不重写 compiler |
| `apps/playground/src/compiler.worker.ts`、`engine-assets.ts`、`engine-preview.ts`、预览验证与 Node adapter | W4 独占调用方统一切换，保留产品上下文和 IO；移除旧通用实现 |
| 两个 package.json、最终 reexports、Playground package scripts | W0 仅增加已经落地的共享类型入口；W4 汇总其余实际 exports 与入口，其他包提交清单而不抢写 |
| `apps/playground/scripts/browser-*-test.mjs`、短回归汇总器、CI 对应步骤 | W5：报告预检、core 分组、独立失败收集与匹配站点验收 |

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

复用现有 `browser-runtime-host-test.mjs`、`browser-schema4-flow-test.mjs` 和 `browser-resource-converters-test.mjs` 的 fixture、站点服务与浏览器配置。本轮确定增加薄汇总入口 `test:browser:contracts`，对应 `apps/playground/scripts/browser-engine-contracts-test.mjs`；不复制完整测试框架。相关核心场景抽为可独立执行的分组，既有专项命令继续可用。

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

短回归分为 `preflight`、`lifecycle`、`failure-recovery`、`replacement`、`entry-resources` 五组。preflight 先验证站点与资产；其余组各自创建 page/context，在 finally 中释放资源。某组断言失败后继续独立组，同组依赖步骤记为 blockedBy，不能当作通过。React、素材和集合是已有分支的受控用例，按合同支持情况记录明确结果。聚合器不能以 `cmd1 && cmd2` 串接；沿用已有 acceptance context 和 finally 清理。

### 执行入口

以下包检查和三个浏览器专项命令为现有入口。新增短回归命令在 W5 落地；当前尚不能执行它。实施后按实际改动选择相关组合；匹配站点必须先按当前构建流程准备，不能用旧 SDK 或旧模板替代。

```sh
pnpm build:packages
pnpm test:engine
node --test scripts/jsb.react-browser/test/worker-runner.test.mjs scripts/jsb.react-browser/test/worker-runtime.test.mjs scripts/jsb.react-browser/test/worker-session.test.mjs
pnpm test:playground
```

本轮新增的短回归入口：

```sh
PLAYGROUND_TEST_DIRECTORY=/absolute/matching-site BROWSER=chromium PLAYGROUND_ENGINE_CONTRACT_REPORT=/workspace/work/engine-minimum-contracts/contracts.json pnpm --filter @godot-js/playground test:browser:contracts
```

本地显式选系统 Chromium 时设置现有 harness 支持的 `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium`。CI 继续采用其固定 Playwright 浏览器，报告实际路径、版本与 flags；不混用其它脚本的 `BROWSER_EXECUTABLE`。

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

沿用包检查、已有 matching browser job 与 always 上传。报告至少保留：实际源码与构建来源、站点与 release/资产身份、浏览器版本和启动设置、执行后端与 presenter、每个 case 的输入版本及结果、原始诊断、run identity、退出与清理事实。

当前三个专项脚本在报告保护边界之前读取 manifest/release，缺站点时可能没有 JSON。本轮将预检移入报告保护边界，先建立报告，再做文件读取、资产校验、浏览器启动。缺文件、缺可运行浏览器等前提不足标记 blocked；提供的资产格式损坏、hash/身份错误以及合同断言失败标记 failed，不以“环境问题”掩盖实际失败。报告写入本身不可用时保留 stderr 与非零退出。

报告增加 requiredGroups、每组 status、case 的 passed/failed/blocked、blockedBy、未执行原因和总结果。required 组未执行或 blocked 时总结果不能为 passed，存在 required failed/blocked 时进程非零退出。汇总所有已取得的失败；某个独立组失败不终止其它组。无法运行真实引擎时不能以 mock、跳过或仅包级通过代替。

复用 `.github/workflows/misc_packages.yml` 以及已有浏览器工作流的匹配站点构建、`test:engine` 和失败上传能力，加入该短入口及报告；不复制一套全量矩阵。站点的 source/SDK proof 变化按真实资产闭包重建，不能复用不匹配的旧报告。

本轮只要求明确选定范围内的相关包测试和核心真实回归通过。其余浏览器、设备、压力、性能和发布门禁维持原范围，后续影响到它们时再执行。

## 六个工作包与依赖

| 工作包 | 实施与文件 owner | 起始条件 | 完成判定 |
| --- | --- | --- | --- |
| W0 合同落码 | 共享 DTO、原始资产边界、入口类型、Worker 终态与错误语义，形成下游接口基线 | 可以立即开始 | 与本文一致的类型和实际共享入口提交；类型 fixture 通过；不存在假成功 stub |
| W1 环境与资源 | release-assets 实现、project-tools/environment、registry.describe(target) 和对应测试；公共 decoder 接入 verified-loader | W0 共享合同落码 | 普通/SDK、snake/camel、IR unknown 与损坏、raw/gzip、预算与取消、实际 producer 描述通过 |
| W2 Worker 发布与事件 | release-adapter、dedicated runner 的完整身份、observed/local 终态与对应测试 | W0 共享合同落码 | 完整站点封印与 target 拒绝、镜像/context 保留、run/ready/取消/替换/唯一终态合同通过 |
| W3 产物衔接 | project-tools/browser 的 prepareBrowserArtifact 与对应测试 | W0 共享合同落码 | 实际编译响应数据可映射；expected target、单包收据、集合闭包、字节拥有权正确 |
| W4 调用方与分发 | 独占 Playground、Node adapter 切换，汇总 package exports 与示例 consumer | W1/W2/W3 接口已有实现；迁移清单可先准备 | 两类生产调用使用公共基础装配，旧重复实现移除；demo/历史适配仍可用；打包隔离消费者执行新合同 |
| W5 核心回归与环境 | 独占浏览器测试脚本、短汇总、CI 报告；准备匹配站点 | 资产定位、报告/preflight/fixture 可立即开始；最终执行等 W4 和匹配站点 | 指定 Chromium、默认 Worker/direct、full-engine-v1 的 required 核心组真实通过，报告与失败上传完整 |

依赖为 **W0 → W1/W2/W3 并行 → W4 → W5 最终验收**。W5 的环境准备和报告改造可先行，不等于可以提前完成真实引擎验收。W0 负责形状与已落地的类型入口，W1 随后独占公共实现文件，W2 独占 Worker 终态实现；共同文件的后续改动交 owner 合并。

每个工作包增加与其合同有关的最小必要测试。W4 统一修改两个 package.json 与 Playground 调用方；W5 提交 scripts/CI 需求由 W4 合并，避免共享文件争用。build:packages、共享 dist/站点生成串行执行；并行测试需要独立输出目录，不能让多个任务覆写同一产物或冻结报告。

非 UI consumer 不是使用说明：复用真实 npm pack/隔离安装 fixture，安装构建后的 engine 与 project-tools 包，禁止导入 workspace src。执行新环境输入装配、创建最终环境、check/build、prepareBrowserArtifact 和 prepareWorkerRelease；浏览器部分在匹配站点的独立页面实际 run/stop 并读取完整事件。Node 部分不构造 DOM；浏览器部分使用明确的浏览器子入口。由此验证通用合同没有暗含 Playground 页面或 React 服务依赖。

## 当前环境与资产准备判断

以下为本次只读预检结果，不是新代码的测试结果，也没有进行依赖安装、包构建、浏览器启动或真实引擎回归。

| 前提 | 已确认的事实 | 对开工的影响 |
| --- | --- | --- |
| Node / 包管理器 | Node 24.19.0，`.node-version` 指定 24.15.0；全局 pnpm 11.25.0，仓库声明 10.11.0 | 开始构建前按仓库约定对齐工具版本并验证 frozen install；尚未验证，不能先认定安装失败 |
| JavaScript 依赖 | TypeScript 6.0.3、esbuild 0.25.12、Playwright 1.57.0 可解析 | 可开始合同和 TypeScript 实施；最终以实际构建为准 |
| 浏览器 | `/usr/bin/chromium` 154.0.8037.57 存在，harness 可回退系统 Chromium；Playwright 下载缓存缺失 | 不能因缓存缺失认定无浏览器；尚未启动，GPU/音频可用性待实测；CI 使用固定浏览器 |
| 原生宿主 | 默认 PATH Godot 是 4.6.3；另有 4.6.1 SDK 宿主与 tests/bin/godot-host-qjs | 不能将默认版本混入 4.6.1 匹配链；原生可执行文件不是 Web ABI/源码证明 |
| 匹配 Web 站点 | 尚未定位到本地 Web WASM/template、release/build report、Playground dist | 阻塞当前真实 Web 回归及最终验收；不阻塞 W0–W3 或 W5 准备 |
| Web 重建工具链 | PATH 未发现 emcc/scons；其它托管绝对路径未全面核实 | 尚不能保证可从源码重建，也不能断言工具链不存在；先定位现成可信资产 |

资产准备采用以下顺序：

1. 优先定位或获取既有 CI 的可信匹配 Web/portable 归档、build report 和完整性记录。校验真实资产 hash、release/site 封印、SDK/native source proof、recipe 与 ABI，不能仅凭相同版本号或 commit 判定可复用。
2. 对本轮纯 helper/SDK 变化重建受影响包、SDK proof 与站点。原生 ABI 和宿主闭包未变时，不默认触发 WASM 全量重编译；preview.js 等受封印宿主改变时按前述规则更新对应身份。
3. 没有可复用资产时，准备匹配 Godot 4.6.1 源码、依赖和 Web 工具链，按已有工作流构建并产出证明。浏览器启动、服务头、worker/direct 与受控音频能力在 preflight 中实测。

W5 必须交付可复现的站点准备命令、资产路径/来源及报告。当前唯一已确认的最终验收缺口是匹配 Web 资产尚未就绪；包管理器、浏览器运行和重建工具链仍需验证，不应预先宣称通过。

## 是否可全部开工与完成标准

**设计上可以整体开工，没有待选的 P0 架构决策。** W0 和 W5 准备立即启动；W0 合入后展开 W1–W3，再合流 W4 和真实验收。当前没有证据支持“全部任务可以无依赖同时实施”，也没有证据支持“当前即可完成全部验收”。匹配资产应与合同落码同步准备，避免最后才暴露环境阻塞。

本轮完成要求：Playground 和隔离非 UI consumer 均可通过引擎合同获得准确的基础与最终环境，提交同一项目输入并取得对应检查、构建、运行和退出事实；关键失败、取消与替换准确关联；普通项目、可选 React、资源和启停主链有真实证据；生产调用无长期双轨的 release 选择与验证实现。

AI 会话、项目批次回退、画面理解与自动试玩分别沿平台或后续运行能力计划推进。完整第二商业平台、公开 npm 发布和全量矩阵不作为这个前置子方案的交付条件。

## 主要源码与测试依据

- [引擎目标与平台边界](../engine-goals.zh-CN.md)和[下一阶段建议](../engine-next-stage.zh-CN.md)。
- [API IR](../../packages/engine/src/api.ts)、[身份验证](../../packages/engine/src/identities.ts)、[执行合同](../../packages/engine/src/execution.ts)。
- [编译主链](../../packages/project-tools/src/compiler.ts)、[快照和构建计划](../../packages/project-tools/src/build-plan.ts)、[资源格式](../../packages/project-tools/src/resource-formats.ts)。
- [公共预览协议](../../packages/engine/src/browser/protocol.ts)、[Worker runner](../../packages/engine/src/browser/dedicated/worker-runner.ts)、[Worker runtime](../../packages/engine/src/browser/dedicated/worker-runtime.ts)、[退出事实](../../packages/engine/src/session-facts.ts)。
- [当前资产装配](../../apps/playground/src/engine-assets.ts)、[预览适配](../../apps/playground/src/engine-preview.ts)、[预览来源验证](../../apps/playground/src/preview-release-context.ts)。
- [隔离包消费](../../packages/engine/test/packed-consumer.test.mjs)、[真实 RuntimeHost 回归](../../apps/playground/scripts/browser-runtime-host-test.mjs)、[Schema 4 流程](../../apps/playground/scripts/browser-schema4-flow-test.mjs)、[资源真实加载](../../apps/playground/scripts/browser-resource-converters-test.mjs)。
