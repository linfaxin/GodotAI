# React TSX 实现清单与支持矩阵

本文对应 [V2 实施方案](react-tsx-design.zh-CN.md)，记录仓库当前实现的入口、范围和验证位置。这里的“已实现”表示已有实际代码和对应测试入口，不表示任意 Godot 类型、平台、引擎或能力组合已经认证。

运行与认证方法以 [tests/react/README.md](../tests/react/README.md) 为准。**本轮修复版[矩阵复验 14/14 通过](/workspace/work/review-fixes/matrix/react-matrix.json)**，使用统一源码、SDK 和二进制指纹，为 fresh execution。工作区构建、112 项包测试、原生测试、独立联网、源码映射及旧工程回归汇总于[验收记录](/workspace/output/react-tsx/review-fixes/validation-summary.json)；认证只覆盖记录中的引擎、构建参数、fixture 和模式。

## 1. 应用模型与默认支持面

作者编写普通 React 函数组件、Hooks 和 TS 模型。多个场景、常驻 HUD、弹窗和 Provider 在同一个 React root 中组合；React 已提交的 host graph 决定业务节点的身份、名称、父子关系、顺序和销毁。生成 TSCN 是启动器或依赖扫描载体，模板输入离线展开为普通 React host 元素；运行时不把源 PackedScene 当作黑盒业务子树实例化。

**一个 GodotJS Environment / JavaScript realm 同时只允许一个 active React root。** 多入口可配置，但同一 realm 必须先关闭当前 root，才能启动另一个入口；并发第二个 root 返回 `E_MULTIPLE_ROOTS_UNSUPPORTED`。多进程或独立 Environment 的入口不自动共享 Context、Hooks 状态或 renderer 资源作用域。

默认 host profile 是 `core-ui-v1`，仅含以下 8 类：

| Host | 已实现的主要输入或事件 |
| --- | --- |
| `Node` | 构造期 `name`、只读 ref |
| `Node2D` | `position`、`rotation`、`scale`、`visible`、`modulate`、受限 `material` |
| `Control` | 可见性、最小尺寸、size flags、mouse filter、focus signals |
| `VBoxContainer`、`HBoxContainer` | 上述 Control 输入；容器布局输出由引擎持有 |
| `Label` | Control 输入及 `text` |
| `Button` | `text`、`disabled`、`toggleMode`、`buttonPressed`、pressed/toggled 与 focus signals |
| `CanvasLayer` | `visible`、`layer`、`offset`、`rotation`、`scale` |

准确逐字段名单见 [core schema](../scripts/jsb.react/src/schema/core.ts)；不是从 Godot 类继承关系自动放开全部属性。原始字符串或数字不会隐式生成 Node，文本通过 `Label.text` 等明确字段表达。未知 props、方法冒充属性、不支持的 host 和任意原生 Object 都被拒绝。

`Button.toggleMode` 与 `buttonPressed` 共享 `button.state` alias group；setter 按 schema 的显式依赖顺序执行，不依赖 JSX 属性书写顺序。请求 `buttonPressed=true` 需要有效的 `toggleMode=true`。

## 2. 独立 profile 与组合边界

Host profile 与模板导入 profile 是不同维度。使用一个扩展不自动开放其他能力。

