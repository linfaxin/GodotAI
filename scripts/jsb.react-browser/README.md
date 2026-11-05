# Browser compiler and assets

这个包在浏览器 Worker 中解析 npm 原文件、编译 TSX、检查锁定的声明图，并生成真实 Godot WASM 可读取的 PCK。开发和 CI 可以使用 Node；页面运行不依赖 Node 服务或 WebContainers。

## 当前模板边界

`BROWSER_ASSET_CAPABILITIES.templates` 和 `prevalidatedTemplatePackages` 均为 `false`。浏览器没有可消费的预验证模板包 API；早期预留的 `PrevalidatedTemplatePackage` 类型已移除。原始 `.tscn`、`PackedScene` 资产，以及把 JSON 中的 hash 或自报 `certificateSha256` 当作认证的输入，均拒绝。资源依赖闭包也执行该检查，不能通过 `.tres` 间接载入场景或 Script。

这是现有设计的能力门禁，不代表 Node 构建器的模板能力被移除：

- [设计 W10/G2](../../docs/react-tsx-design.zh-CN.md) 要求在没有作者 autoload/plugin 的最小项目中，用原生 `SceneState` 对照节点、属性、owner 和顺序；未通过时关闭 template feature，可以发布不含 `template-t0` 的 core。
- [Node importer](../jsb.react-build/src/template.ts) 已有 `importTemplate` 和 `verifyTemplatesNative`，后者实际启动隔离原生提取项目。它不会被浏览器文本 parser、文件哈希或一个证书字段替代。
- 重新开放浏览器模板前，需要构建期实际验证记录、与 runtime release/profile 绑定的可信包清单或签名、浏览器闭包和 hash 验证，以及普通 React 模块/专属声明的 resolver 集成和真实运行验收。当前包没有把这组未来工作标为完成。

## 可用资产

`compileAssets(snapshot, { generation, signal?, decodeImage?, budgets? })` 返回 `files`、`resources`、`sourceOrigins` 和 `sourceHashes`。

- PNG/JPEG 在浏览器中通过 `createImageBitmap` 和 `OffscreenCanvas` 解码成 RGBA8，生成封闭的 `ImageTexture` `.tres`。原始图片不交给 Godot import pipeline。
- `Image.data` 使用 Godot 4.6.1 的实际持久化格式：`width`、`height`、`format: "RGBA8"`、`mipmaps: false`、`data: PackedByteArray(...)`。
- 严格 `.tres` 子集支持 `Resource`、`CanvasItemMaterial`、`CircleShape2D`、`RectangleShape2D`、`CapsuleShape2D`。依赖递归冻结到 generation 路径；脚本、未知属性/构造器/section、场景和 local-to-scene 语义被拒绝。
- 输入/输出字节、图片尺寸、资源数量与深度均有预算。PNG IHDR/JPEG SOF 尺寸在解码分配前检查，解码结果再次验证。

## npm 支持边界

直接依赖使用精确标准版本；传递依赖和普通 peer 使用标准 semver 并写入精确 lock。运行时图和声明图共享包实例及 peer 绑定，文件分支可以不同。重放 lock 不重新选版本，每个原文件用 SHA-256 和长度复验。

支持 ESM/CJS/JSON、相对路径/扩展/目录、明确 exports 子路径、条件对象及 `null`、main/module、包内声明和显式声明的 `@types`。解析策略默认 neutral Godot 宿主；浏览器编译 Worker 不意味着用户 npm 代码拥有 DOM API。React/SDK/scheduler 使用 release 的认证实例。

Node builtins、运行时未闭合的动态加载、未声明依赖、package `imports`、需要通配符匹配的 exports、exports 数组、需要 `typesVersions` 的未认证 npm 声明，以及未支持的依赖来源返回明确诊断。包的明确 exports 入口仍可与未使用的 wildcard 入口共存。动态模块门禁最终由共享 bundler 执行，覆盖依赖内部代码。

## 验证

```sh
pnpm --dir scripts/jsb.react-browser test

# 显式在线 smoke；Node 24 的代理环境可加 --use-env-proxy。
node --use-env-proxy scripts/jsb.react-browser/test/resolver.cdn.mjs --out /tmp/npm-cdn-report.json

# 开发/CI 编排在 Node；图片解码、资源编译、PCK 和原生加载在浏览器。
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
node scripts/jsb.react-browser/test/assets.browser.mjs \
  --engine-dir /path/to/godot-assets --out /tmp/assets-native-report.json
```

离线单元测试不访问 CDN。在线 smoke 解析实际 `clsx@2.1.1`、`camel-case@4.1.2` 及传递图，记录原文件 hash、版本请求和两张图，重放 lock，再只用图内字节打包执行并检查结果；它不能外推为任意 npm 兼容。浏览器资产 probe 用实际 Godot 读取生成的 PNG/JPEG ImageTexture 和 CircleShape2D，检查像素、尺寸、类型、属性和正常退出。

## 预览 Runner

`PreviewRunner` 使用独立 origin、新 iframe 和 MessageChannel 运行已生成的 PCK。编译和 TypeScript 检查使用 Worker；当前 Godot 与项目 JavaScript 在预览 iframe 主线程运行。主线程同步死循环没有跨浏览器可抢占终止保证。生产预览默认音频为 `Dummy`。

[Runner 使用与边界](./RUNNER.md) 说明 API、六阶段 deadline/取消、退出原因、消息与制品信任边界、gzip 的压缩/解压双重摘要和预算、AudioWorklet 独立验证，以及真实浏览器探针命令。浏览器或音频认证只覆盖记录中实际验证的版本、制品和 profile。
