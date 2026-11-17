# 引擎执行与构建主链：本轮实现

本轮保留完整 Godot、默认 Dedicated Worker，以及同一 engine realm 内的 GodotJS 和可选 React。主链统一为原生 World/claim、显式 Entry、直接 engine renderer、共享编译与二进制资源，再接单 PCK 或独立 ArtifactSet。pthread 仍是显式候选。本轮源码和 CI 配置不等于已发布站点、npm 包或新的默认执行后端。

## 原生 World 与能力边界

`bridge/jsb_native_world.{h,cpp}` 实现 `NativeWorld`，通过内部 `godot-jsb.internal.native_runtime` 提供 WorldAPI 边界。WorldAPI 是架构称呼，不是新增公共模块。World 保存原生 ObjectID、environment、claim 和有界变更记录，不保存 React 树、JS 回调或对象所有权裸指针。

以下三种关系分别校验：

| 关系 | 负责的事实 |
| --- | --- |
| 原生 generic claim | 哪个 world/environment/scope 可管理对象生命周期 |
| Godot `Node.owner` | 场景归属与原生序列化关系 |
| typed component property writer | 哪个生产者可在帧阶段写指定属性 |

`NativeWorld`、`ResourceScopes`、`EngineRunLease` 共用 `native_capability_token()` 生成原生不透明 token。接收方在自己的 registry 内解析并校验 world、environment、scope 和 live claim。伪造同名字段的 JS 对象、其它 registry 的 token、关闭或过期 scope 都不能获得权限；token 耗尽后拒绝继续分配。

跨线程资源转移由消息中的 `Variant` 持有运输引用；发送端解绑后归还自己的 wrapper 引用，接收端只获取自己的绑定引用。未消费、取消和拒收均通过同一 RAII 释放消息。Web 先完成克隆预检，再整批校验和提交发送端解绑，最后发布消息，避免接收线程先绑定后又被发送端解绑。

Environment 处置时在 owner 线程移出自身原生 Variant 的内容并置空原 cell，在锁外释放资源引用；cell 存储留给 VM 的最终回调回收。共享数组、字典的内容不被清空，其它 realm 的独立 cell 保持有效。V8 使用 private 字段保留 backing store，不能通过公开属性删除或替换它而提前释放原生 cell；关闭后的 typed 访问明确拒绝。

全局 Environment 注册表只保存 weak owner，并在共享所有者已建立后的 `init()` 阶段发布环境。枚举和查找只提升有效 weak reference，不从构造中或析构中的裸指针调用 `shared_from_this()`。线程筛选与强引用快照释放发生在注册表锁外，避免最后引用释放导致处置重入同一把锁。

Web 在所属 realm 的明确关停安全点释放物理 VM，实际 HandleScope 必须已经退出。延寿的 C++ Environment 快照和 Global 只保留关闭后的 C++ 墓碑；迟到的句柄读取、重置或最后释放不再调用当前 realm 的 `rt0`。因此跨线程最后释放快照不会改变物理 VM 的释放线程。普通 native 构建保留原有析构兜底，未把这个 Web 修复扩展成新的跨平台回收器。

Web 后台资源加载只复用同一线程仍在借用的 Shadow 环境；最后一次借用结束且 VM scope 退出后，在该线程释放环境。Shadow 实例转换为正式脚本实例时保留完整已加载属性，先运行构造，再恢复序列化值并建立属性缓存，包含脚本导出值和原生资源属性。真实 threaded resource 探针验证两个独立脚本的后台加载、状态保持与完整退出；单线程构建的同步回落不作为跨线程释放证明。

SCons 默认 `enable_legacy_react=no`。直接 engine renderer 使用通用 claim 和观察接口；旧原生 React ownership 管线仅供显式兼容构建，同一 World 不允许混用两种 renderer 模式。普通 Godot 脚本继续使用完整引擎 API，React 作为同 realm 的可选调用方，不产生另一套原生世界。

## 原生观察、退役与安全点

锁定 Godot 4.6.1 的 Node mutation hook 发布结构变更；ObjectDB removal hook 在释放锁后发布真实身份退役。hook 只写原生事实，不调用 JS。renderer 在匹配 observer ABI 的构建上按脏记录审计；稳定空闲树不再逐帧遍历全部记录和子节点。首次验证、观察队列 overflow、缺少 observer 能力或祖先关系不确定时仍执行完整审计。