| 配置或 profile | 已实现范围 | 明确边界 |
| --- | --- | --- |
| 默认 `profileId: "core-ui-v1"` | 上述 8 类 host；有限值 codec；只读 AssetRef；共享无 Script 的 Resource/CanvasItemMaterial 资产闭包 | 不开放 physics、portal、LineEdit/IME、任意 Script 或通用 Godot 方法 |
| 显式 `profileId: "behavior-physics-v1"` | 保留 core 的 8 类，再增加 `CharacterBody2D`、`StaticBody2D`、`CollisionShape2D`，共 11 类；velocity/upDirection/floor/collision/shape 字段；physics phase 的 `setVelocity`、`moveAndSlide` | shape 引用限已列入的 Circle/Rectangle/CapsuleShape2D；不是完整 GodotPhysics API、3D 物理或任意刚体方法 |
| 默认 `template-t0` | format-3 文本 TSCN、已认证 hosts/属性、平面树、受限外部共享资源 | 拒绝嵌套/继承 PackedScene、local-to-scene、Script、持久连接、嵌入资源和未知构造语义 |
| 显式 `template-local-v1` | 平面模板中的受限 Resource/CanvasItemMaterial local-to-scene；每实例原生克隆、同实例别名、`get_local_scene()`、owner 和释放作用域 | 只允许平面模板；local shape 与其他复杂资源类型不在该 profile 的构建白名单 |
| 显式 `template-structural-v1` | 共享资源的有界 nested/inherited PackedScene 展开、已支持的属性 override；完整 host Plan | 仅 shared 资源；32 层场景依赖深度、10,000 个节点上限；不支持任意 index 重排、未知继承/实例编辑语义 |
| 显式 `nativeInterfaces` 配置与 `defineNativeInterface` token | 构造前选择生成的原生 leaf Script；静态 callback/RPC schema、已提交 handler registry、受限 RPC codec | 不接管任意旧 Script；不动态换 Script/schema；真实联网认证须独立使用 SceneMultiplayer/ENet fixture |

**`template-local-v1` 与 `template-structural-v1` 不可组合。** 目前没有 structural-local profile；不能将嵌套场景内的 local resource 合并为外层模板的单一 scope，也不以浅复制模拟原生场景作用域。相关输入在构建期明确拒绝。

模板只通过登记后的 `@project/react-templates/<assetId>` 模块导入，生成资产专属 root props 声明。没有全局 `*.tscn: any` 兜底，也不开放任意 children 或内部路径 overrides。

当前 host schema 的内容 hash 如下；profile 内容变更必须重新构建并认证产物：

```text
core-ui-v1
2807c96de6bd7f87174263262ec5c9d1a8f473a1e5620175f2edf179cb58eae5

behavior-physics-v1
9c21f0cf123005826d3277547d1d5871b336b931606f353e45afa704ef5827a8
```

模板 profile 的拒绝规则不通过修改 core 默认 host 名单实现。具体 registry 和 hash 入口见 [profiles.ts](../scripts/jsb.react/src/schema/profiles.ts)、[physics.ts](../scripts/jsb.react/src/schema/physics.ts)。

## 3. W00–W14 对照清单

下表的验证列是复现入口；实际执行结果见第 5 节。未开放的能力不会因为相邻 profile 通过而自动取得认证。

