# 2D 专用 GodotJS Web 引擎

本指南说明 `engine-2d-v1` 的构建、项目兼容、本地调试与验收流程。当前工作仅进行本地开发和验证，不部署到外部站点。它使用与完整引擎相同的原生 GodotJS 和原生 React 运行链路。是否通过验收应以具体候选的构建报告和浏览器报告为准；本文不替代真实构建证据。

## 配置与兼容边界

| 配置 | 用途 | 内置示例 |
| --- | --- | --- |
| `full-engine-v1` | 完整 Godot Web 模块与 2D/3D 项目 | 八个原生 React 示例 |
| `engine-2d-v1` | 关闭 3D 场景、3D 物理、3D 导航和 XR | Shader、Lights、Match3、Dungeon |

两个配置都保留原生 `godot`/`react` 项目模式、2D 渲染、物理、导航、TileMap、高级 GUI、音频、GDScript 和高级/回退文本服务。保留核心 `Vector3`/`Transform3D` 等 Variant 数学类型；这些类型的存在不代表包含 3D 场景节点。纹理、字体和音频支持还必须通过实际资源验证。

官方 profile 定义位于 `scripts/release/engine-profiles.mjs`。它同时供 Node 构建工具和浏览器应用读取，明确必需/允许/禁止模块、功能开关、实际 API 类和示例集合。通用 SDK 的消费者自定义 profile 字符串契约保持独立。旧 `game-2d-v1` 是另一套兼容能力标识，不能代替原生 2D 模板。

默认 `baseline` 模块模式保持通常的非 3D 模块，仅关闭 3D 系统。`explicit` 模式使用同一份经过验证的模块清单，作为受控裁剪实验。必需模块缺失或额外模块越过清单时即失败，不能因为 SCons 返回零便认定功能齐全。

## 身份与产物

- `engineProfile` 表示项目的功能目标，不是某次引擎文件的哈希。
- `runtime` 是 `godot`/`react`；引擎 `templateTarget` 与 SDK 的 development/production 模式分别记录。
- `engineReleaseId` 绑定确切的 WASM、JS、音频 worklet、SDK、API 和类型。
- 站点候选还包含前端、helper 与资源包。`candidateId` 固定为顶层 `manifest.json` 原始字节的 SHA-256，浏览器与验收工具采用同一计算口径；`siteHash` 独立记录包含压缩 sidecar 的完整最终文件树，避免循环身份。
- 一次运行固定 ReleaseContext，编译器返回它实际使用的发布身份。启动前比较 profile、发布 ID 和描述符，发现不同版本时保留编辑内容并拒绝混用。

`engine-release.json` 在计算 ID 之前写入正确 profile。`manifest.json`、资源构建报告、demo 描述符、编译产物和预览必须一致。不得在生成完整引擎清单后只改一个 profile 字符串。

## 安装与共享 SDK 构建

使用仓库的 Node 24 和锁定的 pnpm 版本，并固定 Godot 4.6.1 Git 源码、Emscripten 4.0.11 及 CI 指定的 SCons 版本。Emscripten、SCons 通过当前 shell 的 PATH 提供。

```sh
pnpm install --frozen-lockfile
pnpm build
```

SDK 在矩阵前构建一次并冻结。后续两个 profile 的构建消费相同 SDK 字节，避免两个任务同时改写共享 `dist`。

Godot 源码目录、模块仓库和引擎构建目录必须彼此独立。exporter/importer 使用兼容的完整 Godot 4.6.1 editor；禁用 3D 的开关只用于 Web 导出模板。

## 构建 Web 模板

本地 wrapper 和 CI 使用同一套参数生成器：

```sh
GODOT_SOURCE=/absolute/path/godot-4.6.1 \
ENGINE_PROFILE=engine-2d-v1 \
ENGINE_TARGET=template_debug \
ENGINE_LTO=none \
ENGINE_MODULE_MODE=baseline \
SKIP_ENGINE_JS_BUILD=1 \
bash apps/playground/scripts/build-web-engine.sh
```

默认产物为：

```text
work/playground/engine-2d-v1/template_debug/baseline/none/<configuration-id>/engine-template.zip
work/playground/engine-2d-v1/template_debug/baseline/none/<configuration-id>/engine-report.json
```

wrapper 的独立引擎目录默认位于仓库父目录的 `work/godotjs-web/<profile>/<target>/<module-mode>/<lto>/<configuration-id>/`；可通过 `GODOT_WEB_BUILD_DIR` 覆盖。配置 ID 由实际构建参数生成，普通编译调度的 jobs 不影响命名空间，ThinLTO 的链接 jobs 属于实际 linker 参数，因此会影响配置 ID。baseline/explicit 与 none/thin 的构建目录、报告和 ZIP 默认均隔离。相同报告路径通过锁避免并行写入；构建失败不会替换上一次成功报告。