释放批次包含完整节点描述、子关系和最上层删除 frontier。owner checkpoint 先验证整个批次及观察修订，成功后才将 claim 转为 retiring 并提交 frontier 删除；无效批次不会部分改 claim 或部分入删除队列。后代由原生级联销毁，ObjectDB tombstone 确认每个身份的最终退役。

`native-owned-opaque` 只允许省略未认领的原生内部结构，不授予其他 scope 的销毁权限。提交释放时遍历实际级联子树（包含 internal children），在同一原生校验中拒绝其他 scope 的 claim，以及本 scope 尚未纳入完整批次的后代。遍历只发生在释放安全点，并受节点预算约束；重叠 frontier 或任一不确定后代使整批拒绝。

`queue_free()` 只证明已接受请求。root 逻辑 disposed 后仍保留待退役记录，直到真实身份消失才能返回 `complete`。失去安全所有权的记录进入隔离/未确认状态；关闭 scope 不会把仍存活 claim 当作释放成功。native epoch 封结后停止原生读取，也不通过访问已销毁对象补证。

结构提交和销毁分别检查原生阶段。销毁需要 owner realm 发放的 checkpoint ticket；嵌套进入 native signal/回调时暂时失去权限，返回 owner checkpoint 后恢复。ticket 在回调返回时结束，后续 Promise continuation 不能继承其销毁权限。physics 和 mutation/interop 期间拒绝危险操作。

## 显式入口与 RuntimeBinding

普通 Schema 4 脚本导出 `start(ctx)`，上下文包含 `mount`、`godot`、捕获的 `host`、`lifetime` 和显式 `entry` capability。浏览器后端在项目模块加载前安装纯 `createRuntimeBinding()`；生成的原生 bootstrap 嵌入相同核心，再与原生 cleanup hook 对接，不依赖浏览器 ESM 包。

```ts
export function start(ctx) {
  const root = createRoot(ctx.mount, {entry: ctx.entry});
  ctx.lifetime.defer(async () => {
    const result = await root.close();
    if (result.status !== 'complete') throw Error(result.status);
  });
  root.render(React.createElement(App));
}
```

root 使用捕获的 Entry capability 登记清理，不能从“当前 entry”猜测权限。capability 在原 runtime registry 中验证自身 receiver 和 host；跨入口、伪造或被撤销的 capability 被拒绝。旧 `runtimeHost`/`lifetime` 接入仍有兼容适配，默认新 bootstrap 传递显式 `ctx.entry`。

`EntryLifetime` 提供无 DOM 类型的 `cancelled`、`onCancel()`、`defer()`。应在异步启动第一次 `await` 前登记已拥有资源的清理。取消是协作式通知，不会中止任意 Promise。`defer()` 返回仅移除本项的注销函数；关闭后不接受新的普通登记。注销和已完成清理会回收额度与回调引用，已经开始的异步 close 在 Promise 完成前仍计入待清理任务。

`start()` 可返回 Promise，最终返回 `void` 或清理函数。bootstrap 使用 `finishStartup()` 跟踪结果。关闭先撤销业务命令/事件，再广播取消，按逆序执行并等待清理。未完成启动、清理失败、迟到结果和 epoch 封结分别保留事实，不会因其他任务结束而被改成成功。

公共 `RuntimeHost` 仍为 `apiVersion: 1` 的诊断、项目事件和命令接口；内部 binding 的 `beginClose()`、`drainClose()`、`closeProgress()` 负责关闭。命令回执表示同步分发，不表示返回 Promise 的异步命令完成。`SessionFacts` 分别记录入口清理、epoch、原生退出和宿主回收，迟到的 exit code 0 不会覆盖 fatal、强停或未确认状态。

原生 bootstrap 将首次 fatal 输出到原生日志，并在退出门控中独立于入口清理状态投影为非零退出码。启动或项目命令失败后，即使清理完整且项目调用 `quit(0)`，进程仍以失败结束；清理流程继续等待已登记任务。

## 原生与 Web 退出门控

匹配 native QJS/V8 构建通过 `Main::iteration()` 和 SceneTree hook 在 owner loop 推进退出。QJS 使用可限额的 job 执行，V8 使用有界 owner pump 和终止机制；cleanup deadline 同时覆盖不断补充的 job 与单个不返回任务。JavaScriptCore 没有经过认证的公共有界 job-pump API，目前 native `lifecycleAbi` 和 `checkpointAbi` 均为 0，不承诺相同异步退出能力，也不运行该认证探针。

