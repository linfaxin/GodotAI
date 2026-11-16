# 引擎执行与构建主链：本轮实现

本轮保留完整 Godot、默认 Dedicated Worker、同 realm 的 GodotJS/可选 React。改动集中在入口清理、原生退出门控、自动帧维护、构建字节所有权和共享编译入口。pthread 仍是显式候选；没有发布站点、npm 包或切换默认执行后端。

## 入口生命周期

普通 Schema 4 脚本仍导出 `start(ctx)`，上下文包含 `mount`、`godot`、捕获的 `host`，以及宿主存在时的 `lifetime`：

```ts
interface EntryLifetime {
  readonly cancelled: boolean;
  onCancel(callback: () => void): () => void;
  defer(cleanup: () => void | PromiseLike<void>): () => void;
}
```

在异步启动的第一次 `await` 前登记已拥有资源的清理。`defer()` 返回该项的注销函数；关闭前注销仅移除自己的登记。关闭后不接受新的普通登记。取消通知是协作式通知，不会中止任意 Promise，也不提供 DOM `AbortSignal` 或 `ctx.signal`。

清理预算按当前登记计数；注销项和已完成资源退役后回收槽位及回调引用。React root 仅在确认实际原生释放完成后解除自动登记，已经开始的异步 close 在 Promise 结束前仍计入待清理任务。

`start()` 可以返回 Promise，最终返回 `void` 或一个清理函数。新 bootstrap 使用 `finishStartup()` 跟踪结果；关闭时先撤销业务命令/事件，广播取消，再按逆序逐项执行登记的清理并跟踪异步结果。未完成启动不会因为其他清理已结束就变成成功。清理失败保持失败；native epoch 封结后，迟到结果不能再调用原生对象。

纯 `RuntimeHost` 仍是 `apiVersion: 1` 的诊断、项目事件和命令服务。内部 binding 的 `beginClose()`、`drainClose()`、`closeProgress()` 管理关闭进度，`SessionFacts` 分别记录入口清理、epoch、原生退出和宿主回收。命令回执继续表示同步分发，而非异步命令完成。

没有安装浏览器 binding 的独立原生程序仍可运行。其兼容 bootstrap 不等于具备新的 Web 原生退出屏障，也不能据此承诺所有后端都能等待异步清理。

## React root 与自动调度

`createRoot(mount, {runtimeHost: ctx.host, lifetime: ctx.lifetime})` 会通过内部 `attachEntryCleanup()` 将 root 绑定到捕获的入口。普通脚本创建的 root 也参与入口关闭；不必依赖 React 专用 bootstrap 才能登记。关闭后拒绝新 root 和新的业务渲染。

| API | 实际语义 |
| --- | --- |
| `root.shutdown()` | 请求关闭并尝试推进；保持 `void` 返回值 |
| `root.close()` | 幂等 Promise，返回 `complete`、`failed` 或 `unconfirmed` 及待释放数量 |
| `root.getCloseProgress()` | 分别报告逻辑 disposed 状态和实际待释放记录 |
| `root.sealClose()` | 封结后停止原生读取，把未完成关闭确认为未确认结果 |
| `processFrame()` / `physicsFrame()` | 自动驱动入口，使用 session epoch、原生帧计数和工作修订合并维护 |
| `process()` / `physics()` / `pump()` / `flush()` | 保留显式手动语义，不按帧号吞掉调用 |

`queue_free()` 只表示原生接受了释放请求。session 在逻辑 root disposed 后继续保存释放记录，实际身份失效后才能确认关闭完成。原生封结会冻结未完成结果，不通过访问已销毁对象补证。

同一 session 共享自动维护与工作预算；每个 root 仍收到自己的 process/physics 订阅。新同帧工作、scheduler 唤醒和原生回调中的外部写入会使旧维护结果失效。完整外部结构审计仍启用，本轮没有用尚未验证完整性的结构通知替换审计。

## Web 原生退出屏障

匹配引擎声明 `execution.lifecycleAbi: 1`；普通 Worker 的 runtime ABI 同时带 `lifecycle: 1`。这些字段来自实际应用的 `web_main.cpp`、`scene_tree.h`、`scene_tree.cpp` 补丁记录，并由 release 验证器对照源快照、补丁链和实现哈希核验。`_godotjs_release_exit` 导出与模块生命周期版本也必须匹配。

Stop 和项目自身的 `quit()` 都进入 owner realm 的 native pre-exit gate：

```text
撤销业务服务、关闭入口
  -> 跟踪异步启动/清理、关闭 React roots
  -> cleanup-only tick 返回原生后消费删除队列
  -> 后续 tick 确认完成并释放退出屏障
  -> native cleanup、epoch 封结、宿主资源回收
```

