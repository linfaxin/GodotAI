> 合并说明：主干默认产品使用普通 Dedicated Worker 及其宿主、音频和呈现桥。本文的 `proxy-pthread` 是独立选择、独立构建和验收的 pthread 候选。历史原生执行字段 `window` 对应无线程 WASM 配方；Schema 3 站点的 `runtimeAbi` 决定其普通 Worker 宿主，不表示默认产品在页面线程执行引擎。

# 浏览器完整引擎 Worker 路线

浏览器产品把完整 Godot Web 内建运行时、业务 JS/TS 和 React 放在同一个引擎执行 realm。React 是可选的响应式语法和生命周期层，普通脚本与 React 使用同一份原生 API。编辑器页面管理项目与存储，编译 Worker 负责编译与打包，独立来源的预览 iframe 负责浏览器宿主能力与会话。

当前 Worker 候选使用 Godot 上游支持的 `threads=yes proxy_to_pthread=yes dlink_enabled=no`。`full-engine-v1` 是能力配置，`proxy-pthread` 是执行模型，两者独立。现有默认构建仍读取 `window` 模型；显式 Worker 构建写入独立目录，不覆盖默认版本。无线程专用 Worker 平台移植不是同时维护的第二条产品线。

## 包与兼容入口

| 层 | 实现入口 |
| --- | --- |
| API IR、声明和命名 | `@godot-js/engine/api`、`@godot-js/engine/runtime-types` |
| 纯执行合同与身份 | `@godot-js/engine/execution`、`@godot-js/engine/identities` |
| 加载、宿主、会话与 iframe | `@godot-js/engine/browser` |
| 源快照、启动计划、overlay、UID、PCK、资源收据 | `@godot-js/project-tools` 及其子路径 |
| React 节点、阶段提交与生命周期 | `@godot-js/react`、`@godot-js/react/engine` |
| 编辑器、存储与工作流 | `apps/playground` |

旧 `@godot-js/react-build/core` 和浏览器 SDK 的 engine API、loader、session 入口保留重导出，使用同一份中立实现。React 启动适配仍属于 React 工具层。默认 React exports 使用通用引擎 renderer；旧组件模板显式使用 `@godot-js/react/legacy`。这次改动没有启用 npm 发布。

React 的显式 `flush()`、`pump()` 和 `shutdown()` 可以推进提交与 ref/effect 清理，但原生节点释放只能在会话私有的异步检查点执行。直接连接的 Godot 信号同样受此限制，宿主的同步唤醒回调不能提供释放许可。释放抛错或立即释放后仍无法确认销毁时，保留整个所有权岛、记录错误并报告 `cleanExit=false`，由会话收尾；不会将失败写成已接受的释放请求。

引擎角色显式区分 `host`、`engine`、`script-worker`，不能从 `ENVIRONMENT_IS_PTHREAD` 推断业务角色。主引擎与用户 JSWorker 的消息及 Variant 转移有独立路由版本和目标线程身份。上游同步宿主代理仍用于需要同步返回的平台接口；引擎节点访问与物理查询不经过逐方法的页面 RPC。

WebGL 的实际归属由运行探针记录。上游 pthread 路线允许宿主页承担 WebGL 代理，因此不能仅凭引擎在 Worker 就声称 Canvas/context 全部在 Worker。音频、IME、权限与 XR 仍受浏览器平台限制。

## 构建候选

使用仓库 `.node-version` 和 `package.json` 指定的 Node/pnpm。源构建需要 Emscripten、SCons、Python 和对应 Godot 源码。当前验证工具链为 Emscripten 4.0.11、Godot 4.6.1；实际版本、源快照、补丁和执行参数以每次报告为准。不要用请求参数替代真实 resolved flags。

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/test/build-browser-engine.mjs \
  --godot-source /path/to/godot-4.6.1 \
  --build-dir /independent/full-proxy-pthread \
  --profile full-engine-v1 --execution-model proxy-pthread \
  --target template_debug --out /artifacts/worker-engine-report.json
