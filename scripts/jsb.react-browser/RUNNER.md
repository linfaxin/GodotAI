# PreviewRunner

页面运行只需要静态文件和浏览器 API，不需要运行时 Node 服务或 WebContainers。Node 用于构建、发布和 CI 编排。esbuild-wasm 编译和 TypeScript 检查使用各自 Worker；Godot 引擎与用户 JavaScript 当前仍在预览 iframe 主线程运行。

## 接入

将 [preview.ts](../../apps/playground/preview.ts) 打包成 `preview.js`，与 [preview.html](../../apps/playground/preview.html) 部署在独立 origin。构造器拒绝编辑器自身 origin。

```ts
import { PreviewRunner } from '@godot-js/react-browser';

const runner = new PreviewRunner({
  container: document.querySelector<HTMLElement>('#preview')!,
  previewUrl: 'https://preview.example.net/preview.html',
  release, // 从可信 release descriptor 映射的 VerifiedRelease
});
const unsubscribe = runner.subscribe(event => {
  if (event.type === 'log') output.textContent += event.text + '\n';
});
await runner.run(artifact);
const exit = await runner.stop();
await runner.dispose();
unsubscribe();
```

`artifact` 包含 `revision`、`buildKey`、`generation`、`manifest` 和 `pack: Uint8Array`。manifest 的 generation 必须一致。Runner 创建私有快照，保留构建身份，每次运行分配新 runId 和 iframe；较新的请求取消正在等待的旧请求。语义类型错误应在调用 `run` 前拒绝，以保留上一份可用预览。

两端明确检查 editorOrigin、previewOrigin 与消息来源，握手后使用 MessageChannel。协议携带 protocolVersion/runId/revision/buildKey/generation；错误 DTO、旧身份和乱序阶段被忽略。日志有数量/体积限制，并标记 `untrusted`，应使用文本渲染。

iframe 加载和握手各有 deadline。之后依次为 downloading、preloading、initializing、starting、waiting-ready、running 六阶段，均支持取消。启动阶段使用各自 deadline；只有进入 running 后才启用并重置 heartbeat 窗口，避免冷 WASM 编译被较短的运行心跳误杀。running 总时长默认不限，stopping 使用独立退出 deadline。

`run()` 成功表示引擎 start 返回且浏览器动画帧可继续运行。用户 BootReport 日志不会成为可信启动或发布认证依据。

## 隔离和挂死边界

| 退出原因 | 已观察到的结果 |
| --- | --- |
| `clean-exit` | 引擎报告退出码 0。 |
| `forced-frame-disposal` | 启动前取消，或仍有响应的引擎未按时完成协作退出，frame 被移除。 |
| `crashed` | 已观察到启动/运行故障或非零引擎退出码。 |
| `unresponsive` | 阶段 deadline 或 running heartbeat 超时，并尝试移除 frame。 |

`requestQuit()` 是协作式的，Godot web interrupt 目前不能中断同步用户循环。不同 origin 不保证不同浏览器进程或事件循环；若父页也被阻塞，父页 timeout 无法运行。删除 iframe 因此是尽力恢复，**不是跨浏览器硬停止保证**。真实死循环探针使用独立 Node watchdog，能记录父页无法恢复的结果。

部署应优先让预览与编辑器处于不同站点。预览 origin 不承载编辑器凭据和特权 API。iframe 使用 `allow-scripts allow-same-origin` sandbox；CSP 限制网络目的地，GodotJS 直接 eval 模块目前仍需 `unsafe-eval`。

用户代码与引擎 glue 共享预览 realm，可访问该 realm 的浏览器 API。native bridge、消息身份、manifest hash 和 BootReport 都不构成 JavaScript 沙箱。编辑器不能把预览遥测解释为文件读写、发布或其他特权指令。

## 同字节加载与显式 gzip

`VerifiedRelease` 指定 engineJs、engineWasm 的 URL 与 SHA-256。同源私有静态文件使用 `credentials: same-origin` 保留当前 origin 的登录态；跨 origin CDN 请求不会携带本站 cookie。JS 校验后以同一份 Blob 字节执行。Godot 4.6.1 公开 `Engine.load()` 的唯一精确 WASM 请求由内存 Response 满足，项目代码开始前立即恢复 fetch，不再下载第二份 WASM。不兼容的公开 loader 会拒绝加载。

