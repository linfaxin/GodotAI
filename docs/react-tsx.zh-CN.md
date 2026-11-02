# React / TSX 使用指南

`@godot-js/react` 是 GodotJS 的 React renderer，`@godot-js/react-build` 负责 TSX 编译、模板导入、代际发布和 PCK 导出。TSX 位于现有 TypeScript 和 Godot 场景资源机制之上，使用真实的 React 和 react-reconciler。

业务代码只编写 React 组件。一份应用入口建立一个 React Root，普通组件组合就能表达多个场景。提交后的 React host graph 决定全部业务 Node 的存在、父子关系和顺序；生成的 TSCN 只承载启动脚本、代际票据与资源依赖。

## 1. 从源码使用

需要含 React native bridge 的 GodotJS 构建，以及本仓库的 pnpm workspace。仓库构建和测试使用 Node.js 24；发布包的 CLI 支持 Node.js 22 及以上。现有不启用 React 的 TS 项目仍走原来的编译和导出路径。

在仓库中安装并构建：

```sh
pnpm install
pnpm --filter @godot-js/react build
pnpm --filter @godot-js/react-build build
```

项目依赖 `react@19.3.1`、`@godot-js/react` 和开发依赖 `@godot-js/react-build`、`@types/react@19.3.0`。React 类型作为 SDK 的 peer dependency 声明，编译器优先从消费项目解析，不要求 SDK 内存在 workspace 开发依赖目录。这两个 SDK 包的源码分别位于 `scripts/jsb.react` 和 `scripts/jsb.react-build`。首次使用时应使用本次构建的包和对应 Godot 二进制。

在 Godot 项目根目录添加 `godot-react.config.mjs`：

```js
export default {
  godot: "/absolute/path/to/godot",
  entries: {
    app: { module: "src/App.tsx", export: "default" },
  },
  mode: "development",
};
```

`src/App.tsx`：

```tsx
import * as React from "react";
import { VBoxContainer, Label, Button } from "@godot-js/react";

export default function App() {
  const [count, setCount] = React.useState(0);
  return (
    <VBoxContainer name="App">
      <Label name="Count" text={`Count: ${count}`} />
      <Button name="Increment" text="+1"
        onPressed={() => setCount(value => value + 1)} />
    </VBoxContainer>
  );
}
```

运行：

```sh
godot-react setup
godot-react check
godot-react build
godot-react doctor
godot-react preview --entry app
```

`setup` 在 `project.godot` 中启用 `godotjs/react/enabled`，选择第一个配置入口为主场景，并安装模板类型别名。`check` 使用完整 TypeScript Program 验证组件、入口 props 和模板类型。构建生成 `generated/react/scenes/app.tscn`。安装在项目中的 CLI 也可以直接通过 `node node_modules/@godot-js/react-build/dist/cli.js` 调用。

模块依赖使用静态 import，或字面量路径的 `import("./Scene.js")` / `require("./model")`。`build` 对业务代码及其依赖中的变量路径、require 别名和计算路径加载返回 `E_DYNAMIC_MODULE`。需要运行时选择模块时，使用显式的字面量 loader 映射，例如 `{menu: () => import("./Menu.js"), battle: () => import("./Battle.js")}`，以便构建器完整打包依赖。

## 2. 多场景与状态

组件边界不增加 Godot 包装节点。只有显式写出的宿主组件产生 Node。

```tsx
function Game({ level }: { level: string }) {
  return <Level level={level} />;
}

function App() {
  const [level, setLevel] = React.useState("first");
  return (
    <SessionProvider>
      <Game key={level} level={level} />
      <HUD onNext={() => setLevel("second")} />
    </SessionProvider>
  );
}
```

相同组件类型和 key 保留 React 状态；改变 key 只重建对应子树。HUD、全局 Context 和其他兄弟场景可以继续存活。应用内切场景使用状态与组件组合，避免调用原生 `change_scene_to_*`。项目可以配置多个独立入口，但一个运行中的应用只使用一个 Root。

首版在同一 GodotJS Environment / JavaScript realm 中只允许一个活动 Root。关闭当前 Root 后可以启动新入口；并发的第二个 Root 会明确报错。场景、HUD 和 Provider 都放在这棵 React 树内。