```

源码补丁在构建前逐项校验并绑定到报告，包括 pthread 入口与 shader UTF-8 兼容修复。源认证要求实际成功构建及所有输入的 hash；已有 ZIP 的 development 模式不能变成源码认证。

构建实际 Playground 候选时，原生 Godot 编辑器仍是资源导入/导出的构建工具。生成的站点在浏览器内编译、打包和执行，不需要运行时 Node 服务。

```sh
GODOT=/path/to/godotjs-editor \
GODOT_IMPORTER=/path/to/godot-editor \
node apps/playground/scripts/build.mjs \
  --engine-report /artifacts/worker-engine-report.json \
  --execution-model proxy-pthread
```

完整 debug 候选默认输出 `apps/playground/dist-worker-full-debug/`。release、2D 和其他配置有各自目录。Worker 模型拒绝覆盖旧默认目录。导出预设的 `variant/thread_support` 来自实际 execution；导出后的 Worker 脚本必须仍与报告的源资产逐字节一致。所有引擎资产和最终产品的 API/types、vendor、pack 都须使用同一候选的身份。

## HTTPS 与跨来源部署

线程模式依赖 `SharedArrayBuffer` 和实际跨来源隔离。编辑器顶层页、独立来源的预览 iframe 以及实际引擎 Worker 都需要记录 `isSecureContext`、`crossOriginIsolated` 和 SAB 可用性。仅在服务器配置里写了 header 不构成浏览器证据。

部署至少包含以下合同：

- 顶层和预览页面通过可信 HTTPS 提供，并设置 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`。
- 编辑器的 Permissions-Policy 向选定预览来源授权 `cross-origin-isolated`，iframe 的 `allow` 包含 `cross-origin-isolated` 和需要的音频权限。保留已有来源、source、协议、session 握手。
- 每个实际跨来源脚本、WASM、worklet、Worker 和字体响应满足对应 CORS/CORP；WASM MIME、CSP 的 script/worker/connect/frame 规则与 Blob URL 路径匹配。
- 编辑器与预览分离凭据和应用数据；`preview-config.json` 指向匹配版本的预览来源。

`scripts/test/browser-server.mjs` 的 `serveIsolatedBrowserPair` 提供显式 TLS/双来源 fixture。原有非隔离服务默认保持原行为。测试证书可以使用明确记录的 SPKI pin；这只证明该受控 TLS 原型，不等于生产 CA、CDN、鉴权和权限策略验收。不要通过关闭 SAB/线程或使用 Dummy Audio 将部署失败改写为完整引擎通过。

## 启动能力探针与 WK-01

跨来源隔离和 SAB 存在仍不足以证明当前浏览器能执行这个 pthread 引擎。loader 在请求任何引擎 JS/WASM 前运行 `@godot-js/engine/browser/capabilities` 的 `assertBrowserSharedMemoryGrowth`。它使用固定的 126 字节 Wasm 模块及版本内的 WAT 源码，在主 realm 和辅助 Worker 中保留实例，将共享内存从 1 页增长到 2 页，再核对两侧旧实例的 `memory.size`、新增区域读取、`memory.copy` 和 `memory.fill`。probe 不执行完整引擎，也不改变正式引擎字节、初始内存、模块或线程选项。

判断来自实际操作结果，没有按 UA、品牌或版本号维护黑名单。不支持时返回 `E_BROWSER_SHARED_MEMORY_GROWTH`，阻止引擎下载和执行；成功、失败、超时和取消都会释放探针 Worker、回调、计时器和 Blob URL。`window` 兼容模型不引入这项 pthread 前置要求。

当前真实标准探针中，锁定 Playwright 的 Chromium 143.0.7499.4 和 Firefox 144.0.2 通过；Linux WebKit 26 的旧共享内存实例未正确更新页数，新增区域的 bulk-memory 操作失败，登记为外部浏览器阻塞 **WK-01**。WebKit 的启动拒绝用例通过，表示拒绝发生在引擎请求前且探针资源全部清理；它仍然是完整 Worker 引擎运行的 **unsupported**，不能算第三浏览器业务通过。WebKit 测试的本地 HTTPS 证书例外也不是生产 TLS 验收。