每次成功构建还保存在报告目录下的 `releases/<original-report-sha256>/portable/`，包含原始报告、便携报告、原始模板 ZIP、编译日志与完整性清单，并逐字节保留候选实际引用的 `engine-report.published.json`。当前 `engine-report.json` 原子更新为指向对应不可变 ZIP 的报告，旧构建继续保留；后续更新当前报告不会丢失旧候选绑定的报告 SHA 对应内容。`ENGINE_BUILD_REPORT`、`WEB_TEMPLATE_OUT` 可以指定当前报告和归档位置；显式配置共享路径时仍须避免多个配置混用同一构建目录。

直接运行构建器可精确控制目录：

```sh
node scripts/test/build-browser-engine.mjs \
  --godot-source /absolute/path/godot-4.6.1 \
  --build-dir /absolute/independent/work/engine-2d-debug \
  --out /absolute/path/reports/engine-2d-debug.json \
  --profile engine-2d-v1 --target template_debug \
  --module-mode baseline --lto none --jobs 4
```

报告保留 requestedArgs，并由独立构建树中的 SCons 记录实际解析后的功能和优化选项。最终模块来自生成的模块头。上游源码、模块源码、补丁、native bundle、工具链、模板和证据都绑定到构建报告。源码归档缺少 Git commit 时仍可用于本地实验，但不能因此获得正式源码认证。

本地和 CI 共用七项经过检查的源码补丁：GLES3 Alpha Hash、小 CanvasGroup backbuffer、私有 tooltip、可选 PWA、音频退出、无线程 group wait，以及第七项 WebKit presentation boundary。第七项在 `platform/web/js/engine/config.js` 的模块 pre/post loop 钩子中保存和恢复独立的 READ/DRAW framebuffer；帧间绑定默认 framebuffer，供 WebKit/iOS WebKit compositor 提交。它同时处理上下文失效、canvas 所有权变更和退出清理，不读取或吞掉 GL error。此修改位于 JS wrapper 链路，构建前后仍逐样本核对 WASM 哈希，不能只凭“仅改 JS”推定字节相同。

公开原生 API 不新增“必须调度进 process/physics”的限制。独立真实探针已通过 `JavaScriptBridge.create_callback` 与 `window.setTimeout` 在帧外调用 viewport 图像读回、`ImageTexture.create_from_image`、Sprite 纹理和位置更新，并验证实际目标像素。该证据覆盖这些公开 callback 路径；宿主自行混入 raw WebGL 绘制仍须尊重引擎 context 的所有权。探针结论不代替源码补丁集成后的完整候选验收。

ThinLTO 的链接任务数随 `--jobs` 显式生成 `linkflags=-Wl,--thinlto-jobs=<jobs>`，避免链接器按宿主 CPU 数自动扩大并行。小型容器还应明确设置 `EMCC_CORES=4 BINARYEN_CORES=4`；这两个环境值与实际 linkflags 都进入构建证据，recipe 哈希会随其变化。控制组比较时记录这些差异。

`--snapshot-only` 只准备源码和报告，不证明引擎已编译。已有模板的 `--existing-template` 仅允许 `--development`，不能补造来源认证。

## Gate 1：独立验证实际 2D 模板

Gate 1 使用纯脚本和真正 `@godot-js/react/engine` 的最小 PCK，不需要先构建完整工作台或 demo 资源。完成引擎构建后可使用其 `.web_zip` 输入：

```sh
node apps/playground/scripts/browser-engine-profile-gate.mjs \
  --profile engine-2d-v1 \
  --engine-js /absolute/independent/work/engine-2d-debug/bin/.web_zip/godot.js \
  --engine-wasm /absolute/independent/work/engine-2d-debug/bin/.web_zip/godot.wasm \
  --out work/playground/engine-2d-v1/gate-debug \
  --browser chromium
```

此门槛要求最终 WASM 链接、实际 2D API 与绑定审计、约定的 3D 类缺失，以及原生/React 两种模式的启动、更新、回调、退出。snake/camel 命名分别验证。完整引擎也需要回归链接和运行，避免条件编译破坏既有功能。

旧 P0 React 原型夹具不能代替生产 React 的验证报告。完整站点联调在 Gate 1 后执行。

## 构建独立 2D Playground

```sh
GODOT=/absolute/path/godotjs-editor \
GODOT_IMPORTER=/absolute/path/godot-4.6.1-editor \
node apps/playground/scripts/build.mjs \
  --profile engine-2d-v1 --target template_debug \
  --engine-report /absolute/path/reports/engine-2d-debug.json \
  --work-dir /absolute/path/work/site-2d-debug \
  --out /absolute/path/sites/playground-2d-debug \
  --skip-sdk-build
```

所有 source/export/asset/capture/output 目录必须按配置隔离。资源报告记录 importer/exporter 版本、二进制哈希、素材、导入参数及 PCK 输出。四个 2D 示例使用显式 asset ID 清单，包括运行时动态拼接的 tile ID、Shader、灯光资源与 `withDemo` 的音效。由 Godot importer/exporter 解析 `.import/.remap`、缓存与 UID 依赖，并检查导出的引用闭包。