## 3. 属性与原生命令

普通 props 持续受 React 控制；`initial` 只设置首次物化时的基线。移除受控 prop 会恢复这份初始基线。`engineOwned` 将字段及其别名交给允许的引擎行为通道；同一个字段不能同时受 React prop 和引擎命令控制。宿主存活期间不能改变这份所有权声明，需要改变时使用新的 key。

开发模式修改 `initial` 会输出 `GODOT_REACT_DIAGNOSTIC`，说明旧基线被保留以及如何通过 key 重建。框架集成可通过 Root 的 `onDiagnostic` 回调和 `getDiagnostics()` 读取结构化诊断；它与运行故障分开，不会因该提示停止应用。

`useNodeRef` 返回只读句柄，支持 `isValid()` 和受支持属性的 `read()`。它不暴露 Node、通用 `call`、`free`、`reparent` 或结构修改接口。帧 Hook 收到的 Commands 只在当前同步回调内有效；保存后使用、在 `await` 后使用或者跨 Root 使用都会被拒绝。

`useProcess`、`usePhysicsProcess`、`useInput` 和 `useNativeReady` 注册最新已提交的处理函数。未提交的 render 不会替换当前处理函数。业务结构更新由 React 调度到允许的提交阶段。物理类和命令需要显式选择相应能力 profile，不能由字符串类名绕过。

同一 Host 同时最多一个处于 active 状态且带 `writes` 的帧 Hook，其他 Hook 可以只读。ref 指向的子节点延迟挂载或独立换 key 后，框架在发布屏障重新绑定目标并校验写租约，不要求父组件额外 rerender。`useNativeReady` 的目标卸载时会先执行该目标的 cleanup；新目标原生 ready 后再执行 setup。

原生删除发生在 React 的 layout 和 passive cleanup 都完成之后。cleanup 捕获的只读句柄在必要清理窗口仍可读取尚存活对象；异步 cleanup 不会被 React 等待，异步任务需要自行取消。

Suspense 隐藏会覆盖普通 `Node` 下的可见后代和独立的 `CanvasLayer`，恢复时保留各节点原有或最新受控的可见性。隐藏本身不承诺暂停所有 Godot 物理、音频或其他引擎系统。
React 的开发态 Promise 计时使用框架私有适配，不要求宿主提供浏览器 `performance`，也不修改用户全局计时对象。

## 4. 只读 TSCN 模板与资源

在配置中声明模板后，通过专属模块导入：

```js
export default {
  godot: "/absolute/path/to/godot",
  entries: { app: "src/App.tsx" },
  templates: { panel: "templates/Panel.tscn" },
  assets: { marker: { source: "assets/marker.tres", type: "Resource" } },
};
```

```tsx
import Panel from "@project/react-templates/panel";
import { asset, useAsset } from "@godot-js/react";

function Inventory() {
  useAsset(asset("marker", "Resource"));
  return <Panel name="Inventory" />;
}
```

导入器先冻结源码和资产闭包，再用隔离的最小 Godot 项目检查模板。该项目不装载作者项目的 autoload、编辑器插件或业务脚本。每个模板业务节点都会展开成 React host；运行时不通过黑盒 `PackedScene.instantiate()` 接管一棵额外节点树。

模板采用明确白名单。默认 `template-t0` 拒绝脚本、连接、嵌套实例、继承、占位实例、未知资源和复杂轨道。支持面外的输入返回带源码位置的诊断，不能默默忽略属性或降级实例化。

显式的 `template-structural-v1` 可以展开共享资源的嵌套场景与类型不变的继承属性覆盖。该 profile 检查完整节点、owner、属性与顺序，拒绝复杂 index/reparent 覆盖；它不与 local 资源 profile 组合。

`template-local-v1` 是单独的资源语义扩展。它需要 `resource_local_to_scene`、实例描述符和运行时能力共同允许。复制在模板根已物化、尚未进入 SceneTree 时执行，复用 Godot 原生 `duplicate_for_local_scene` 重映射缓存；全部属性和 owner 恢复后才执行一次 setup。是否开放该 profile 应以对应原生和集成验证记录为准。