正式完整原生模板保持不变，没有采纳诊断阶段的 Wasm lowering、关闭内存增长或减少引擎能力作为产品绕过。浏览器实现修复或升级后，重新执行标准探针和完整产品验收才能解除 WK-01。Node 单测中的 VM Worker 仅检查探针逻辑与清理，不能替代真实浏览器结构化克隆和共享内存执行。

## 执行合同与版本身份

execution schema 记录 `executionModel`、`wasmThreads`、`proxyToPthread`、隔离要求、宿主协议版本、Worker bootstrap 模式和完整辅助资产列表。真实报告必须用 resolved flags 验证；旧无线程报告由兼容 reader 读取，不能改标签复用为新 Worker 证据。

主 JS 可以同时承载内嵌 pthread bootstrap，其原始 hash 同样进入闭包。loader 在执行任何脚本前校验所有 Worker/worklet 资产，并以已校验主 JS Blob 设置 `mainScriptUrlOrBlob`；引擎内部其他 fetch 仍正常工作。停止会话必须回收整个 pthread 池、用户 Worker、音频、端口、计时器、Blob 与 Canvas。强停报告与合作退出分开，强停不声称执行了 React 清理回调。

`engineId` 绑定原生字节、执行合同、模块、API 与 engine-only 声明，以及实际执行的 `engine.host` 浏览器宿主 bundle。产品构建先编译不包含 React、项目代码或发布 ID 的 `preview.js`，将其 hash 纳入 engineId，再生成带同一 hash 的 HTML module SRI；最终 frontend 阶段复用该文件，不重新编译。浏览器核对宿主闭包、实际响应字节与执行 script 的 integrity。frontend refresh 保留已封印宿主，宿主实现变化需要重建完整候选。通用 release 脚本的原生 Worker 候选显式传入 `engineHost: {source, path}`，并让部署页面执行该资产。

`extensionId` 绑定 React/adapter vendor、模块映射及 SDK 声明。合并编译快照不进入 engineId。仅改 SDK 声明应改变 extensionId 而保持 engineId；仅改宿主字节应改变 engineId。`buildKey` 由输入和目标身份计算，最终 pack hash 与 `artifactId` 放在外层收据，避免自引用。

发布 reader 会重算 schema 2 描述的完整 `id`、原生 `engineId` 和 SDK `extensionId`，校验全部资产引用的 path/hash/bytes，并核对站点封印的 `engine-release.json` hash/bytes。实际读取合并声明后，分别验证 native declarationsHash 和 SDK typesHash。SDK identity v2 还绑定每个运行模块的 JS hash 与实际导出的声明合同；typesHash、模式和模块闭包不能省略。

新编译器对普通脚本、React、Schema 4 和旧项目文档统一生成 schema 2 产物回执。`artifactId` 绑定整个外层回执（buildKey、源 hash、pack hash、输出清单及可选导入收据），编辑器、runner 和预览宿主均核验它与实际 pack。新发布描述带 `artifactReceiptVersion: 2`，不能使用兼容选项降级。回执版本和项目存储 schema 是两套合同；打开旧项目不会生成未认证旧回执。

兼容范围：旧 schema 2 引擎描述可以缺少 engine/extension identity 或 SDK identity v2 字段，但完整描述的 canonical ID 和已声明的资产封印必须自洽；真实 v8 描述仍可读取。旧 schema 1 产物回执或无回执包仅在明确 `allowLegacyArtifacts: true` 且发布未要求 schema 2 回执时可用，不能声称具有已核验的新 artifactId。该选项用于保留的 conformance/P0 调用路径，默认产品不启用。

浏览器和构建工具校验完整的发布描述身份与 engine/extension 配对，不能仅比较传入的 ID 字符串；站点清单中的 `engine-release.json` hash 必须与实际描述字节一致。SDK 的运行模块也属于发布闭包。新的打包收据生成并携带最终 `artifactId`，正式预览消费时校验收据身份和实际 PCK hash；旧收据仅通过明确的兼容路径读取。分阶段打包会核对 overlay 的文件清单和输出字节，外部修改不能继续沿用旧 hash。