日常 `pnpm --filter @godot-js/playground build:2d` 自动读取同一配置命名空间下的构建报告，不再仅凭 ZIP 构建。显式 `GODOT_WEB_TEMPLATE` 会先查找旁边的 `engine-report.json`；也可传 `--engine-report`。构建前验证 profile、target、LTO、模块模式、模板哈希以及源码/recipe 证明，导出后复查报告与 ZIP 没有变化。缺少或无效的源码证明直接失败；不可信本地模板必须显式加 `--development`，其 `sourceCertified=false`，不能取得正式站点封印。baseline/no-LTO 保留常规 `dist-2d-debug` 等目录，其他实验默认写入各自配置命名空间下的 `site/`，防止覆盖常规调试产物。

显式报告和模板旁自动发现的报告采用同一解析顺序：先读取报告，再推导调用者未指定的 profile、target、LTO、模块模式和 jobs。调用者显式指定的 CLI/环境值必须匹配；ThinLTO 的链接 jobs 也须匹配。默认命名空间本身代表配置选择，放错命名空间的报告不能借推导逻辑静默切换配置。

`--skip-assets` 只重用已准备的资源项目；独立运行时可用 `--resource-project` 指向可验证的资源输入。不能把缺失资源当作成功，也不能混用另一 profile 的缓存。

刷新已准备好的站点：

```sh
node apps/playground/scripts/build-shell.mjs \
  --profile engine-2d-v1 --out /absolute/path/sites/playground-2d-debug
```

该命令需要匹配的引擎和资源报告。它会使旧压缩 sidecar 和旧交付元数据失效；刷新后应重新执行压缩准备、冻结和验收。生产场景应先复制为新的候选目录再刷新，保持正在服务的不可变发布目录不变；刷新失败时也应将新目录作为未完成候选处理。

前置编辑器合同测试使用显式 shell-only 入口，不能把它作为真实引擎运行证据：

```sh
node apps/playground/scripts/build-shell.mjs \
  --shell-only --profile engine-2d-v1 --out work/playground/shell-fixture-2d
```

## 本地启动

```sh
PLAYGROUND_DIRECTORY=/absolute/path/sites/playground-2d-debug \
PORT=4173 node apps/playground/scripts/serve.mjs
```

在浏览器打开 `http://localhost:4173/`。本机预览使用 `localhost` 与 `127.0.0.1` 的独立 origin 配对，无须外部部署，也不要求 COOP/COEP。远程浏览器的访问地址应通过当前开发环境的预览/端口转发机制提供。

## 项目与存储

新项目文档使用 Schema 3，并显式记录 `engineProfile`。Schema 1/2 按旧行为保留原文与迁移历史，默认属于完整引擎。解析和 profile 检查发生在 demo 回退、controls 修改和保存之前。

不支持的 profile 保留原文并允许导出，不能覆盖某个内置 demo 存档。跨 profile 转换须显式创建副本，再验证 API 与资源。`demoId` 是示例来源，不是目标引擎或存储身份。

新版存储按文档版本和 profile 隔离；旧数据库保持原样，新版 full 站点执行受控复制迁移。2D 站点不会把旧 full 数据自动解释成 2D。需要覆盖同域 `/full/`、`/2d/`、新旧客户端并存、多标签页冲突和迁移重试。

`@playground/api` 与内置 asset ID 有独立兼容契约。helper 或资源发生破坏性变化时需要版本迁移或明确拒绝；仅 profile 相同不足以证明历史分享项目使用了同一套 helper。字体资源的字形覆盖和纹理导入格式必须通过实际场景验证，字体/PCK 体积与 WASM 分开统计。

## 体积实验与报告

```sh
node scripts/test/measure-browser-engine.mjs \
  --report /absolute/path/reports/engine-2d-debug.json \
  --out work/playground/measurements/2d-debug.json
```

工具校验归档与构建报告哈希，读取唯一的 `godot.wasm`，验证 WebAssembly，测量原始字节、gzip 9、Brotli 11，并验证解压后逐字节一致。记录编译与压缩工具链、profile、target、recipe、源码身份及代码/数据段大小。

`--baseline` 可比较同一工具链控制组；`--performance` 附带独立性能测试 JSON 及其哈希。测量通过只说明测量和回验成功，不代表浏览器产品验收或正式发布认证。

Browser Playground CI 对每个已完成的引擎构建报告都执行该测量，并将 `browser-engine-measurement.json` 与源码报告一起归档；即使后续产品验收失败，已完成模板的体积证据仍会保留。未完成构建时明确跳过。CI 将 `EMCC_CORES=4`、`BINARYEN_CORES=4` 固定并写入构建证据，ThinLTO 的链接并行数也固定为 4。

按顺序比较：完整 debug 控制组 → 仅关闭 3D → 显式模块清单 → release/no LTO → release/ThinLTO。debug/release 的模板与 export mode 一致。每次只改变一组条件，分别记录启动、WASM 编译、内存与场景表现。字体极限裁剪单独评估。