## 5. 构建、编辑器和导出

每次构建产生不可变代际目录与 manifest，白名单资源闭包也复制到该代目录，依赖指向这份副本，延迟加载不会读取后来修改的作者资产。只有类型检查、模板检查、代码生成、资源导入和 manifest 封存都成功，才原子切换 `generated/react/active.json`。稳定入口脚本在求值业务模块前取得租约并固定一份 generation。源码项目中，构建器先请求运行应用受控关停，释放租约后才发布新代；导出过程的读取租约会阻止并发发布。

```sh
godot-react watch --entry app
godot-react preview --entry app --verify
godot-react export --entry app --output build/game.pck
```

`preview --verify` 运行框架启动检查并输出结构化 BootReport。正式 CLI 导出先构建与检查，在临时路径导出 PCK，再在没有项目源码的空目录启动并验证，成功后才发布目标文件。可以配置独立业务验证器；框架启动成功不能替代业务测试。

`watch --entry app` 在首次构建成功后启动预览；加入 `--headless` 可用于无窗口验证。源码变化时先关停并等待旧预览进程完整退出，再构建新代，并在 READY 后重新启动相同入口。构建失败期间保持预览关闭，修正源码后继续重启；退出 watcher 会清理它管理的预览。

单独运行的 `watch` 也会接续通过 SDK `preview` 启动的预览，在首次重建后由 watcher 管理重启。直接运行 Godot、外部工具或编辑器启动的进程没有对应预览监督记录，watch 返回 `E_RUN_ACTIVE` 并保留待构建变化，不擅自接管这些进程。`watch --skip-initial` 用于已有同步构建后的观察模式。

正式导出需要与实际二进制 SHA-256 匹配的原生构建报告，记录模块源码快照、引擎和构建参数。构建器可以自动发现二进制旁边或其父目录中的 `react-native-build.json`，也可以在配置中指定 `nativeReport`。普通开发构建可使用明确标记为 unknown 的源码来源，正式导出会拒绝未认证的目标。

F5 的原生 `EditorPlugin.build()` 会同步检查构建并在失败时阻止运行。正在工作的 watcher 继续存活，由发布锁串行化；F5 不通过硬杀 watcher 中断资源导入。编辑器的通用 export 回调没有可靠的跨平台取消返回值，正式产物应通过上述 CLI 导出流程生成。

构建中断后运行 `godot-react recover`。仍存活的发布进程或应用不能被强制接管；没有 owner 的锁需要显式 `--force-unowned-lock`。`godot-react gc` 只删除已封存 manifest 记录的旧代际文件，并拒绝删除内容已经改变的文件。

## 6. 验证和迁移

自动检查入口：

```sh
pnpm test:react
node scripts/test/react-native-build.mts --godot-source /path/to/godot-source --out /path/to/independent-build --engine qjs
node scripts/test/react-native-test.mts --native-report /path/to/independent-build/react-native-build.json
node scripts/test/react-integration.mts --godot /path/to/independent-build/bin/godot.linuxbsd.editor.x86_64 --native-report /path/to/independent-build/react-native-build.json --out /path/to/integration-output
```

原生构建、原生测试和集成测试的具体参数见 `scripts/test/react-native-build.mts`、`react-native-test.mts`、`react-integration.mts`；它们记录源码快照、引擎类型、构建参数、二进制 SHA-256 和逐阶段结果。`tests/react` 提供实际组件与外部 Godot 验证器。

迁移时先把状态与行为搬入 React 组件，再将节点树改为宿主 JSX，或者把符合白名单的旧场景作为只读模板。含既有 Script 的节点需要显式迁移成生成的原生接口 profile；不支持在已发布 Node 上动态换 Script。外部 GDScript/C++ 结构变更会被审计为错误，框架不会把这种变更反向吸收成 React 真值。

能力范围、架构合同和逐项开放门槛见 [完整设计](react-tsx-design.zh-CN.md)。此使用指南描述接口与工作流，实际引擎和扩展能力认证以随实现更新的验证记录为准。