项目工具提供只读旧格式适配和显式 Schema 4 reader/writer。Schema 4 使用互斥的 scene/script 启动计划，源快照不被生成 bootstrap 覆盖；旧 React 项目继续保留原 component entry 语义。现有默认存储仍为 Schema 3，默认写升级在恢复、冲突和迁移验收前保持关闭。资源收据只覆盖已实现的 converter；现有导入缓存不证明浏览器能运行任意 EditorImportPlugin、FBX/Blend 导入或所有导入选项。

所有已识别的旧导入缓存都纳入来源评估，无生产者收据时明确标为 `unverified`。编辑器保留首次观察到的源、sidecar 与缓存变化指纹，用于发现后续编辑；该观察不构成新鲜性证明。已知输入发生变化时，必须执行已登记的 converter 或要求重新导入，不能静默继续使用旧缓存。UID 读取复用中立工具的节解析与索引逻辑，保留原始 UID 到路径的含义。

## 验证与启用门槛

Linux CI 的固定工具链、Firefox Xvfb/PulseAudio 环境、执行命令和 WebKit WK-01 阻塞见[浏览器 Worker CI 说明](browser-worker-ci.zh-CN.md)。

```sh
pnpm test:engine
pnpm test:react
pnpm test:browser:unit
node scripts/test/browser-pthread-integration.mjs \
  --engine-report /artifacts/worker-engine-report.json \
  --out /artifacts/worker-runtime --loops 3
node scripts/release/collect-worker-g0.mjs \
  --engine-report /artifacts/worker-engine-report.json \
  --runtime-report /artifacts/worker-runtime/worker-integration.json \
  --out /artifacts/worker-g0
node scripts/release/g0-readiness.mjs /artifacts/worker-g0/g0-receipt.json
```

G0 收据绑定实际引擎归档和辅助资产、构建期源快照、运行 producer 输入、浏览器版本/OS、批次及独立 case。collector 仅从明确 `passed` 的实际 parent case 取事实；父 suite 失败会保留限制说明，错误字符串中的正向断言不算通过。缺失字段保持 `unverified`。Node 单元报告可单独提供 B6/B7 工程证据，不能标成浏览器运行。

| 阶段 | 验收范围 |
| --- | --- |
| G0 | 小规模真实完整引擎、同 realm JS/React/物理、角色/Variant、HTTPS/隔离、实际输入音频、同步宿主、整池强停/重启、React 原生生命周期和版本拒绝 |
| G1 | 同一新产品站点的 Chromium、Firefox、Linux Playwright WebKit 业务回归，作者源码栈/source map、100 次会话、失败/资源/迁移恢复与错版本拒绝 |
| G2 | 版本化候选路由或生产等价灰度环境中的部署、升级及整组回退；报告实际来源/TLS/权限与环境限制，不要求先默认切换 |

所有工作包可以开始开发；正式集成由各自 scoped blocker 解锁，默认产品切换、默认写迁移与旧链路移除保持 HOLD，直到 G1/G2 有完整新证据。源码构建、模拟器、旧窗口报告和 module/class 列表不能替代真实 Worker 运行。完整 module build 也不等于所有资源格式和设备路径都验收。

G0 使用同一原生候选的小规模实际运行证明其 scoped 条件；更新宿主后，B6 需重新绑定新探针、loader、exports 和测试源码。旧宿主的产品 G1/G2 结果只证明旧候选，不能直接移植到新 engineId。WK-01 尚未解除时，默认完整 Worker 切换继续保持 HOLD；已经通过的 Chromium/Firefox 或不支持路径验证各自保留准确范围。

IME 的 DOM/capability 探针不等于 OS 候选窗；`isSessionSupported` 不等于实际 XR session。Linux Playwright WebKit 不等于 macOS/iOS Safari，后者需真实 Apple 环境。没有实际硬件和部署证据的范围须继续明确列出。

回退必须切换完整的 deployment+execution+descriptor+bootstrap+JS/WASM/worklets+API/types/SDK 版本集合，不能只换 WASM。当前脚本会生成和验证候选，不自动发布或更改默认指针。