| 工作包 | 当前实现与接口 | 主要实际文件 | 对应 fixture / 验证入口 |
| --- | --- | --- | --- |
| W00 合同/profile | 无 Godot/React 运行依赖的 DTO、稳定错误码、严格 validators；NativeKey uint32 pair、manifest/active/template/boot、三屏障和清理合同；未知字段、canonical res URI、hash 与依赖校验 | [contracts](../scripts/jsb.react/src/contracts/index.ts)、[schema](../scripts/jsb.react/src/schema/index.ts)、[native manifest validation](../internal/jsb_react_manifest_validation.cpp) | [合同测试](../scripts/jsb.react/src/contracts/contracts.test.cjs)、[共享 manifest fixture](../scripts/jsb.react/src/contracts/fixtures/runtime-manifest-v1.json)、[NativeKey fixture](../scripts/jsb.react/src/contracts/fixtures/native-key-v1.json)、[原生 manifest 测试](../tests/test_jsb_react_manifest.h) |
| W01 HEAD 基线/QA | 隔离复制并构建原生源码、记录源码闭包/recipe/flags/二进制 digest；执行原生 tests、双引擎/双模式应用矩阵 | [native build](../scripts/test/react-native-build.mts)、[native test](../scripts/test/react-native-test.mts)、[matrix](../scripts/test/react-matrix.mts)、[integration](../scripts/test/react-integration.mts) | [测试说明](../tests/react/README.md)、[最终统一证书](/workspace/output/react-tsx/review-fixes/validation-summary.json) |
| W02 source map | 标准 VLQ、generated/source delta、GLB/unmapped 和非法索引处理；生成 map 路径归一化；原生 caught/uncaught stack 映射 | [source map](../internal/jsb_source_map.cpp)、[cache](../internal/jsb_source_map_cache.cpp)、[构建映射](../scripts/jsb.react-build/src/source-maps.ts) | [原生标准测试](../tests/test_jsb_source_map.h)、[真实 TSX 异常 fixture](../tests/react_source_maps/README.md)、core fixture 的 signal throw |
| W03 编译/manifest | 完整严格 TypeScript Program、entry props 检查、标准 JSX、canonical React/runtime resolver；generation 模块、原生 Script 身份、三类依赖和 artifacts | [compiler](../scripts/jsb.react-build/src/compiler.ts)、[config](../scripts/jsb.react-build/src/config.ts)、[bootstrap](../scripts/jsb.react-build/src/bootstrap.ts) | [build tests](../scripts/jsb.react-build/test/build.test.mjs)、[bootstrap tests](../scripts/jsb.react-build/test/bootstrap.test.mjs)、[core fixture](../tests/react/fixture) |
| W04 schema/类型 | 人工维护的逐字段 props、codec、alias/effect、signal echo、构造字段、setter 顺序和 physics 扩展；组件类型与安全 facade 类型 | [components](../scripts/jsb.react/src/components.ts)、[core schema](../scripts/jsb.react/src/schema/core.ts)、[codecs](../scripts/jsb.react/src/schema/codecs.ts)、[props validation](../scripts/jsb.react/src/schema/validation.ts) | 合同正负例、runtime 类型/codec 负例、实际 GUI 与 physics fixture；没有自动反射放开全部 Godot 类型 |
| W05 图/facade/events | prepared 描述与已提交 host graph；key/名称/顺序审计；只读 ref、受控事件队列、immutable initial、engineOwned、committed callbacks 与短期 Commands | [runtime](../scripts/jsb.react/src/runtime.ts)、[godot adapter](../scripts/jsb.react/src/godot.ts)、[private backend](../scripts/jsb.react/src/native-port.ts) | [real React/mock tests](../scripts/jsb.react/tests/runtime.test.cjs)、[adapter tests](../scripts/jsb.react/tests/godot-adapter.test.cjs)、core fixture |
| W06 RuntimePump | 固定版本 Scheduler 算法和私有 host queue；safe pump、microtask、timeout/预算；用户全局 timer 不替换 | [scheduler](../scripts/jsb.react/src/scheduler.ts)、[scheduler host](../scripts/jsb.react/src/internal/scheduler-host.ts)、[runtime](../scripts/jsb.react/src/runtime.ts)、[launcher](../scripts/jsb.react-build/src/bootstrap.ts) | runtime/adapter tests、development/production 原生 integration；不承诺任意 JS 库的宿主环境兼容性 |
| W07 NativeBridge | 私有 root capability、原生 phase/结构守卫、精确目标操作与后置审计；真实 stored-state 验证；稳定 revisioned 失效数据；Script/rebind 保护 | [React bridge](../bridge/jsb_react_bridge.cpp)、[ObjectDB](../bridge/jsb_object_db.h)、[Environment](../bridge/jsb_environment.cpp)、[binding guards](../bridge/jsb_object_bindings.cpp) | [原生 bridge 测试](../tests/test_jsb_react_bridge.h)、adapter tests、外部 mutation 负例；不宣称 veto 任意 GDScript/C++ 修改 |
| W08 生命周期集成 | NativeApplied、LayoutPublished、PassiveSettled/CleanupReceipt；retirement batch；refs/passive cleanup 后 free；quiesce、fault、失败启动与强制关闭路径 | [runtime](../scripts/jsb.react/src/runtime.ts)、[godot adapter](../scripts/jsb.react/src/godot.ts)、[React bridge](../bridge/jsb_react_bridge.cpp)、[run lease](../internal/jsb_react_run_lease.cpp) | runtime/adapter 的 cleanup/fault/StrictMode 用例、原生 bridge 与反复 key reset/退出 fixture；资源计数按 owned scope 与暖机基线判定 |
| W09 模板前端 | 严格无执行文本 grammar、依赖预检查、TemplatePlan、模板模块与专属声明；各模板 profile 的明确拒绝表 | [template importer](../scripts/jsb.react-build/src/template.ts)、[template contract](../scripts/jsb.react/src/contracts/types.ts)、`createTemplateComponent` | [template tests](../scripts/jsb.react-build/test/templates.test.mjs)、core T0 fixture、local-resources fixture |
| W10 隔离提取 | 冻结 snapshot 闭包复制到最小临时项目；受限 SceneState 提取，对照节点、属性、owner 和顺序；不加载用户 autoload/plugin，不实例化模板树 | [snapshot helpers](../scripts/jsb.react-build/src/fs.ts)、[template verification](../scripts/jsb.react-build/src/template.ts)、[extractor](../scripts/jsb.react-build/src/extractor.ts) | template/native equivalence tests；脚本、间接脚本和不支持格式的拒绝用例；范围仅限已接受的 parser/profile 子集 |
| W11 发布/编辑器/导出 | publish/run leases、staging/journal/recovery、不可变资源闭包、import 后 seal、active 最后提交；固定 ticket、GC、F5/watch；正式 CLI 临时 PCK→空目录验证→发布 | [publication](../scripts/jsb.react-build/src/publication.ts)、[commands](../scripts/jsb.react-build/src/commands.ts)、[native target](../scripts/jsb.react-build/src/native-target.ts)、[project policy](../scripts/jsb.react-build/src/project-policy.ts)、[editor](../weaver-editor/jsb_editor_plugin.cpp)、[exporter](../weaver-editor/jsb_export_plugin.cpp)、[loader](../weaver/jsb_resource_loader.cpp) | [publication tests](../scripts/jsb.react-build/test/publication.test.mjs)、[process tests](../scripts/jsb.react-build/test/process.test.mjs)、[native target tests](../scripts/jsb.react-build/test/native-target.test.mjs)、selected-scenes PCK integration；认证导出入口为 CLI |
| W12 行为/input | `useProcess`、`usePhysicsProcess`、`useInput`、`useNativeReady`；固定 committed preorder/Hook 顺序、field lease、同步回调、过期 Commands 拒绝；输入转只读 DTO | [runtime hooks](../scripts/jsb.react/src/runtime.ts)、[input adapter](../scripts/jsb.react/src/godot.ts)、[physics schema](../scripts/jsb.react/src/schema/physics.ts) | runtime/adapter tests、GUI core fixture、真实碰撞 [physics fixture](../tests/react/physics)；复杂输入路由/handled 能力未开放 |
| W13 per-node/RPC | 静态 interface token/schema、生成真实原生 leaf Script、构造前关联、committed handler registry；受限网络 DTO/稳定 ID；本地发送状态与远程业务响应分开 | [runtime native interfaces](../scripts/jsb.react/src/native-interfaces.ts)、[interface generator](../scripts/jsb.react-build/src/native-interfaces.ts)、[React bridge](../bridge/jsb_react_bridge.cpp) | [schema/generator tests](../scripts/jsb.react-build/test/native-interfaces.test.mjs)、[registry tests](../scripts/jsb.react/tests/native-interfaces.test.cjs)、[双进程/PCK RPC fixture](../tests/react_native_interfaces/README.md)；不能以 metadata 或 send 返回值替代真实联网认证 |
| W14 复杂资源/导入 | 独立 flat local resource scope 与 bounded structural/shared 展开；原生 `duplicate_for_local_scene`、setup、alias、owner 与释放 | [local resources](../internal/jsb_react_local_resources.cpp)、[template importer](../scripts/jsb.react-build/src/template.ts)、[template runtime](../scripts/jsb.react/src/runtime.ts) | [原生 local-resource 测试](../tests/test_jsb_react_local_resources.h)、[local-resources fixture](../tests/react/local-resources)、template structural tests；复杂动画与 structural-local 组合未开放 |