匹配 Web 构建的 `execution.lifecycleAbi: 1` 来自实际执行模型对应的 Web/SceneTree patch 链。Dedicated runtime ABI 的 lifecycle 字段、pthread `_godotjs_release_exit` 导出、原生 observer 和宿主资源 ABI 均需匹配。普通 Node factory 测试或给旧 descriptor 增加字段，不能替代匹配引擎重编译。

Stop 和项目 `quit()` 的共同顺序为：

```text
撤销业务服务、关闭入口
  -> 取消启动并推进已登记异步清理
  -> owner cleanup checkpoint 提交释放 frontier
  -> 返回原生后消费删除队列
  -> 后续 tick 确认真实退役并放行退出
  -> 原生 cleanup、epoch 封结、宿主资源回收
```

cleanup-only 阶段不执行 SceneTree process/physics，也不刷新通用延迟业务队列。managed-shutdown queue hook 还在最终清理阶段抑制业务 deferred/callable 调用，单独记录 `shutdownQueueAbi: 1`。关闭中只能推进清理工作；挂起任务保留有期限的强停与失败/未确认结果。

已登记清理仍可使用其需要的音频/浏览器服务，服务终结遵循原生退出顺序。音频和 DOM drain 保留独立、有上限的释放额度，普通业务队列满时仍能发送 stop/unregister 等释放命令。只有匹配 epoch/序号的 ACK 归还额度，重复、过期或其他 run 的回执不能扩大预算。宿主及时静音、撤销业务输入并最终回收 Worker、音频、端口、Blob URL 和 loader 资源。

pthread 的原生父 Worker 必须保留 child，直到 child 在自己的 owner thread 完成 environment 及后代释放；join 期间不持有 registry、ObjectDB 或 language 锁。浏览器 epoch summary 的观察期限不能代替该原生 child lifetime barrier。子任务无法协作结束时，保留强停/未确认事实，不把 pool 回收当作业务清理成功。

`root.shutdown()` 保持 `void`，`root.close()` 返回幂等 Promise 及 `complete`、`failed`、`unconfirmed`。`getCloseProgress()` 区分逻辑 disposed 和实际待退役数。`processFrame()`/`physicsFrame()` 按 epoch、原生帧计数及工作/scheduler 修订共享维护预算；显式 `process()`、`physics()`、`pump()`、`flush()` 保持手动语义。

启动报告的业务节点数使用独立的 `publishedRecords` 集合；`liveRecords` 继续包含尚未确认销毁的原生记录。退役会立即撤销业务发布，但不会提前伪造原生销毁。manifest 中的模板资源经过同一资产服务加载，再在资源作用域中重映射，因此请求、就绪和失败统计也覆盖模板。

## EngineHostOperations、NativeInterface 与资源作用域

`EngineHostOperations` 将直接 renderer 的属性、命令和信号适配迁入独立原生服务，每次调用复核 scope 和 live claim。菜单、文本、布局、音频 bus 等操作遵循相同边界；scope 关闭后撤销操作和 scoped audio 注册。typed signal 将 shape、navigation、节点参数转换为快照、受校验 handle 或明确的 unmanaged-node 描述，不泄露任意原生字段。

生成的 NativeInterface Script 保持原生 `_ready`、process、physics、input 和 RPC 元数据，通过 engine-renderer registry 调用最新 handler。直接 `EngineNode` 和 typed components 均接同一实现；local RPC callback/DTO 通过不等于 ENet 双端传输或 exporter 通过。完整传输由 `tests/react_native_interfaces/run.mjs` 单独验证 source/development 和正式导出 PCK 的 server/client，检查 authority、错误路径、未协商 channel、sender、reconnect 和 latest handler，并绑定 native certificate 与 SDK 身份。

`ResourceScopes` 在 detached template root 上克隆 `resource_local_to_scene` 图，保留同一实例内部别名、跨实例隔离、Godot `owner` 与 `get_local_scene()` 身份。通用 Resource 子类按原生资源图处理，不由 renderer 类型白名单决定。Script Resource 图需要显式契约；physics 阶段拒绝分配本地资源 scope。模板重置仅退役旧实例，稳定 sibling 和原始共享资源保持各自身份。

