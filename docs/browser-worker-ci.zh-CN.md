# 完整 Worker 引擎的 Linux CI

`.github/workflows/browser-worker.yml` 的 PR 和 main 分支先运行 Chromium 原生压力测试，再运行正式 Worker 产品验收；二者都保持 100 次重复会话。正式路径使用生产编译 Worker、校验加载器、共享内存启动检查、RuntimeHost 和 PreviewRunner。随后独立 Firefox job 下载同一份封印候选，执行完整产品用例和两次额外音频循环。手动任务也可选择 Firefox 或 WebKit，结果只证明报告中的浏览器版本和操作系统。当前固定的 Playwright 1.57.0 对应 Chromium 143、Firefox 144 和 Linux WebKit 26。

构建使用 `.node-version` 的 Node、`package.json` 的 pnpm 10.11.0、Emscripten 4.0.11、SCons 4.10.0、Python 3.12 和 Godot 源码提交 `14d19694e0c88a3f9e82d899a0400f27a24c176e`。Emscripten 的 JS 构建宿主也绑定到选定 Node。上游 Godot checkout 会先移出模块仓库，再执行源快照和构建；不会把嵌套上游源码作为 GodotJS 输入复制。

## 图形与音频环境

CI 使用 Ubuntu 24.04，安装 `xvfb`、`x11-utils`、`pulseaudio`、`pulseaudio-utils`、`libasound2-plugins` 和 `libgl1-mesa-dri`。Playwright 的浏览器及其系统依赖由锁定的工作区包安装，不假定系统存在 `/usr/bin/chromium`。

`scripts/test/run-browser-worker-linux.sh` 为每次运行启动私有 PulseAudio 服务，加载 48 kHz、双声道的 `module-null-sink`，使用 Unix socket 和 cookie/用户身份认证。浏览器连接真实音频服务，实际执行 Godot generator → WebAudio → AnalyserNode 的非零采样检查。null sink 不代表物理扬声器或麦克风验收，也不是 Godot 的 Dummy Audio driver。

Firefox 使用 `Xvfb` 的 `1280x960x24` 屏幕、`BROWSER_HEADLESS=0` 和 Mesa 软件渲染。本地实际验证发现该 Firefox 版本在纯 headless 环境中没有可用 WebGL，因此不能只安装浏览器后直接运行 headless 就声称通过。Chromium 默认继续 headless，可以使用同一私有 PulseAudio 配置。

包装脚本为自身启动的服务设置退出清理，保留以下证据：

- `environment/environment.json`：实际 OS、包版本、Node、图形/音频环境和执行命令。
- `environment/pulseaudio.log`、`pactl-info.txt`、`pactl-sinks.txt`、`pactl-modules.txt`：真实服务、设备及模块状态。
- Firefox 的 `environment/xvfb.log`、`xvfb-display.txt` 和 `x11-info.txt`。
- `runtime.log`、`environment/command-status.json` 和原始 `worker-integration.json`。

任务失败仍上传证据，包装脚本原样传播测试退出码。源构建、单元测试、Linux 环境设置成功都不能替代完整浏览器运行通过。

## 正式产品与作者源码验收

CI 使用经固定 SHA-256 验证的官方 Godot 4.6.1 资源导入/导出工具，把认证的完整 pthread Web 模板装入正式站点。官方工具只处理资源；实际运行的 JS/WASM 仍来自当前构建报告。生产引擎的 snake/camel API 由真实浏览器采集，SDK、宿主 JS、SRI、engineId、extensionId 和站点 payload 在构建中一起封印。

`browser-worker-product-suite.mjs` 逐项调用以下真实验收脚本，并检查每份报告的 candidateId。`current-context.json` 还固定 descriptorHash、siteHash、releaseId 和验收 runId；站点字节漂移会直接失败。

- `browser-full-engine-test.mjs`：原生/React、编译与改名、音频、100 次额外 Chromium 会话、卡死后的整池终止与新文档恢复。
- `browser-worker-source-map-test.mjs`：浏览器编译器实际 PCK 中的原始 TSX、`.map`、sourcesContent 和哈希；原生捕获堆栈及 React render/commit/frame 异常都必须映射到作者文件的精确行、列，并到达编辑器。
- `browser-worker-release-barrier-test.mjs`：直接连接原生 `Button.pressed` 的 Callable，验证同步 flush 不释放信号发起者；私有 Promise 检查点只释放一次。另用原生 `child_order_changed` 回调转移退休节点，验证不抢回外部父节点、不释放并保持 non-clean 结构错误。
- schema4、资源转换器、可选 React 网络依赖，以及整组发布回退脚本。

源码映射 fixture 是 `tests/browser-preflight/WorkerSourceMapCrash.tsx`。它不会由 Node 编译或执行。测试观察真实编译 Worker 的返回值，从实际 PCK 读取映射，再核对引擎 Worker 的原始堆栈和最终诊断。旧 `verify-source-maps.mjs` 的单线程探针继续保留，但不替代此 Worker 候选验收。