历史本地全量样本为原始 35,794,141 B、gzip 9,944,425 B、Brotli 6,957,877 B；其源码未通过正式 CI 认证，只作参考。`gzip ≤7 MB / Brotli ≤5 MB` 是初期探索预算，不能代替功能验收，也不能写成已达到的结果。实际 HTTP 主机的压缩级别可能与离线实验不同。

## 本地实测记录

以下是 2026-11-11 使用最终七项补丁重新构建后的五份模板测量，单位为十进制 MB（1 MB = 1,000,000 B）。当前报告位于 `work/2d-engine/presentation-rebuild/`，各样本均绑定这一轮的新模板和 JS wrapper。独立 Gate 列仅对应这一轮 wrapper，不沿用旧 wrapper 的通过记录。

| 样本 | target / 模块模式 / LTO | 原始 WASM MB | gzip 9 MB | Brotli 11 MB | 新 wrapper 独立 Gate |
| --- | --- | ---: | ---: | ---: | --- |
| 完整引擎控制组 | debug / baseline / none | 35.795086 | 9.944338 | 6.959052 | 已通过 4 cases |
| 2D 基线 | debug / baseline / none | 28.997664 | 8.090507 | 5.700115 | 已通过 4 cases |
| 2D 显式模块 | debug / explicit / none | 28.991433 | 8.087659 | 5.700931 | 已通过 4 cases |
| 2D release | release / baseline / none | 30.867871 | 7.671194 | 5.414759 | 已通过 4 cases |
| 2D ThinLTO | release / baseline / thin | 31.470103 | 7.974475 | 5.631075 | 已通过 4 cases |

新 full、2D debug、2D release/no-LTO 和 ThinLTO 四个站点构建已经完成真实 snake/camel API 捕获。随后对五份最终模板串行重跑独立 Gate，均通过 production native/react × snake/camel 四例，共 20 例；显式模块 debug 还在这轮重新捕获双命名 API。报告为 `presentation-rebuild/{full,debug,explicit-debug,release-none,release-thin}-gate/gate.json`，浏览器为 Chromium 154.0.8037.57。Gate 输入从 SHA-256 与构建报告匹配的模板解包，保留 wrapper、WASM 和 worklet 字节；没有沿用历史 Gate。

当前报告索引为 `work/2d-engine/presentation-rebuild/{full,debug,explicit-debug,release-none,release-thin}-{report,measurement}.json`。`wrapper-verification.json` 证明五个新模板中的 WASM 哈希与对应历史样本逐字节相同，因此五行体积保持不变；JS wrapper 的身份另行记录。`sourceCertified` 仍只是构建报告来源标记，不是测量工具重新认证，不代表执行了远程 CI 或完成产品发布认证。

这一轮五份 GodotJS 源快照均为 `44b7967fe7c70e37fbb609c36d4f9979a320fb70cbd7a877e56eed72a088dfcd`，Godot 源快照均为 `20896d24eb7a7dd7fdb9266a2bc1d24e9ddc5b779ef74d4e283d1862445570fb`；Emscripten 4.0.11、SCons 4.9.1、Python 和压缩工具链一致，CPU 环境都明确记录 `EMCC_CORES=4`、`BINARYEN_CORES=4`。四个变体相对新 full 控制组均得到 `toolchainsComparable=true`、`sameSource=true`、`comparable=true`。这证明对照所需的源图与工具链匹配，具体实验因素仍以 requested/resolved 参数为准，不能把跨多个条件的差值归因于单一开关。

本轮 release/no-LTO 的原始文件比 2D debug 大，但 gzip/Brotli 文件更小；两种口径都保留。显式模块 debug 的原始大小只减少 6,231 B、gzip 减少 2,848 B，Brotli 增加 816 B，不能把显式清单本身描述成大幅缩减。ThinLTO 样本比 release/no-LTO 在三种体积口径都更大，因此本轮默认仍为 `lto=none`；该观察不等于所有平台上 ThinLTO 都会增大，也不是性能结论。

历史五份报告仍保留在 `work/2d-engine/{full,debug,explicit-debug,release-none,release-thin}-measurement.json`。旧 wrapper 的 Gate 当时通过，但不用于新 wrapper 放行。旧轮 whole-snapshot/env 记录覆盖不同而得出的 `comparable=false` 只属于旧轮，不能覆盖或混淆当前七补丁重建的可比结果。

旧轮的细粒度来源审查保存在 `work/2d-engine/native-input-comparison.json`：401 个 native 候选、六个 bundle、两份 bridge JS、七个 preset 输入相同；采证 hook、生成 `.inc` 的预快照缺项和 C++ mtime 注释区别各自记录。该历史审查不追认缺失的原始输入，不修改旧认证，也无需用于替代新报告已经完全匹配的源图。

## 当前示例资源包大小

下表来自七补丁后的四个实际站点，已将磁盘字节数与各自 `resource-build.json` / `demo-release.json` 的大小和 SHA-256 核对。PCK 是示例资源数据，不属于上面的引擎 WASM。