清理阶段不执行 SceneTree process/physics，也不刷新通用延迟业务调用队列。普通帧停止后，原生删除队列仍能推进 attached/detached 节点的销毁。宿主仍保留有期限的强停路径，未结束的清理、缺失摘要和强制终止不会被 exit code 0 覆盖。

已开始的清理不会因关停操作过早关闭其仍需使用的 native 音频/浏览器服务。宿主负责及时静音、撤销业务输入和最终资源回收；native 服务的终结遵循原生退出顺序。

音频 drain 为存活的 voice/sample 和输入保留独立、有上限的释放命令额度；普通命令队列满时仍可发送 stop/unregister/input-stop，且只由匹配 epoch 和序号的 ACK 归还额度。单个清理组件出错会保留故障事实，后续 gate 和安全点 quit 仍继续执行。

DOM drain 同样保留独立额度：Worker 为至多 16 个镜像元素以及 pointer/fullscreen、speech、drop 的释放命令预留 20 个传输槽位。业务命令等待回执不会占用这些槽位；当前运行的匹配序号回执归还额度，重复或过期回执无效，发送失败立即回收本次槽位。主线程等待中的 clipboard/fullscreen 等普通特权请求也不占用 drain 的释放请求预算；两侧清理队列均保持有限上限。

这些修改需要重新构建对应 JS/WASM/Worker/worklet 与 descriptor。旧模板不会因为更新 SDK 或增加 metadata 获得退出屏障。原生逻辑封结与物理 bridge 析构仍是不同事实；bridge 还阻止已封结环境的迟到 JS 调用重新进入 WASM。

## 构建字节与资源格式

`project-tools` 的源快照与输出 overlay 使用 package-owned `Uint8Array`。输入获取所有权，公开读取返回副本，内部可信阶段可以复用已拥有的字节。旧项目 JSON 的 `number[]` 留在序列化边界；不能通过 `.buffer` 或子视图改变已记录的源和输出身份。

PCK writer 先校验布局与预算再分配最终 pack，目录 MD5 只覆盖当前 TypedArray 的精确范围；SHA-256 继续承担构建/产物身份。MD5 不是新的完整性认证机制。

PNG/JPEG 和 PCM WAV producer 使用 Godot 4.6.1 已支持的 `PackedByteArray("base64...")` TRES，直接向结果缓冲区写 ASCII，保留 `ImageTexture` 和 `AudioStreamWAV` 类型、原始源字节及 UID/remap。编码前检查生成字节预算，累计输出也受 pack 预算约束。

Base64 消除了逐字节十进制列表的放大，但 RGBA 仍是解码后的数据。2K RGBA 为 16 MiB，Base64 约 21.33 MiB；4K RGBA 已是 64 MiB，不能承诺放入当前 64 MiB PCK。编辑器现有 64 文件、单二进制文件 1 MiB、源总量 8 MiB 限制也没有因此提高。

CTEX 仅作为原型验证，未替换默认 producer。它返回的 `CompressedTexture2D` 与现有 `ImageTexture` 有可观察类型差异。自定义压缩容器、原生资源 loader、Godot editor importer 和普通 editor 重导出兼容均未因本轮 Base64 改动启用。收据证明已执行的 producer 与实际输出字节，不能代替未执行的解码或设备验收。

## 共享编译与项目格式

`compiler-policy` 的 `godotjs-engine-compiler/1` 同时派生检查和 CommonJS emit 设置。`createProjectTypeEnvironment()` 为类型检查和编辑器语言服务提供拥有声明字节的虚拟环境；`createCompilerEnvironment()` 将实际声明、模块路由、runtime/vendor 字节、TypeScript/policy 与匹配目标纳入身份。

`compileBuildPlan()` 统一准备、overlay 验证、PCK 和收据；`compileProject()` 在同一源快照上先执行类型检查。Playground 的完成/悬停消息、资源获取和 release/site 上下文仍属于浏览器适配。Node 通过单独入口执行磁盘读取和输出，核心没有 React、DOM 或应用导入。

Node 入口和 CLI 的最低版本为 Node.js 22.14.0，以支持 import-only startup adapter 解析使用的 `node:module.findPackageJSON()`；React build CLI 的版本声明保持一致。仓库构建和 CI 继续使用 Node.js 24 或更新版本。

构建完成后可直接使用 Node CLI：

```sh
pnpm --filter @godot-js/project-tools build
node packages/project-tools/dist/node/cli.js check --project project.json --release /path/to/engine-release.json
node packages/project-tools/dist/node/cli.js build --project /path/to/project --release /path/to/engine-release.json --output work/game.pck
node packages/project-tools/dist/node/cli.js export-pck --project /path/to/project --entry src/start.ts --release /path/to/engine-release.json --output work/script.pck
```