托管 CLI bootstrap 使用 `EngineRunLease` 校验 attachment、入口实例和构建 generation。root 关闭保留独立原生 sibling；managed island 混入无 claim 子节点时保留并隔离该岛，不能擅自级联销毁未知对象。preview、watch 和导出使用同一 startup/关闭事实。

## 增量编译与字节所有权

`project-tools` 的 source snapshot 和 output overlay 拥有 `Uint8Array` 字节。外部输入在第一个 `await` 前捕获；公开读取返回副本，可信内部阶段复用已拥有字节。项目 JSON 的 `number[]` 留在导入/导出边界，不能通过 `.buffer` 或子视图修改已记录源和输出身份。

`ProjectWorkspace` 为每次构建 pin 不可变 revision，`captureChanges()` 接 changed/removed delta 并复用未变源文件。过期构建不能发布覆盖当前编辑 revision。Playground 的 source sync 发送变化，完成/悬停请求不会重新分配未变二进制数组。`ProjectLanguageService` 保留未变 script snapshot，在声明或模块路由变化时更新解析身份。

有界 LRU `ProjectBuildCache` 复用 emit、文本编码及已验证 resource PCK；owned-byte SHA 缓存复用已拥有字节的身份。执行缓存不参与构建身份，命中和冷构建须输出相同字节/收据。resource execution cache 在复用前校验 producer、目标、参数、源/依赖和输出身份，浏览器 IndexedDB 与 Node 目录适配共享契约。

资源 registry 的执行凭证另有条数与字节双重上限，默认最多 512 条、64 KiB，只保留收据的 SHA-256 摘要。淘汰或零预算不放宽可信性：后续请求需要重新执行转换，或命中完整验证后的可信输出缓存。长期复用 registry 不保留所有历史收据全文。

Node 准备与编译入口同步捕获配置、launch 数据、取消信号及服务引用，并在调用时正规化路径。输出 ticket 和实际发布使用同一个已捕获目标；调用方后续修改 options、工作目录或 signal 属性不会转移旧任务的发布权限。原 AbortSignal 的取消仍然生效。

`godotjs-engine-compiler/1` 同时派生类型检查和 CommonJS emit 设置。`createCompilerEnvironment()` 将实际声明、模块路由、runtime/vendor 字节、TypeScript/policy 和目标纳入身份。`compileBuildPlan()` 统一准备、overlay、pack 和收据；`compileProject()` 在同一 snapshot 上先检查类型。核心不导入 React、DOM 或 Playground，Node 和浏览器仅提供环境适配。

## 默认二进制资源

| 输入/recipe | 当前输出 | 原生类型 |
| --- | --- | --- |
| PNG `godotjs/png-ctex` | Godot 4.6.1 CTEX v1，保留校验后的压缩 PNG | `CompressedTexture2D` |
| JPEG `godotjs/jpeg-ctex` | 共享软件解码、固定 PNG deflate，再写 CTEX v1 | `CompressedTexture2D` |
| PCM WAV `godotjs/wav-pcm` | Godot binary resource v6 | `AudioStreamWAV` |
| 显式 legacy `godotjs/image-rgba` | Base64 TRES | `ImageTexture` |

新目标资源 ABI 为 `godot-4.6.1-resources-v2`。PNG 支持范围、CRC/deflate 和解码预算在 producer 中校验；JPEG 默认使用锁定的 `jpeg-js 0.4.4` 与 `fflate 0.8.2` 参数，Node/浏览器共享像素与输出身份，不依赖 canvas 的默认解码差异。JPEG SOF 预算先于解码，codec 分配和像素数均有上限。PCM 保留采样格式、声道、采样率及有符号数据转换。

CTEX 已进入生产 converter，不再只是原型。`CompressedTexture2D` 与旧 `ImageTexture` 是可观察类型变化，收据包含 producer 版本及输出 extension/type/resource ABI；显式 legacy Base64 路径保留原类型语义。原始源字节、UID、remap 继续保留，旧转换输出若被保留也计入产物预算。

PCK writer 在最终分配前校验布局和总预算，目录 MD5 只覆盖精确字节视图；SHA-256 负责构建/产物身份。二进制资源减少文本放大，但不提高现有编辑器 64 文件、单二进制文件 1 MiB、源总量 8 MiB 限制，也不使任意解码图像自动符合 PCK 预算。这里使用标准 Godot loader，不实现 editor importer；普通 editor reimport/export、GPU 和实际设备结果各自记录。