## 4. 跨层合同如何落到当前实现

`@godot-js/react/contracts` 与 `/schema` 可以由 Node 构建器和 SDK 使用，不导入 Godot 或 React。manifest、active、TemplatePlan、BootReport 和 NativeKey 使用共享合同；原生端对 manifest 做严格结构、路径、hash 和边验证，并读取同源 conformance fixture。

原生执行入口采用持有私有 root capability 的窄方法集合。Godot adapter 将原生接受/拒绝、结构或存储验证结果映射为 `NativeOpResult` 诊断；runtime 产生带 CommitTicket 的发布及清理收据。并非每一个导出的合同 DTO 都被逐字段序列化成独立 native 调用参数。实际安全边界是原生 root/lifetime/phase/ownership 检查、不可变 NativeKey、SDK 的 committed registration 与每次 dispatch 的过期检查；公开 ref 不提供结构写入或通用原生调用入口。

属性存储验证区分明确的原生规范化与拒绝：例如 Vector2 的 native real 精度、方向归一化、Node2D 非零 scale 规则。不能用 JS `JSON.stringify` 精确比较所有浮点值，也不能把 native setter 返回无异常当作已经接受写入。此验证只证明已认证字段的同步存储语义，不证明 physics/render server 的任意副作用。

必要启动资产通过 manifest/受控任务加载；render 只产生 JS 描述和资源请求，不在 host render 中创建原生业务 Node。被放弃的 render 不需要回收未提交子树的原生节点。