| 站点 | 示例数 / asset ID 数 | 导出 `engine/game.pck` B | 实际 demo 包 `demo-resources.pck` B | 模型清单 |
| --- | --- | ---: | ---: | --- |
| Full debug | 8 / 72 | 1,312,892 | 1,294,872 | 保留完整示例模型 |
| 2D debug | 4 / 15 | 337,860 | 334,064 | 空 |
| 2D release/no-LTO | 4 / 15 | 337,860 | 334,064 | 空 |
| 2D ThinLTO | 4 / 15 | 337,860 | 334,064 | 空 |

三份 2D 包长度相同，但各自 SHA-256 不同，必须按各自候选收据验证，不能互换缓存。资源包减少还包含从八个示例改为四个示例和删除 3D 资源的范围变化，不应算作 WASM 引擎裁剪收益。

本地 2D debug 产品候选已完成独立的站点封印与 `--verify` 复核：`work/2d-engine/acceptance-debug/site-acceptance.json` 的 198 个文件和 13 组必需报告绑定同一 runId `bc633c0a-3458-4c3c-b36f-590f35201582`，siteHash 为 `2d1a673ae97fbaea8bf2eca43cd4a40d5479267adc21370341e2ed7c7ac56b27`。这是本地产物验收，不表示已执行远程 CI 或部署。独立 Gate 和性能测量不追加到这份已封印收据。

完整站点的八示例回归、工作台，以及 release/no-LTO、ThinLTO 的真实编辑与功能观察分别记录在 `presentation-rebuild/validation/validated.json`。示例工作台回归使用默认 snake 命名；双命名 API 捕获、独立 Gate 与特性夹具是另外的证据，不能将八示例套件的 16 项检查解释成八示例各运行两种命名。ThinLTO 首次 camel 停止后音频采样出现 observation gap，原报告保留于 `validation/thin/features/`；确认空闲后用同一命令独立重跑一次，双命名均通过于 `features-attempt2/`，未削弱静音或泄漏断言。不能称所有 attempt 均无失败，也未证明该间隙的根因。

## 四站本地性能观察

2026-11-11 在编译、压缩及其他浏览器任务结束后串行采样：full → 2D debug → release/no-LTO → ThinLTO；ThinLTO 的一次独立重跑见下文。四份完整报告各包含四个公共场景 × 三次冷浏览器启动，以及三次独立 `WebAssembly.compile`，共 48 个启动样本和 12 个 compile 样本。每例稳定 1 秒、观察至少 3 秒，视口 1536 × 1000；Chromium 154.0.8037.57、Linux x64、Xeon Platinum 8573C，cgroup 限额 4 CPU / 16 GiB。实际 renderer 为 ANGLE / SwiftShader 软件渲染。操作系统文件缓存未清空，四站顺序没有随机化。

每场景只有 n=3，nearest-rank P95 就是三个样本中的最大值，不是可靠的尾延迟估计。下表是整站导航到真实 engine running 的时间，包含编辑器、编译器和示例资源准备；full 的八示例资源范围与 2D 四示例不同，不能将启动差值全部归因于 WASM。FPS 列先计算每次真实遥测窗口的中位数，再取三个样本的中位数。

相同 `template_debug`、baseline、no-LTO 的对照：

| 场景 | Full debug 导航→running 中位数 / P95 ms | 2D debug 导航→running 中位数 / P95 ms | 遥测 FPS 中位数 full / 2D |
| --- | ---: | ---: | ---: |
| Shader | 7726.1 / 8832.3 | 6270.5 / 6515.6 | 19 / 20 |
| Lights | 8164.7 / 8654.2 | 7414.1 / 7596.5 | 8 / 8 |
| Match3 | 7199.1 / 7581.8 | 7190.6 / 7754.3 | 28 / 22.5 |
| Dungeon | 6545.8 / 7182.7 | 6861.8 / 7284.3 | 22 / 24 |

观察方向并不一致：2D debug 的 Dungeon 启动中位数为 6861.8 ms，高于 full 的 6545.8 ms；Match3 的遥测 FPS 中位数为 22.5，低于 full 的 28，启动 P95 也从 7581.8 ms 增至 7754.3 ms。因此本轮只能确认所测 WASM 传输体积缩小，不能宣称启动或 FPS 普遍提升，也不能宣称没有性能退化。

以下两个 `template_release` 站点单列，不作为与 full/debug 仅一个变量不同的实验：

| 站点 | 场景 | 导航→running 中位数 / P95 ms | 遥测 FPS 中位数 |
| --- | --- | ---: | ---: |
| 2D release/no-LTO | Shader | 6561.2 / 6812.9 | 20.5 |
| 2D release/no-LTO | Lights | 8180.6 / 9359.6 | 8 |
| 2D release/no-LTO | Match3 | 6167.1 / 7463.4 | 21 |
| 2D release/no-LTO | Dungeon | 5917.5 / 6831.2 | 26 |
| 2D ThinLTO attempt2 | Shader | 5833.6 / 7479.2 | 23 |
| 2D ThinLTO attempt2 | Lights | 6946.0 / 8196.3 | 8 |
| 2D ThinLTO attempt2 | Match3 | 5847.6 / 6431.5 | 23 |
| 2D ThinLTO attempt2 | Dungeon | 5821.3 / 6373.5 | 20 |