CLI 支持 Schema 1–4 JSON 或目录，输出 PCK 及相邻 receipt/manifest。目录默认按项目主场景启动，也可显式指定普通 script 或主场景。旧 React component 文档需要匹配的可选 startup adapter；Node 图片转换需要显式 decoder，不能借用浏览器 decoder 的身份。双入口一致性要求目标、实际 SDK 字节、producer、启动适配与 pack 选项均相同。

“新建引擎项目”和“新建 React 项目”均使用显式 Schema 4 入口；后者由 `newEngineReactProject()` 生成，从 `src/start.ts` 挂载 `App.tsx`。兼容的 `defaultProject()` native/component 模板、内置示例和存量项目保留 Schema 3 及原始导出；Schema 4 编辑视图写回自己的格式，不进行存量批量迁移。旧 React CLI/NativePort 和独立 conformance workbench 继续保留，不是默认 Playground 的另一种运行后端。

## 验证命令与证明范围

资源 R0 原型和真实浏览器解码可手动复现（不在默认测试中注册）：`pnpm --filter @godot-js/project-tools build && node scripts/test/resource-format-probe.mjs --out work/resource-format-probe`。需要 GodotJS 4.6.1 host（默认 `tests/bin/godot-host-qjs`，可用 `--godot` 指定）及已安装的 Playground Playwright/Chromium（可用 `--chromium` 指定）；`--mode browser` 或 `--mode ctex` 可单独运行。脚本生成 2K PNG，使用真实 Worker `createImageBitmap`/`OffscreenCanvas` 转换并校验全部白色 RGBA 数据，再独立生成 PNG-only、无 mipmap 的标准 CTEX v1，通过实际 headless PCK 的原路径 remap 加载并检查类型、尺寸和缓存；输出 JSON、CTEX、PCK 与日志。CTEX 返回 `CompressedTexture2D`，与当前 `ImageTexture` 不同；实验不启用生产 converter，不证明 editor reimport/export 或 Godot Web/GPU 路径。生产 Base64 的 2K PCK、UID、PCM 数据加载另由 `packages/project-tools/test/resource-converters.test.mjs` 覆盖。

以下命令用于复现相应检查；实际通过范围以该次退出码和报告为准，不因列出命令就视为全部目标已通过。

```sh
pnpm build:engine-js
pnpm build:packages
pnpm test:engine
pnpm test:react
pnpm test:browser:unit
pnpm test:playground
```

`runtime-host`/`lifecycle-gate` 单元覆盖取消、异步启动/清理和封结；React execution 检查自动帧合并、同帧新工作和实际释放记账；project-tools 检查字节别名、Base64、精确 MD5、预算和编译入口。原生 headless 资源用例加载实际生成的 PCK，能验证资源类型、数据、UID 与 remap，不证明 Web GPU/音频路径。

匹配 Web 构建后，owner-realm 原生退出探针使用：

```sh
node scripts/test/browser-web-lifecycle.mjs --engine-report /path/to/matching-engine-report.json --out work/web-lifecycle
```

该探针与默认 Dedicated Worker 产品整站验收分别记录。源码补丁测试、Node factory 测试、单模板 owner-realm 运行均不能替代一套匹配站点的 Dedicated/pthread 交互、停止重启和音频/呈现检查。WebKit 的已知限制、真实设备和生产部署继续按各自证据范围记录；本轮没有发布或默认切换。


实际产品验收使用完整匹配站点，而不是直接加载测试引擎：

```sh
PLAYGROUND_TEST_DIRECTORY=/path/to/matching-site node apps/playground/scripts/browser-runtime-host-test.mjs
PLAYGROUND_TEST_DIRECTORY=/path/to/matching-dedicated-site node apps/playground/scripts/browser-schema4-flow-test.mjs
PLAYGROUND_TEST_DIRECTORY=/path/to/full-engine-site node apps/playground/scripts/browser-resource-converters-test.mjs
```

RuntimeHost 脚本支持 Dedicated Worker 和 pthread，覆盖真实新建 React 按钮、启动失败恢复、pending startup 的 late cleanup，以及完整关闭后的重启。Schema 4 脚本验证逐键编辑、导出、重载与版本化恢复。资源脚本要求 full-engine profile（包含 GLTF），同时验证 2K PNG 经真实浏览器 producer、共享编译和 PCK 后，在 native Worker 按原路径/UID 加载为 `ImageTexture`，并通过 image API 读回尺寸和采样像素；这不等于 framebuffer 绘制或截图验收。Godot Web Worker 自带兼容 `document` 的桥接对象，因此执行 realm 通过实际 `WorkerGlobalScope` 身份判断。
