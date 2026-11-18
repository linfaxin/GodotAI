# 引擎最小合同交付与接入

日期：2026 年 11 月 18 日。实施依据：[V4 完整方案](design/engine-minimum-contracts-v4.zh-CN.md)。W0–W5 已实现，选定范围验收通过。计数、站点身份、原始报告路径与校验值见[机器可读摘要](verification/engine-minimum-contracts.json)。

## 已落地的接入链

| 入口 | 接入方获得的能力 |
| --- | --- |
| `@godot-js/engine/release-assets` | 原始资产读取类型、存储与解码身份分离、统一限额校验解码 |
| `@godot-js/project-tools/environment` | 原始 release 到已校验基础编译输入、API 查询状态、模块与资源目标事实 |
| 既有 compiler / build-plan / type-environment | 捕获项目源，使用同一最终环境检查与构建，保留诊断、最终构建与产物身份 |
| `@godot-js/project-tools/browser` | 编译响应到单包/集合浏览器输入，校验独立 expected target 并拥有独立字节 |
| `@godot-js/engine/browser/release-adapter` | 原始 release/site 配对、镜像 URL 与 Dedicated Worker 发布输入 |
| 既有 Dedicated Worker runner | 完整七字段事件、observed 终态与本地兜底、取消和替换语义 |

普通项目选择 `{kind:'engine'}`，需要 SDK 的项目显式选择 `{kind:'sdk',mode:'production'}` 或 development。平台分析项目依赖、提供资源位置与读取器；引擎不猜测框架、会话或重试策略。完整声明用于编译，给 AI 的节选由平台控制。

基础输入经平台 demo/历史适配后只创建一次最终 CompilerEnvironment。基础 facts 描述已验证的 release 输入，最终 identity 绑定实际声明、路由、vendor 和模块。资源转换使用 facts 返回的目标，未知版本不硬编码支持。

旧版 release 未封印 engineId/extensionId 时，基础编译 target 和编译产物同样不填这两个字段；releaseId 继续通过 engineReleaseId 关联发布，不冒充原生身份。组合回归覆盖普通与 SDK 两种选择，贯穿环境装配、checked build 和浏览器产物装配。

Playground 与 Node 均已使用公共装配。Playground 检查和构建使用 demo 组合后的捕获快照，生产构建走 checked compileProject；补全与 hover 保留语言服务。诊断不重复追加，pin 由原 owner 释放，跨 Worker 转移不 detach 编译缓存。

复核后的 Node `checkNodeProject` 明确返回 `scope: 'typecheck'`、sourceHash 与类型诊断。资源目标未知或转换器未注册不阻断类型反馈；构建准备与编译仍严格拒绝这些资源前提，检查通过不表示资源可构建。

## 独立平台的参考接入

独立消费者从真实 tarball 安装两包，使用自己的项目输入和读取器，不导入工作区源码或 Playground 编辑器页面：

- [Node 合同执行 fixture](../packages/project-tools/test/fixtures/packed-node-consumer.mjs)。
- [浏览器合同执行 fixture](../packages/project-tools/test/fixtures/packed-browser-consumer.mjs)。
- [双包隔离安装与闭包检查](../packages/project-tools/test/packed-consumer.test.mjs)。

本轮浏览器消费者复用匹配站点分发的预览宿主。ReleaseContext 在测试适配层构造，同时附加到 release 与编译 metadata；站点有 demo seal 时普通项目也携带其 hash。产品字段不进入通用 helper。其它平台可发行自己的宿主，按实际字节更新封印和身份。

## 构建与回归入口

使用 `.node-version` 和 packageManager 指定的工具版本。站点继续使用既有 build.mjs，显式传入可信 Web engine report。资源工具需要具备所选 profile 的实际格式支持。

```sh
pnpm install --frozen-lockfile
pnpm build:packages
pnpm test:engine
pnpm test:playground
```

匹配站点就绪后执行核心入口：

```sh
PLAYGROUND_TEST_DIRECTORY=/absolute/matching-site BROWSER=chromium PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium PLAYGROUND_ENGINE_CONTRACT_REPORT=/absolute/reports/contracts.json pnpm --filter @godot-js/playground test:browser:contracts
```

五个 required 组为 preflight、lifecycle、failure-recovery、replacement、entry-resources。独立组执行后汇总，依赖失败前提的步骤标记 blockedBy；required 失败、阻塞或未执行均不能通过。无 session 的负例不伪造事实，报告写失败仍释放资源。CI 在匹配站点后调用该入口，并始终上传报告。

汇总器校验每份子报告与预检的 profile/releaseId/descriptorHash/candidateId 一致，并要求各真实运行 case 提供 engineExecuted 和完整 Worker/direct 运行身份。Schema 4 与资源专项在原生运行断言成立后记录执行标志，摘要直接保留报告值。身份不符、执行标志缺失或无实际 session 均会使门禁失败。

## 本次验证范围与来源

本地使用 Node 24.15.0、pnpm 10.11.0、Chromium 154.0.8037.57，目标为 full-engine-v1/template_debug、Dedicated Worker、direct。软件 GL 与专项 autoplay 覆盖如实记录，属于工程回归范围。

原生模板来自 a518dab 的 [CI run 44046900983](https://github.com/linfaxin/GodotAI/actions/runs/44046900983)，[artifact 14314188455](https://github.com/linfaxin/GodotAI/actions/runs/44046900983/artifacts/14314188455)。保留原始 ZIP、报告与 source/recipe/patch/native proof，核对实际字节。当前 SDK、宿主、API 捕获和站点独立重建，未拼接本机生成桥接字节或改写旧证明。

资源准备使用官方完整 Godot 4.6.1，核对官方 SHA-256/SHA-512 并实测 GLTF 导入。最终站点位于 `work/engine-minimum-contracts/site`；本地完整日志与报告位于 `/workspace/work/engine-contracts-implementation`。

| 验证 | 结果 |
| --- | --- |
| 工作区包构建 / Playground 类型检查 | 六个包构建、类型检查通过 |
| engine 与 project-tools | 221 项通过，零失败、零跳过 |
| Playground | 365 项通过，零失败、零跳过 |
| Worker runtime / session | 25 项通过 |
| 原生证明保留与拒绝回归 | 34 项通过，验证器未放宽 |
| 真实核心回归 | 五个 required 组全部 passed，报告 engineExecuted 为 true |
| 来源与候选检查 | seal-site-acceptance --begin 通过；此项不代表完整发行矩阵验收 |

独立浏览器消费者记录了 8 个实际 session，11 个步骤全部通过：原生 Label 读回、类型错误不启动、版本捕获、session 前取消、ready 前停止、错误 target/hash 保留旧运行、运行替换、过期准备拒绝、宿主失联恢复、普通场景及真实 ArtifactSet 早期挂载。PNG/WAV 原生加载、React 入口、异步失败修复与清理也有对应真实组结果。

最终 releaseId 为 `b478cd0991b3a55f271bb3c17c3c2fee543acb85e2ca60ed4409311f29c12361`。总报告及每个子报告均核对相同 releaseId/candidateId，摘要保留原始报告 SHA-256。来源检查发现的 ABI 证明漏传已修复：默认站点和静态 Web 包均保留原始 receipts，缺失和篡改仍被拒绝。

本次 HTTP 传输变体使用 gzip 9 / Brotli 5，验证解码后身份保持。原始资源文件、模板和证明未因传输编码改变。公共 npm 发布、其它浏览器/设备矩阵、AI 会话与玩法判断继续保持原方案范围。