独立 compile 在各站启动样本全部结束后，使用另一批新浏览器对同一 SHA-256 的 WASM 字节执行，下载、解码和哈希不计入 compile 时间：

| 站点 | target | compile 中位数 / P95 ms |
| --- | --- | ---: |
| Full debug | template_debug | 75.2 / 86.8 |
| 2D debug | template_debug | 71.7 / 102.9 |
| 2D release/no-LTO | template_release | 79.7 / 81.3 |
| 2D ThinLTO attempt2 | template_release | 68.1 / 81.2 |

内存表每格为“实际导出 WASM Memory 的观测容量峰值 / CDP page-target JS heap 采样峰值”，单位 MiB，分别取该场景三次样本中的最大值。这两列含义不同，不能相加成进程内存；WASM 容量不是 RSS 或 allocator 实际使用量，JS heap 可能不含独立 iframe target，250 ms 采样可能遗漏瞬时峰值。

| 场景 | Full debug | 2D debug | 2D release/no-LTO | 2D ThinLTO attempt2 |
| --- | ---: | ---: | ---: | ---: |
| Shader | 47.81 / 51.08 | 46.12 / 44.75 | 38.44 / 43.59 | 38.44 / 42.58 |
| Lights | 57.38 / 52.41 | 55.38 / 45.41 | 46.12 / 46.12 | 46.12 / 45.96 |
| Match3 | 68.88 / 53.96 | 66.50 / 45.80 | 46.12 / 43.89 | 46.12 / 44.58 |
| Dungeon | 82.69 / 51.85 | 79.81 / 43.30 | 66.50 / 43.32 | 55.38 / 52.93 |

原始完整报告为 `presentation-rebuild/{full,debug,release-none}-performance.json` 和 `presentation-rebuild/release-thin-performance-attempt2.json`，保留逐样本浏览器、硬件、上下文、ABI、控制参数、HTTP 响应、遥测、WASM 容量与 CDP 原始记录。每份完整报告在结束时重新验证 candidateId、descriptorHash 和 siteHash，四个站点字节均未改动。

ThinLTO 首次性能采样另存原字节 `release-thin-performance-attempt1.json`（原 `release-thin-performance.json` 也保留）：前七个启动样本完成，第八个 Shader sample2 曾运行并发出 frames 5/7/9 的三条遥测，随后 engine 状态变为 exited，原观察条件等待至 180 秒超时。原报告未见 pageerror、console error 或编辑器诊断，但退出根因未定。它未完成整个实验，未与完整对照合并。

随后仅增强测试工具的失败诊断：运行中非预期退出立即失败；保存 observer/phases、页面状态/日志、普通 console 与 frame URL；有意 Stop 前明确标记。成功采样条件、稳定/观察窗口、超时和全部参数保持不变。前三站使用原工具完成，原 JSON 不回填；ThinLTO 只用增强诊断工具完整独立重跑一次，12 个启动和 3 个 compile 样本完成。一次重跑成功不证明 ThinLTO 稳定，ThinLTO 本轮仍不作为默认。

构建报告固定的是增强诊断之前的源快照：归档 `performance-before-diagnostics.mjs` 的 SHA-256 `a3cc98cf4bc5220e355165d10b382872efd542a3f4c0738654fcf043d30fb41e` 与构建报告 `source.inputs` 一致。精确变更和前后哈希保留于 `performance-diagnostics.patch` / `performance-diagnostics-provenance.json`。该阶段诊断增强只涉及测试工具及其测试；随后又修复了构建入口、产物打包和验收门槛，详见本指南的相应流程。以上历史五份引擎与四站候选字节均未因这些工具修复而改变，五份历史构建之间的 sameSource/comparable 仍成立，不能把当前工作树称为与原完整快照逐项一致。

## 独立性能采样

在编译、压缩和其他高负载任务结束后，对已构建完整站点分别采样。默认每个示例 3 次，此时 nearest-rank P95 就是三个样本的最大值，不能把它解释为稳定的尾延迟估计。本地较稳定的对照建议使用 10 次：

```sh
node apps/playground/scripts/browser-engine-performance.mjs \
  --site /absolute/path/sites/playground-2d-debug \
  --out work/playground/performance/2d-debug.json \
  --samples 10 --browser chromium
```

同样运行完整引擎站点，使用相同源码、SDK、目标、浏览器、视口、HTTP 压缩/缓存策略和采样参数比较 Shader、Lights、Match3、Dungeon。每个示例/样本启动独立浏览器进程和空上下文；Node 静态服务器进程保持运行，操作系统文件缓存不被清空。因此这里的“冷启动”指冷浏览器，不是冷操作系统磁盘。