## ArtifactSet 与早期挂载

单 PCK 输出继续可用。`ArtifactSet` 是独立版本化输入，包含 bootstrap PCK、按内容寻址的 resource PCK、union index、目标/launch 身份和整个集合的 ID。全局 project 配置、UID cache、global class cache 等仅属于 bootstrap。资源包不能覆盖这些路径，实际 PCK 目录中的重叠、大小写冲突、越界或 digest 不符都会被拒绝。

普通 PCK reader 直接解析目录、范围和 entry MD5；ArtifactSet 校验实际包字节与目录，不信任清单宣称的文件列表。外部 admission 在第一次异步操作前捕获整个输入，再验证 closure、SHA 和 union；transfer 只转移本次运行拥有的副本，不转移 compiler/cache 的 backing buffer。

两种构建变体都通过独立的构建元数据返回 `sourceHash`、`importReceipts` 和 `outputOverlay`。Node sidecar 与浏览器 Worker 消费同一生成函数；编辑器原子合并校验后的收据，并保留原始源文件与原始导入文档。ArtifactSet 保持自己的集合身份，不伪造单包 SHA，也不把外层收据塞回集合产生身份循环。

匹配原生集成在 `Main::setup()` 的 UID、autoload、主场景解析之前完成资源包挂载。因此 bootstrap 的 autoload 和 UID 主场景可直接使用 resource PCK。仅把多个 PCK 写入磁盘或浏览器 staging 不代表早期挂载生效；旧 engine 必须拒绝声称支持的新能力。ArtifactSet 的封闭性与已挂载结果分别有测试和实际探针。

## IndexedDB blob 存储

项目存储使用独立 blob namespace，将文件内容按 hash 去重，project/recovery 记录仅保存内部引用。外部项目 JSON 无权伪造数据库 blob 引用。写入在异步 hash 前捕获源数据，project、blob 与 journal 按事务落盘；失败时保留待保存编辑，跨 tab 冲突检测继续有效。

旧数据库复制到新布局时保留原库、migration journal 和一次性通知。旧页面迟到写入保留为可恢复分支，不覆盖新布局当前项目。读取与导出在同一只读事务内捕获记录和全部 blob 字节；构建任务的持久 pin 保护跨 tab 仍使用的字节。collection 仅清除没有 project/recovery/pin 引用的内容，未知 pin 形状会阻止不确定回收。recovery 导出携带自包含字节，导入先保存独立恢复记录，由已有 restore 流程激活。

restore 在提交前保留规范化后的完整项目快照，返回结果不依赖提交后的 blob 读取。数据库提交和界面切换分别确认：`canApply()` 检查编辑修订与恢复请求序号，界面在最后一次异步读取完成后同步检查它。恢复期间的新编辑、项目切换或更新的恢复请求会撤销旧结果；保存新编辑也不会让旧结果重新有效。

拒绝访问 IndexedDB、可识别的持久化故障或配额耗尽时，已拥有的内存项目仍能编辑、检查、编译、运行和导出；持久化 pin 的写入或释放失败不覆盖已经成功的编译结果。保存仍明确显示失败，迁移失败也不删除旧库或把导入文档宣称为已保存。编码、项目校验和普通逻辑错误继续失败，不被降级路径吞掉。实际产品故障注入覆盖启动拒绝、运行后配额不足和迁移期间配额不足。

## 构建与 CI 边界

原生 Linux、Windows、macOS、Android、iOS workflow 在请求版本恰为 4.6.1 时，先安装 Node.js 24，再执行：

```sh
node modules/GodotJS/scripts/test/prepare-native-engine.mjs --godot-source . --out native-integration.json
```

这些 job 的根目录是 Godot checkout，GodotJS 在 `modules/GodotJS`；本地 `./.github/actions/godot-build` 等 action 来自上游 Godot checkout。prepare 脚本没有 npm 依赖，先验证全部锁定源码再写入 observer、native lifecycle、early mount、managed shutdown queue 补丁并生成 proof。不支持的源码拒绝应用，其它 Godot 版本不被标成 ABI 1。原生构建显式使用 `enable_legacy_react=no`，报告单独上传。

本地原生 producer 的源码指纹覆盖实际使用的 `.inc`、嵌套 `SCsub`、根头文件、代码模板和嵌入预置脚本，并绑定最终 Godot 核心补丁及构建配方；派生的 `.gen.h/.gen.cpp` 不作为源输入。验收在首尾检查源码指纹、构建报告和实际二进制 SHA-256，不能用 Git commit 或报告生成时间替代。