支持原始 `.wasm` 和显式静态 `.wasm.gz`：

```ts
engineWasm: {
  url: 'https://cdn.jsdelivr.net/npm/PACKAGE@VERSION/assets/godot.wasm.gz',
  sha256: encodedSha256,
  encoding: 'gzip',
  decodedSha256,
  decodedBytes,
  maxDecodedBytes: 128 * 1024 * 1024,
}
```

先校验压缩文件摘要，再通过 DecompressionStream 流式限额解压，复验解码摘要及可选精确长度。传输与解码预算独立，默认各 128 MiB；解压超限立即取消读取。引擎使用去掉 `.gz` 的虚拟 `.wasm` URL，该 URL 只在内存中解析，不发网络请求。

将 `.wasm.gz` 作为 gzip 静态文件提供，例如 `application/gzip`；不要用会让浏览器提前解开该文件的 `Content-Encoding: gzip` 配置，否则压缩摘要不会匹配。制品摘要提供完整性，release descriptor 自身仍需来自可信来源。

## 音频和浏览器证据

生产入口默认 `Dummy`。独立 `AudioWorklet` 探针通过真实用户手势检查 context/node/port 的创建、boot failure、立即 Stop、多轮 fresh iframe 和退出清理；同时重现原始 Godot 竞态，确认真正的 worklet 加载错误仍可观察。该结果不等于 headless 可听输出或完整 sample playback 认证。正式启用音频还需明确 profile、worklet 制品完整性与部署权限策略。

Godot 4.6.1 的可选 PWA 查询与音频异步退出修复由 [`scripts/release`](../release) 的独立补丁脚本跟踪，在 release 计算摘要之前应用，并记录 patch ID。

真实探针：

```sh
# PREFLIGHT_SITE 指向 prepare 后的静态fixture；PLAYWRIGHT_MODULE 指向安装的 playwright-core/index.mjs
node scripts/test/browser-isolation.mjs --gzip
node scripts/test/browser-audio.mjs

# 同一份真实应用集成可选择浏览器；Firefox/WebKit 使用已安装的 Playwright browser。
BROWSER=firefox node scripts/test/browser-playground.mjs --site /path/to/site --out /path/to/report
BROWSER=webkit node scripts/test/browser-playground.mjs --site /path/to/site --out /path/to/report

# 本地 HttpOnly/Lax cookie 门禁：同Site不同origin，保留17项应用集成并增加2项凭据检查。
node scripts/test/browser-playground.mjs --authenticated-gate --site /path/to/site --out /path/to/auth-report
```

`BROWSER_EXECUTABLE` 可指定浏览器入口；`BROWSER_HEADLESS=0` 适用于有 DISPLAY/Xvfb 的 CI。代理环境需为浏览器正确安装受信 CA，不能通过关闭 TLS 校验换取通过。Linux Playwright WebKit 是单独的测试目标，不能据此声称 macOS/iOS Safari 已认证。

隔离报告记录真实 origin、浏览器版本、编码/解码字节、网络请求、退出、坏摘要和同步循环结果。音频报告记录真实激活状态、context 状态、node/port 计数、错误及 JS/WASM/worklet 摘要。完整应用报告另绑定 runtime release 和全部静态模板 hash。支持结论只覆盖实际测试的版本、字节、模式和 profile。

2026-11-04 对 release `7af4b8e0f826491f8beb7871a4cfbc5b10660b811c2789f4074faa94f5757753` 的记录如下。正常应用集成覆盖 production/development、core UI、media、physics 等 15 项；音频为 Dummy。Firefox/WebKit 在 Linux Xvfb 和 Mesa 软件 WebGL 下运行。

| 浏览器 | 正常应用完整集成 | running 后同步循环恢复 |
| --- | --- | --- |
| Chromium 154.0.8037.57 | 通过 | 当前独立站点拓扑观察到恢复。 |
| Firefox 142.0.1 | 通过 | 未支持；父页未能在 watchdog 内恢复。 |
| Linux Playwright WebKit 26.0 | 通过 | 未支持；父页未能在 watchdog 内恢复。 |

表中的正常应用兼容性不会把无限循环恢复扩展为跨浏览器保证。后续修改 runtime 或静态模板，应重新生成绑定新制品的验证记录。
