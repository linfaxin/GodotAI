# React 执行层：自动帧维护与关闭确认

本文记录 `@godot-js/react/engine` 已实现的执行层行为。实现位于
[`engine.ts`](../../scripts/jsb.react/src/engine.ts)、
[`engine-native.ts`](../../scripts/jsb.react/src/engine-native.ts) 和私有 scheduler host；
针对性回归位于
[`engine-execution.test.cjs`](../../scripts/jsb.react/tests/engine-execution.test.cjs)。

本轮覆盖自动维护合并、同帧新增工作、入口清理接入和原生释放确认。原生退出前屏障、Web 宿主资源回收由 engine/runtime 和浏览器后端负责；本文中的 `close()` 不自行驱动 Godot 主循环或强制终止 Worker。

## 驱动入口

| API | 语义 |
| --- | --- |
| `root.process(delta)` | 手动推进共享工作，然后仅调用本 root 的 process 订阅；重复调用保留原语义 |
| `root.physics(delta)` | 仅调用本 root 的 physics 订阅，保留物理阶段结构提交限制 |
| `root.processFrame(delta, token?)` | 原生自动驱动入口；共享维护可合并，本 root 每个 token 最多分发一次 process 回调 |
| `root.physicsFrame(delta, token?)` | 按物理计数分发本 root；同一显示帧的多个物理步分别执行 |
| `root.flush()` / `root.pump()` | 显式推进，不按帧号提前返回 |
| `session.drainClose()` | 推进共享 React 工作和关闭记录，不调用 process/physics 订阅 |

自动 token 为 `{epoch, counter}`，process 和 physics 分别记录。未传 token 时，适配器读取 Godot 的 `get_process_frames()` / `get_physics_frames()`；缺少该 API 的注入宿主保留手动推进语义。默认域来自宿主 session 或本地 EngineSession；显式宿主可传自己的 epoch。已经封结的 root 不能跨 native epoch 复用。

自动模式不把一个 root 的 `_process()` 扩大为所有 root 的业务回调。各 root 的 delta、暂停状态和 process_mode 继续由原生驱动者决定。重复自动 token 仍可推进新 React 工作，但不会重复派发本 root 的帧回调。手动调用不被自动去重吞掉。

产品 bootstrap 使用 `autoProcess:false`，由挂载节点自己的 `_process/_physics_process` 控制是否驱动。`autoProcess:true` 保留已有的 SceneTree 帧信号适配；renderer 不额外推导挂载节点的 process_mode，也不会因为另一个 root 收到帧而唤醒它。

## 同帧工作与审计

共享维护观察以下变化：root 注册及关闭、显式 render、事件、renderer microtask/timer、scheduler 入队版本和已经到期的 scheduler timer。同一 token 只有在没有新工作时才复用已完成的维护；由于阶段权限或重入限制未能执行的 pump 不写入“已维护”缓存。

一个自动帧内的维护共享工作预算。显式 pump、scheduler 唤醒和关闭推进有独立的推进机会；这不是对任意项目 JS 的 CPU 上限或浏览器帧率保证。

目前保留外部原生结构审计：每个新的 process token 重新检查；每轮 pump 和原生 commit 入口执行完整检查，覆盖 React render 阶段直接调用原生 API 的情况。逐节点更新和写入检查当前目标，不再为每个属性遍历整棵 ownership island；写入仍重新核对目标及祖先的身份和父级，因此前一个 setter 转移目标、祖先或后续写入的兄弟节点时，不能继续向新所有者写入。移除前检查涉及的父子节点，释放前仍执行完整审计并再次核对原生身份和父子关系。带业务帧回调的 root 在回调前执行新鲜检查，回调后使共享维护版本失效，因为回调可以直接调用原生 API。

`child_order_changed`、`tree_exiting` 和 `tree_exited` 不覆盖 detached 叶子 free 或 detached mount 换父，因此没有以这些信号取代生产审计。信号退出树、解除父级和实际销毁不是同一个事实。

S0 反例可以用真实原生引擎手动复现：

```sh
node scripts/test/react-structure-notifications.mjs
node scripts/test/react-structure-notifications.mjs --godot /path/to/godot
GODOT=/path/to/godot node scripts/test/react-structure-notifications.mjs
```

默认使用 `tests/bin/godot-host-qjs`。每次运行在 `work/react-structure-notifications/native-*` 中生成独立项目、原始输出和 `report.json`；`--out DIR` 可以指定这些运行目录的父目录。探针检查实际销毁和实际换父已经发生，同时所观察节点的三个信号计数仍全为零。`passed` 表示确认这两个覆盖缺口，结论仍是保留外部审计；它不表示通知覆盖验收通过。

无 React 更新、无业务帧订阅时，总计 1000 个节点的 fixture 在 1、5、10 个 roots 下，每个新 token 都是 2000 次 `get_children` 调用；相同 token 重复空闲维护为 0。这个结果是调用次数检查，不是实际浏览器帧率测量。

同一父节点下 500 个子节点批量修改 text 的回归也检查调用次数：当前 fixture 为 5010 次 `get_children`，不再是逐属性重复扫描整棵子树的 505009 次。50、100、500 节点用例共同约束该场景的线性读取开销；render 和 setter 内转移节点的用例继续验证所有权保护。

## 关闭与释放记录

`requestShutdown()` 同步登记关闭，适合 session 先向全部入口和 roots 广播。`shutdown()` 保留既有调用方式。`close()` 返回同一个可等待结果，区分以下阶段：