## 5. 构建、启动与认证的边界

构建器生成普通模块、真实原生 Script、入口 TSCN、resource/export hubs、source maps 和 sealed manifest。资源路径转入不可变 generation 闭包；原模板无需随运行包存在。`generatedDir` 当前固定为 `generated/react`，不承诺任意布局兼容原生集成。

正式启动绑定 generation 和 RunLease，校验 ABI、当前 SDK 的 React/reconciler/scheduler tuple 与 profile hash，以及原生 descriptor 的 engine/Godot version。原生源码 commit、源码闭包 digest、构建 flags 和二进制 digest 来自实际 native build report；不能用应用工程的 git 状态冒充原生二进制来源。

check/build/preview 可以用于明确未认证的开发环境。正式 CLI export 要求 source-certified target，并在临时 PCK 的空目录启动验证及配置的业务验证完成后才发布最终包。F5 有同步构建门禁；原生 exporter 消费 manifest 依赖。本文不将 GUI export 的日志错误等同于独立完成的强制中止认证，也不把任意导出预设当作已证明的依赖闭包。

SDK BootReport 的 scope 是 framework boot smoke：首个有效发布、树审计、所需资产和未预期错误。它不证明未执行分支、游戏规则或网络行为；这些由 fixture 或项目提供的独立 verification entry 断言。退出码 0 或单独的成功标识不足以认证。

最终认证逐项记录下列范围，不能从一个结果外推其他组合：