报告保留导航至 ready/running/首次遥测耗时、真实应用遥测 FPS、原始样本、硬件/cgroup 限额、浏览器版本、ReleaseContext、ABI、参数、中位数和 nearest-rank p95。默认先稳定 1 秒，再观察 3 秒；可用 `--settle-ms` / `--observe-ms` 调整，两个控制组必须相同。Chromium 启用固定的 SwiftShader 参数，报告记录实际 WebGL renderer，结果不应当作实体设备 GPU 的性能承诺。

WASM 内存观察在真实预览 realm 中包装 `WebAssembly.instantiate`/`instantiateStreaming`，原生兑现值和拒绝原因保持不变；只对真实 `instance.exports` 中的 Memory 建立 WeakRef，避免跨任务强行保留生命周期。每 250 毫秒及停止前读取 `memory.buffer.byteLength`，报告 `wasmMemoryCapacityPeakBytes`、各 Memory 的容量高水位和原始 frame 样本。它表示预览 realm 内存逻辑容量，包含尚未使用的容量，不是物理驻留内存、RSS 或 allocator 使用量。未导出的 Memory 或同步 `new WebAssembly.Instance` 不在该观察范围，缺少观测时写 null，不能用零冒充测量。

Chromium 另保留 CDP page-target 的 `JSHeapUsedSize` 定期采样，覆盖编辑器及同 target 的 frames。它明确标为采样到的 JavaScript heap 峰值，可能不含独立 iframe target；它不是 renderer RSS，也不是 WASM 线性内存容量。

所有 UI 启动采样完成后，工具再使用另一些全新浏览器进程，获取并校验相同 WASM 字节，单独测量 `WebAssembly.compile`。下载、HTTP 解码和哈希时间单列，未提前预编译污染 UI 启动样本。输出 `completed` 仅表示采样完成，不代表达到性能预算，也不是正式产品验收报告。

CI 的手动 `workflow_dispatch` 提供 `measure_performance` 布尔选项，默认关闭，避免每个 PR 都执行完整性能采样。启用后，各 profile 在产品候选完成验收和封印复核之后，以相同 Chromium 参数对四个公共示例各采样 3 次，归档 `browser-engine-performance.json`。常规 CI 的功能通过不表示已经运行性能实验；需要对照时应同时保留 full/2D 的这两份报告，比较相同 target、LTO、模块模式和采样条件。

## HTTP 压缩、候选冻结和浏览器验收

先生成压缩 sidecar，再冻结候选：

```sh
node apps/playground/scripts/prepare-site-delivery.mjs /absolute/path/site
node apps/playground/scripts/seal-site-acceptance.mjs \
  /absolute/path/site /absolute/path/reports --begin
```

`--begin` 输出 `reports/site-start.json`，所有产品浏览器测试读取相同上下文：

```sh
export PLAYGROUND_TEST_DIRECTORY=/absolute/path/site
export PLAYGROUND_ACCEPTANCE_CONTEXT=/absolute/path/reports/site-start.json
PLAYGROUND_FULL_ENGINE_REPORT=/absolute/path/reports/runtime.json \
node apps/playground/scripts/browser-full-engine-test.mjs
```

Chromium 执行完整产品测试；2D 还需要 `BROWSER=firefox`、`BROWSER=webkit` 的实际运行报告，分别写 `runtime.firefox.json`、`runtime.webkit.json`。其余必需报告为 `editor`、`bridge`、`projects`、`demo-regressions`、`react-demos`、`workbench` 和 `delivery`。每份报告都必须匹配 profile、发布 ID、描述符、候选、siteHash、runId、真实浏览器版本和 real-engine 模式。shell/mock 报告只归 contracts。

封印器还逐项验证 runtime 报告内容：Chromium 至少 50 轮额外生命周期，Firefox/WebKit 各至少 2 轮；须保留 13 个基础场景和每轮独立 iframe、原生/React 两种模式、真实音频事件、匹配的两个 worklet 哈希、每个 AudioContext 唯一关闭以及每轮压力运行的非零音频输出。errors/warnings 必须存在且为空。循环声明、空帧列表、未关闭音频或非空错误都不能仅凭 `status=passed` 获得封印。生产者默认采用相同最低循环数；调小循环数的探测报告不满足正式封印要求。`sourceCertified=false` 或缺少来源标记的站点在冻结前即被拒绝。

CI 还会在 Firefox 和 WebKit 分别执行真实 `browser-2d-features-test.mjs --sessions 1 --require-cjk`；默认 snake/camel 两种命名各运行一次，覆盖物理、导航、文本、输入和音频等特性。顶层报告分别为 `features.firefox.json`、`features.webkit.json`，截图等附属文件放在 `features-firefox/`、`features-webkit/`，不会覆盖 Chromium 的证据。它们补充产品启动报告，测试失败会阻止后续封印。

每个实际特性 case 都独立记录 `consoleErrors` 并要求为空，包含浏览器直接报告的 WebGL validation error；同时要求原生错误、生命周期泄漏警告、像素和音频断言通过。旧版 harness 曾可能在原生断言通过时漏计浏览器控制台错误，这类旧报告不能复用。第七项补丁改变 wrapper、模板归档和发布身份后，即使 WASM 哈希不变，也必须重新捕获实际 API、生成站点候选并完成其对应浏览器验收。性能表仅在新候选空闲采样后填入观察值，不从补丁或体积变化预写性能通过结论。