Chromium 的主运行、源码映射、原生退休、可选 React 网络和回退用例使用双 HTTPS origin、当前临时证书的精确 SPKI pin、实际隔离头与版本化不可变路径。Schema4 与资源转换器 UI 用例使用单独标注的安全 HTTP loopback fixture。Firefox 使用安全 HTTP loopback fixture 和真实 Xvfb/PulseAudio 环境；报告不把这些范围称为外部 HTTPS/CDN 发布验收。

Schema4 编辑用例通过 Monaco 的真实查找框定位两处短 ASCII 标记，逐键替换并核对完整源文件、导出与恢复结果；它没有认证批量插入、剪贴板或输入法。回退用例在停机前等待真实 AudioWorkletNode 创建，再核对该次运行唯一的终态回执与资源回收数量。

### 回退 fixture 的范围

CI 初次运行也必须覆盖整组回退，因此 `browser-prepare-worker-products.mjs` 会完整构建两个真实站点：前一个使用明确标注的 `-worker-ci.previous` SDK 版本，后一个使用仓库原版本。两者都执行实际 API 采集、SDK 构建、资源导出和完整封印，不能只改 manifest 或伪造 ID。

临时版本修改保存 package.json 的完整原始字节，在成功、异常和正常中断路径中恢复；正式 current 候选只在恢复后重新构建 SDK。工具验证原始字节、实际 SDK 版本、两个扩展/发布身份，以及不随 SDK 版本改变的原生引擎身份。该机械 fixture 不冒充历史已部署版本。本地最终修复验收仍使用保留的真实旧候选做回退。

回退脚本验证 A→B→A、旧标签页继续固定 A，以及故意混入另一组 descriptor 时在引擎请求前拒绝。Firefox job 使用上传的相同候选字节，不在下载后重建或改写站点。

## 本地执行

以下命令适用于 Ubuntu 24.04，使用已经成功构建的、源认证的 `proxy-pthread` 引擎报告。运行前按 `.node-version` 和 `packageManager` 选择 Node/pnpm。

```sh
pnpm install --frozen-lockfile
pnpm build
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  xvfb x11-utils pulseaudio pulseaudio-utils libasound2-plugins libgl1-mesa-dri
export PLAYWRIGHT_BROWSERS_PATH="$PWD/../work/playwright-browsers"
pnpm --filter @godot-js/playground exec playwright install --with-deps firefox

bash scripts/test/run-browser-worker-linux.sh firefox /tmp/worker-firefox -- \
  node scripts/test/browser-pthread-integration.mjs \
  --engine-report /artifacts/worker-engine-report.json \
  --out /tmp/worker-firefox --browser firefox --loops 3
```

Chromium 把两处 `firefox` 参数改为 `chromium`，并先安装相应的 Playwright 浏览器。正式 PR gate 的 `--loops 100` 不变；小规模命令用于本地定位。浏览器报告还会记录实际 executable path、Playwright 版本、headless/display/audio-server 环境和每个真实 case。

准备并验证正式产品路径：

```sh
export GODOT=/tools/Godot_v4.6.1-stable_linux.x86_64
export GODOT_IMPORTER="$GODOT"
node apps/playground/scripts/browser-prepare-worker-products.mjs \
  --engine-report /artifacts/worker-engine-report.json \
  --out /tmp/worker-products --work-dir /tmp/worker-product-build

export PLAYGROUND_ACCEPTANCE_CONTEXT=/tmp/worker-products/current-context.json
bash scripts/test/run-browser-worker-linux.sh chromium /tmp/worker-product-evidence -- \
  node apps/playground/scripts/browser-worker-product-suite.mjs \
  --directory /tmp/worker-products/current \
  --previous /tmp/worker-products/previous \
  --out /tmp/worker-product-evidence --browser chromium --loops 100
```

报告汇总在 `product-suite.json`；每项浏览器报告与日志保持独立，失败仍保存已经完成的结果。Firefox 使用相同候选目录，把包装器与 `--browser` 都设为 `firefox`，并使用 `--loops 2`。源码映射和原生退休脚本也可分别通过 `PLAYGROUND_SOURCE_MAP_REPORT`、`PLAYGROUND_RELEASE_BARRIER_REPORT` 指定独立输出。

## WebKit 26：WK-01 外部阻塞

Linux Playwright WebKit 26 的标准最小 Wasm 复现表明：另一个实例增长共享内存后，旧实例的 `memory.size` 仍返回旧页数，`memory.copy` 和 `memory.fill` 对新增区域错误抛出越界；普通 load 和 JS `memory.buffer.byteLength` 可以看到新区域。1→2 页的标准测试即可复现，Chromium 143 和 Firefox 144 的相同测试通过。

这会在完整引擎的原生辅助线程初始化时触发失败，与 React 业务代码无关。当前没有采纳代码生成层的绕过方案，也没有增加初始内存、关闭增长、减少模块或禁用线程。现有完整原生模板保持不变。

宿主在下载或执行完整引擎前运行真实能力探针，不支持时返回明确错误。手动选择 WebKit 的完整引擎任务应记录该不支持结果并保持失败，不能标成完整能力通过。更新浏览器版本后必须重新运行标准探针及完整引擎 gate；Linux WebKit 的结果也不等于真实 macOS/iOS Safari 的验收。