| 认证对象 | 权威入口或报告 | 本文状态 |
| --- | --- | --- |
| 工作区构建与包测试 | [构建日志](/workspace/output/react-tsx/review-fixes/workspace-build.log)、[包测试日志](/workspace/output/react-tsx/review-fixes/package-tests.log) | `pnpm build` 通过；runtime 70/70、builder 42/42，合计 112 项，0 失败、0 跳过；包含真实隔离 SceneState 提取 |
| 原生合同、桥接、资源与 source-map 测试 | [QuickJS](/workspace/work/review-fixes/matrix/native-qjs/react-native-tests.json)、[V8](/workspace/work/review-fixes/matrix/native-v8/react-native-tests.json) | QuickJS 38 用例 / 705 断言，V8 37 用例 / 700 断言；合计 75 用例、1,405 断言全部通过 |
| 当前源码 QuickJS / V8，development / production | [最终矩阵](/workspace/work/review-fixes/matrix/react-matrix.json) | 14/14 通过；Linux x86_64、Godot 4.6.1、headless 构建 |
| core GUI、多场景、T0 模板、资源、key reset 与 selected-scenes PCK | [core fixture 与说明](../tests/react/README.md) | 双引擎、双模式 source 通过；正式 production PCK 空目录重跑通过；100 次 key 重建、输入 DTO、受控按钮和 StrictMode 检查通过 |
| 真实物理碰撞与过期 command | [physics fixture](../tests/react/physics) | 独立 profile：双引擎、双模式 source 与正式 production PCK 通过 |
| flat local resource 的 alias/实例/owner/get_local_scene 与 PCK | [local-resources fixture](../tests/react/local-resources) | 独立 profile：双引擎、双模式 source 与正式 production PCK 通过 |
| bounded structural/shared 的 SceneState 等价 | [template tests](../scripts/jsb.react-build/test/templates.test.mjs) | 构建器 42 项测试通过，含真实隔离 SceneState 正例；不外推 structural-local 组合 |
| 真实双端 RPC、authority/channel/path/重连与 PCK | [QuickJS](/workspace/work/review-fixes/qjs-rpc/rpc-report.json)、[V8](/workspace/work/review-fixes/v8-rpc/rpc-report.json) | 显式 opt-in；双引擎 production/development source 与正式 production PCK 的真实双进程联网通过；验证 latest committed handler、sender peer、拒绝路径、重连、StrictMode effect 重放及 native ready 一次性 |
| caught/uncaught TSX 原始位置与列号边界 | [QuickJS](/workspace/work/review-fixes/qjs-stack/source-map-report.json)、[V8](/workspace/work/review-fixes/v8-stack/source-map-report.json) | 双引擎 caught、minified 和原生 uncaught TSX 定位通过；无证据列号仍保留安全回退 |
| 旧 TS + TSCN 使用方式 | [旧用法回归](/workspace/work/implementation-qa/final-matrix-e61c/legacy-ts-regression.json) | 双引擎直接运行、selected-scenes 导出及空目录 PCK 通过；原有 Script 路径保留 |
| 新增边界与实际 watch 重启 | [QuickJS](/workspace/work/review-fixes/qjs/review-regressions.json)、[V8](/workspace/work/review-fixes/v8/review-regressions.json) | 双引擎 development/production source、正式 production PCK 和实际预览重启通过；原生业务断言覆盖 ref 重绑定、存活期 Ready cleanup、Node/CanvasLayer 的 Suspense 隐藏恢复与开发诊断 |
| 原生及 Inspector transport 日志 | [修复版日志审计](/workspace/output/react-tsx/review-fixes/log-audit.json) | 各 runner 的业务错误检查和统一 Inspector transport 扫描通过；RPC 仅接受精确列明的预期负例；运行时和编辑器 Inspector 均隔离禁用 |
| JSC/Web、其他 OS/arch/build flags | 本轮矩阵之外的专门报告 | 不由现有 QuickJS/V8 用例授予认证 |

验证环境为 Node `24.19.0`、pnpm `11.25.0`、Godot `4.6.1.stable.custom_build`。原生基准 commit 是 `b1d8b3f4d4688d216657364ddc53db0813444411`；实际认证绑定下列源码和 SDK 内容指纹。实现提交入库不改变内容指纹，不能只凭原生基准 commit 复现新增实现：

```text
native source snapshot
a9269630053b2e531517ee5a3479e627b27d6d16480ed39dacadcf27d01d6010

SDK source + dist + lockfile
363b76c0b91eb4ae73c6c0bc01f3a4a0de431728db0d505f5af4ff6bc4233f2e
```

两种引擎使用同一份原生源码和 `godotjs-scoped-fontconfig-v1` 构建 recipe；隔离构建将 fontconfig 宏限定到实际使用的 platform 编译单元，保留动态 fontconfig 支持。完整 flags、recipe 修改前后内容、hash 和二进制 SHA 位于 [QuickJS 构建报告](/workspace/work/implementation-godot-qjs/react-native-build.json)与 [V8 构建报告](/workspace/work/implementation-godot-v8/react-native-build.json)。本轮 headless 行为认证不覆盖 GPU 渲染效果或 Inspector 连通性。

## 6. 未实现或未开放的能力

以下限制是当前交付范围的一部分，不应以“完整替代所有 TS+TSCN/Godot 能力”概括：