```text
请求关闭 → React 卸载 → 释放已提交 → 原生销毁已确认
```

root 的 `getStats().state === 'disposed'` 仍表示逻辑卸载完成。此时 native `queue_free()` 可能尚未消费；EngineSession 继续持有待释放 root，直到实际确认或 epoch 封结。待释放记录未清空前，也不能为同一 Godot 世界改用另一个 EngineSession。

```ts
interface EngineCloseResult {
  status: 'complete' | 'failed' | 'unconfirmed';
  pendingReleases: number;
}

interface EngineCloseProgress {
  status: 'open' | 'pending' | EngineCloseResult['status'];
  logicalDisposed: boolean;
  pendingReleases: number;
}
```

`pendingReleases` 是已经提交但尚未确认的释放请求数；单独为零不代表整个关闭成功。调用方检查 `status`。effect cleanup 或原生释放失败不能得到 `complete`，也不会重试结果不确定的 free。

原生提供 `instance_from_id` 时，确认使用原 ObjectID 查询；旧 JS wrapper 失效而原生对象仍存在时继续等待。兼容的注入宿主使用严格布尔型 liveness 结果和实例身份。查询抛错、不可用或返回未知值都保持未确认，不能解释为对象已经销毁。

`sealClose()` 用于原生 epoch 已封结或宿主已经放弃协作清理的观察路径。它不再调用原生对象；已有完成结果保持不变，未完成结果记为 `unconfirmed` 或已有失败。它不是释放节点的方法。

`session.drainClose()` 需要与实际原生删除队列的消费交替进行。没有正常帧时，应由退出准备阶段的原生机制消费删除队列，然后再次推进确认。等待 `close()` 本身不会消费 Godot 删除队列。现有 microtask、物理阶段和 native callback 深度保护继续保留，显式 drain 不授予额外释放权限。

## 与项目入口自动关联

生成的 React bootstrap 和普通脚本都可以使用同一入口宿主：

```ts
const root = createRoot(ctx.mount, {
  runtimeHost: ctx.host,
  lifetime: ctx.lifetime,
  autoProcess: false,
});
```

当前 realm 存在匹配的 RuntimeBinding 能力时，renderer 使用 `attachEntryCleanup` 关联四个动作：

| 入口动作 | React 行为 |
| --- | --- |
| beginClose | `root.requestShutdown()` |
| cleanup tick | `root.session.drainClose()` |
| native seal | `root.sealClose()` |
| cleanup | 等待 `root.close()`，非 complete 结果作为入口清理失败报告 |

绑定成功后 `root.runtimeManagedCleanup` 为 true，bootstrap 据此避免重复登记资源清理。只有当前 binding 创建的 active entry public host 可用于关联；复制、foreign、session-global 或已关闭 host 会被拒绝。

实际原生释放确认后，成功关闭的 root 通过内部 `detachEntryCleanup()` 退役自己的登记，解除 cancel/tick/seal 回调及其强引用。入口仍可创建后续 roots；128 项预算约束当前拥有的清理任务。已注销的 `lifetime.defer()` 登记也回收槽位。已经开始的异步清理在 Promise 结束前继续记账，退役不能提前把它标为完成；失败仍保留在入口摘要中。

取消的 lifetime 或当前 realm 已不接收业务的 binding，在创建 root 前拒绝准入。单个 entry 关闭不封死另一个 active entry。没有浏览器 binding 的 native/独立宿主仍可显式驱动和关闭 root。

取消是协作机制。关闭推进不会派发普通帧订阅，但共享 React scheduler 仍可能运行 reconciliation、passive effect 和用户 cleanup；不能由此承诺任意 Promise 都已经停止。

## 验证范围

M1 执行层要求对应以下检查：

| 要求 | 实现与回归 |
| --- | --- |
| 多 root 空闲维护不倍增 | 同一 native token 的共享维护与 1000 节点 1/5/10 roots 调用计数 |
| 同帧新工作不丢 | render、setState、到期 timer、阶段恢复的专项用例 |
| 保留 root 驱动语义 | 各 root delta、未驱动 root、process/physics 分离、手动调用和新 epoch |
| 外部原生变化仍被检查 | 逐帧审计、回调与操作前新鲜检查，保留 detached/portal 边界保护 |
| 关闭确认等待原生身份消失 | session 待释放记录、ObjectDB 查询、查询失败不算销毁、session 替换保护 |
| 普通脚本自动参与关闭 | scoped host 的 close/tick/seal 关联，拒绝 foreign/closed host，不影响其他 active entry |
| 封结后不再进入原生 | seal 后进度、统计、帧入口和迟到错误的查询防线 |

包内检查使用：

```sh
pnpm --filter @godot-js/react test
```

回归覆盖多 root 维护计数、同 token render/setState/timer、各 root delta、暂停的 root、多次物理步、阶段暂时不可用、raw native 结构变动、实际释放等待、session 所有权、失败和封结后的行为，以及真实 RuntimeBinding 与 renderer 的入口清理关联。

额外的 QuickJS headless PCK 探针已验证真实 Engine frame counter 的重复驱动去重，以及逻辑卸载后等待原生删除队列消费的关闭结果。该 profile 使用 dummy 渲染/音频/物理；Web 图形呈现、浏览器音频、pthread 和原生退出前屏障须由对应后端的实际引擎验收提供证据。