完整原生构建身份还独立绑定当前 backend、平台和架构实际使用的第三方 include 目录与静态库清单，以及选用的编译、链接、归档、SCons 和 Python 工具身份；构建前后重新检查这些输入。旧报告可以保留普通模块源码身份，但标记为 `legacy-unattested`，不能作为依赖完整冻结的证明。工具身份记录不等于完整操作系统、系统库或编译器运行时支持文件的可复现性认证。

`build-browser-engine.mjs` 自行执行完整、按 execution model 选择的 Web patch 链。Browser Playground 的 Dedicated 产品和显式 pthread Worker 产品均使用自己的匹配 build report；通用 `build_web.yml` 的 browser/QJS/thread/dlink 模板矩阵不应用 Dedicated 产品补丁。同一 Web-patched 源树编出的 headless 资源导出 editor 不用来认证 native lifecycle ABI 1。

新 CI 定义把以下实际探针接入 matching 4.6.1 Linux QJS/V8 runtime artifact；JavaScriptCore 保留普通 runtime 测试，排除异步原生退出认证。下面是模块根目录的复现方式，路径须指向已应用对应补丁的真实 engine：

```sh
pnpm build
node scripts/test/native-cleanup-probe.mjs --godot /path/to/godot --out work/probes/cleanup
node scripts/test/native-retirement-probe.mjs --godot /path/to/godot --out work/probes/retirement
node scripts/test/engine-entry-native.mjs --godot /path/to/godot --out work/probes/entry --require-no-legacy
node scripts/test/engine-template-native.mjs --godot /path/to/godot --out work/probes/template
node scripts/test/engine-native-interface-probe.mjs --godot /path/to/godot --out work/probes/interfaces --typed
node scripts/test/engine-host-operations-probe.mjs --godot /path/to/godot --out work/probes/host-operations --audio --signals
node scripts/test/artifact-set-native.mjs --godot /path/to/godot --out work/probes/artifact-set
```

matching Web 产品的 owner-realm checkpoint 与 lifecycle 探针也已接入各自 workflow：

```sh
node scripts/test/native-web-checkpoint-probe.mjs --report /path/to/matching-engine-report.json --out work/probes/web-checkpoint
BROWSER_EXECUTABLE=/path/to/chromium node scripts/test/browser-web-lifecycle.mjs --engine-report /path/to/matching-engine-report.json --out work/probes/web-lifecycle
node scripts/test/native-web-checkpoint-probe.mjs --report /path/to/matching-pthread-report.json --out work/probes/child-lifetime --child-barrier --cleanup-jobs 18000000
```

包级验证使用 `pnpm test:engine`、`pnpm test:react`、`pnpm test:browser:unit`、`pnpm test:playground`。真实 IndexedDB blob migration/conflict/pin/recovery 脚本加入 browser shell job；二进制资源的 Node/浏览器 producer parity、跨 Worker cache 及 native PCK load 由 `runBinaryResourceProbe()` 单独记录。

CI 配置完成只表示已接入检查，不表示这些远端 job 已执行或通过。每次认证以该次退出码、二进制/模板 hash 和上传报告为准。源码补丁或单模板 owner-realm 探针不能替代整套 matching 站点的 Dedicated/pthread 交互、停止重启、音频和呈现验收；WebKit 既有限制、真实设备和生产部署继续按各自证据范围记录。

Node CLI 最低版本为 22.14.0，仓库构建/CI 使用 Node.js 24。Schema 1–4 JSON 和目录均可读取，普通 script/main scene 及可选 React startup adapter 共享准备主链：

```sh
node packages/project-tools/dist/node/cli.js check --project project.json --release /path/to/engine-release.json
node packages/project-tools/dist/node/cli.js build --project /path/to/project --release /path/to/engine-release.json --output work/game.pck
node packages/project-tools/dist/node/cli.js build --project /path/to/project --release /path/to/engine-release.json --artifact-set work/game-set --resource-cache work/resource-cache
```

新建 engine/React 项目使用显式 Schema 4 Entry；存量 Schema 3、旧导出和兼容入口不批量迁移。独立 NativePort/conformance workbench 留在兼容验证范围，不作为默认 Playground 的另一种执行后端。