- portal、外部 native 容器挂载、跨 Viewport/窗口投送和多 active root 同 realm。
- LineEdit、文本选择/光标/IME 认证；custom viewport 的输入路由、handled/unhandled arbitration 与公开 `useUnhandledInput` 能力。
- 复杂 AnimationPlayer/动画轨道的 NodePath、property lease、method track，以及音频等未列入 profile 的系统。
- Inspector 的 typed exports、任意原生公开方法/信号生成和完整 Godot debugger/React DevTools；配置入口 props 与静态 RPC schema 不等于这些能力已经实现。
- 任意旧 Script 的自动迁移、旧 Script 与生成 leaf Script 叠加、动态 `set_script`、动态接口 schema、线程组直接执行 React。
- 任意 Godot 类、任意 Resource/二进制场景、运行时黑盒 PackedScene mounting、不支持的模板 constructors/connections/subresources/owner overrides。
- structural-local 组合、任意继承/嵌套编辑语义、local 复杂资源和本轮白名单之外的资源克隆。
- KeepAlive/隐式停车、HMR/Fast Refresh、活动 generation 无重启热切换、跨父级搬迁保留 React 局部状态。
- DOM/React Native 组件兼容、Server Components、异步 frame callback，以及通用 `.raw`/原生 `call`/`set`/改树后门。
- 阻止任意 GDScript/C++ 在修改前触碰受管树的全来源内核 veto；当前实现对支持的桥接路径施加守卫，并对外部违规进行审计、失效和关闭。

现有旧 `.ts` NativeScript 身份与默认路径仍保留。采用 React 的应用需要把业务节点树、生命周期和所有权迁移到受支持的组件/Hooks/profile；旧 `.ts` 模型和纯工具可以继续复用。新增代码清单与最终认证结论是两个独立交付项。

## 7. 2026-11-02 检查问题修复

[原检查记录](/workspace/output/react-tsx/implementation-review.json)保留当时的问题和复现结果；本轮修复及新内容指纹的验证汇总见[修复版验收记录](/workspace/output/react-tsx/review-fixes/validation-summary.json)。此前的原生源码快照未变，SDK 内容指纹已更新，旧 SDK 的测试记录不替代本轮执行。

| 问题 | 当前实现 | 回归入口 |
| --- | --- | --- |
| R1 普通安装布局 | 从消费项目解析 React 类型，保留应用的 ambient 类型根；SDK 显式声明 React 类型 peer dependency | [独立安装测试](../scripts/jsb.react-build/test/installed-package.test.mjs) |
| R2 Frame ref 重绑定 | 每次发布统一刷新 ref 目标，重新验证全部候选租约后激活 | [运行时边界测试](../scripts/jsb.react/tests/review-regressions.test.cjs)、[原生 fixture](../tests/react/review-regressions/README.md) |
| R3 Ready cleanup | ref 清空或目标退休时先清理；执行前撤销 cleanup 记录，异常时也不重复执行 | 同上 |
| R4 Suspense 隐藏 | 覆盖非视觉 Node 后代和 CanvasLayer；保留原有/最新受控可见性；React 开发态 Promise 使用私有时钟，不依赖或修改浏览器全局对象 | 同上，含无全局 performance 的开发态用例 |
| R5 watch 重启 | SDK preview 监督、全生命周期 reader lease、旧子进程退出后重启、构建失败恢复、取消及只终止自有子进程；外部应用不接管 | [watch 测试](../scripts/jsb.react-build/test/watch.test.mjs)、双引擎原生 fixture |
| R6 单 writer | 每 Host 最多一个 active 的写帧注册，即使字段或执行 phase 不同；额外只读注册仍允许 | 运行时边界测试 |
| R7 initial 诊断 | 开发态结构化 onDiagnostic/getDiagnostics 与默认 warning；保留基线，不将提示归类为运行故障 | 运行时边界测试与原生 fixture |

## 8. 后续评审 A1：模块依赖门禁

后续 [完整改动评审](/workspace/output/react-tsx/full-change-review.json) 的 A1 已修复。应用及其打包依赖中的非字面量 require/import、require 别名和计算路径 glob 加载，在产物发布前以 `E_DYNAMIC_MODULE` 拒绝；静态导入、字面量加载和普通同名函数保留支持。

本项验证为构建器 45/45 测试、真实 QuickJS production source 与正式 production PCK 空目录回归，详见 [A1 验证记录](/workspace/output/react-tsx/p1-module-loading/validation.json)。第 5 节的完整双引擎矩阵及其 SDK 指纹是此前七项修复的验收快照；A1 之后的 SDK 指纹与本轮较窄的验证范围以 A1 记录为准。A2、A3、A4 不属于本项修复。