Linux 的 Firefox/WebKit 像素与真实 worklet 验收需要可用的图形和音频设备。CI 安装 Xvfb、Mesa、`pulseaudio` 和 `pulseaudio-utils`，在浏览器运行前启动或复用用户 PulseAudio server；新启动的 server 使用 `--exit-idle-time=-1`。它只加载一个名为 `godotjs_browser`、48 kHz 双声道的 `module-null-sink`，设为默认输出，并用 `pactl info` 与实际 sink 参数确认设备存在，不结束已有 server。

Firefox/WebKit 测试使用 `xvfb-run`、`BROWSER_HEADLESS=0` 和 `LIBGL_ALWAYS_SOFTWARE=1`。Firefox 在缺少图形环境的 headless 模式下可能选择 Godot Dummy renderer；此时不能把节点创建成功当作绘制通过，中文与 TileMap 等断言仍必须读取真实 viewport 像素。Pulse null sink 提供实际的音频混音设备，浏览器和 Godot 的 worklet 仍真实运行，测试通过 analyser 验证非零输出、停止后静音、恢复播放和退出关闭；它没有物理扬声器，不是替换 Web Audio 的 mock。仅有 Godot `playing` 状态或 worklet 加载成功不足以证明真实音频输出。

HTTP 解码必须在真实浏览器中验证：

```sh
PLAYGROUND_DELIVERY_REPORT=/absolute/path/reports/delivery.json \
node apps/playground/scripts/browser-http-delivery-test.mjs
```

完成全部报告后封印与复核：

```sh
node apps/playground/scripts/seal-site-acceptance.mjs /absolute/path/site /absolute/path/reports
node apps/playground/scripts/seal-site-acceptance.mjs /absolute/path/site /absolute/path/reports --verify
```

协商式 HTTP `Content-Encoding: gzip/br` 由浏览器透明解压，清单验证原始 WASM 哈希。已有显式 `.wasm.gz` 使用压缩/解码双哈希契约；同一层数据不可混用两种解压声明，清单 `encoding` 不能直接改为 `br`。

公开长期缓存仅用于明确声明的不可变 `/releases/<id>/...` 资源路径，并同步调整客户端请求策略。开发服务器默认保持私有/no-cache 策略；明确采用公共不可变路径时才设置 `PLAYGROUND_PUBLIC_IMMUTABLE=1`。HTML、入口指针与私有资产不能统一设置公共永久缓存。

## CI、本地验证与后续发布规则

CI 先构建共享 SDK，再按 profile/target/recipe 隔离任务、缓存、artifact 和报告。先修复 shell-only 前置构建，再开展实际模板与产品验收。源码认证、最小 Gate、产品站点验收和体积测量各有独立证据。

CI 额外打包并验证 `browser-engine-artifact/`，同时归档精确的模板 ZIP、原始 `engine-report.original.json`、可迁移的 `engine-report.json`、`build.log` 和 `artifact.json`。原始报告逐字节保留；便携报告仅将 `template.path` 改为同目录的 `engine-template.zip`，清单记录两份报告及所有文件的 SHA-256，并校验除路径外的语义一致性。已有产品描述符引用的原报告 SHA 不会被回填修改。

下载 artifact 到任意新目录后，可在原构建树不存在的情况下验证并复测：

```sh
node scripts/test/package-browser-engine-artifact.mjs \
  --out /absolute/download/browser-engine-artifact --verify
node scripts/test/measure-browser-engine.mjs \
  --report /absolute/download/browser-engine-artifact/engine-report.json \
  --out /absolute/download/remeasured.json
```

手工归档已有构建时，先运行 `node scripts/test/package-browser-engine-artifact.mjs --report /absolute/path/engine-report.json --out /absolute/path/new-artifact`；无源码证明的本地实验需显式加 `--development`，打包不会把它升级为已认证来源。

该命令也接受 wrapper 发布的当前报告。它按记录的 SHA-256 查找报告旁或其引用的不可变 ZIP 旁的编译日志，因此原构建树删除后仍可重新归档。发布前对输入报告、ZIP、日志与两个输出路径做交叉检查，并解析已有父目录的路径别名；重叠或会覆盖不可变归档的路径在任何写入前被拒绝。

当前只在本地使用独立的 editor/preview origin 验证候选，不调用外部部署服务。若后续另行发布，先向独立 editor/preview origin 上传同一候选资源树，验证哈希、压缩和访问规则后切换入口。部署配置在冻结前确定；冻结后的候选文件不能再修改。旧会话继续固定旧上下文，回滚切换入口指针并保留旧发布与所有项目数据。

发布须具备：可追溯构建来源、匹配的资源导入证据、Gate 1、真实产品报告、项目迁移无损、HTTP 压缩验证和最终站点验收收据。没有对应报告的阶段应标为待验证，不可由文档或空报告代替。
