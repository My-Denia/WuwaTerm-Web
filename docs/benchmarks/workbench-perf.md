# WuwaTerm-Web Workbench Performance & Bundle Benchmark (`df0a4d0` vs Current)

本报告记录对 `app/components/document-workspace.tsx` 拆分重构与 PR #84 演进（CM6 编辑器懒加载、Web Worker `canonicalOf` 卸载、控制器子模块拆分与统一检视栏）的真实可复现量化对照结果。

## 测试环境与测量方法

- **对比基线（Before）**：`df0a4d0`（`v0.7.0`，通过 `git archive df0a4d0` 导出至独立临时目录 `/tmp/web-bench-before`，独立执行 `npm ci --no-audit --prefer-offline && npm run build`）
- **当前分支（After）**：`refactor/split-document-workspace-and-perf-bench`（基于 `e75dd4e` 完成 `document-workspace.tsx` 拆分、基准无偏修正与 `npm run build`）
- **运行环境**：
  - Node.js `v22.22.0`（`linux x64`）
  - CPU：`Intel(R) Core(TM) i9-14900HX`（32 cores）
  - 内存：`11.68 GiB`
  - 浏览器引擎：Playwright Chromium（`headless: true`），通过 `tests/helpers/built-harness.mjs` 驱动真实 `dist/` 生产构建产物（合成 `/api/capabilities` 与 `/api/pool`，零 LLM/网络调用）
- **可复现命令**：
  ```bash
  mkdir -p /tmp/web-bench-before
  git archive df0a4d0 | tar -x -C /tmp/web-bench-before
  (cd /tmp/web-bench-before && npm ci --no-audit --prefer-offline && npm run build)
  npm run build
  node scripts/benchmark-web-perf.mjs --before /tmp/web-bench-before --after . --browser --markdown
  rm -rf /tmp/web-bench-before
  ```
- **工作负载定义**：`scripts/benchmark-web-perf.mjs` 使用确定性双语测试稿（含 `\r\n\r\n` CRLF 换行与 `今汐`/`Jinhsi`、`声骸`/`Echo` 等术语）：
  - `50` 段：原文 `4,578` Unicode scalars / 译文 `12,928` scalars（workfile `25,247 B`）
  - `200` 段：原文 `18,580` Unicode scalars / 译文 `51,980` scalars（workfile `101,101 B`）
  - `500` 段：原文 `46,780` Unicode scalars / 译文 `130,280` scalars（workfile `253,201 B`）

---

## 1. 源码规模与产物 Chunk 体积（Raw & Gzip-9，二进制 `KiB = B / 1024`）

> 注：在 `e75dd4e`（拆分前）时，`app/components/document-workspace.tsx` 已膨胀至 `1,560` 行 / `91,121 B`（`88.99 KiB`）；本次拆分将其收敛为 `373` 行 / `23,962 B`（`23.40 KiB`），较 `df0a4d0` 降低 `67.5%`，较 `e75dd4e` 降低 `73.7%`。

| 指标 | Before (`df0a4d0`) | After（当前分支） | 变化 |
| --- | ---: | ---: | ---: |
| `document-workspace.tsx` 行数 | 1,187 | 373 | -814 (-68.6%) |
| `document-workspace.tsx` 源码体积 | 73,692 B (71.96 KiB) | 23,962 B (23.40 KiB) | -49,730 B (-67.5%) |
| `document-workspace` chunk (raw) | 395,015 B (385.76 KiB) | 419,434 B (409.60 KiB) | +24,419 B (+6.2%) |
| `document-workspace` chunk (gzip-9) | 113,753 B (111.09 KiB) | 122,337 B (119.47 KiB) | +8,584 B (+7.5%) |
| `index` 主入口 chunk (raw / gzip-9) | 106,557 B / 31,804 B | 106,557 B / 31,804 B | 0 B (0.0%) |
| `framework` 公共 chunk (raw / gzip-9) | 219,274 B / 67,510 B | 219,274 B / 67,510 B | 0 B (0.0%) |
| `vinext` 运行时 chunk (raw / gzip-9) | 149,635 B / 45,046 B | 149,635 B / 45,046 B | 0 B (0.0%) |
| `messages` 语言包 chunk (raw / gzip-9) | 119,958 B / 41,112 B | 120,909 B / 41,485 B | +373 B gzip (+0.9%) |
| Quick 模式首屏静态 JS 闭包 (raw / gzip-9) | 1,029,161 B / 313,430 B (306.08 KiB) | 1,055,245 B / 322,553 B (314.99 KiB) | +9,123 B gzip (+8.91 KiB / +2.9%) |
| 懒加载 `cm6-editor` chunk (raw / gzip-9) | N/A | 284,572 B (277.90 KiB) / 91,068 B (88.93 KiB) | 仅文稿模式按需加载 |
| 独立 `canonical.worker` 产物 (raw / gzip-9) | N/A | 154,238 B (150.62 KiB) / 51,684 B (50.47 KiB) | 仅大稿件 Worker 线程加载 |
| 全部客户端 JS chunks 总和 (raw / gzip-9) | 1,045,500 B / 319,328 B | 1,356,156 B / 419,511 B | +100,183 B gzip (+31.4%) |
| 客户端 CSS 总和 (raw / gzip-9) | 53,339 B / 10,906 B | 59,863 B / 12,020 B | +1,114 B gzip (+10.2%) |

**体积结论**：CodeMirror 6（`88.93 KiB` gzip）与 Web Worker 序列化内核（`50.47 KiB` gzip）已完整从 Quick 首屏静态依赖中隔离；Quick 模式首屏静态 JS 仅比 `df0a4d0` 增加 `8.91 KiB` gzip（`306.08 KiB` → `314.99 KiB`，`+2.9%`），同时承载了统一检视栏、坐标转换与 Worker 客户端调度逻辑。

---

## 2. 大型稿件计算与状态更新（50 / 200 / 500 段，Node 实测）

- `normalizeLineBreaks`：15 次采样（2 次预热）
- `Incremental edit coord/normalize`：`df0a4d0` 对整段文本执行正则换行规范化；当前分支通过 `applyDomChangesToRaw` 只修改局部脏区（15 次采样，2 次预热）
- `pairSegments` 与 `canonicalOf`：9 次采样（2 次预热）；`canonicalWorkerDispatch` / `EndToEnd` 通过 `node:worker_threads` 实测 `createCanonicalComputer`（7 次采样，1 次预热）
- `Controller 20-edit burst`：导入指定段数稿件后连续执行 20 次 `editText('target', ...)`；`df0a4d0` 基线按旧版 `DocumentWorkspace` 的 `useMemo(() => canonicalOf(...))` 在每次编辑后同步计算 `canonicalOf`，当前分支由去抖动 Worker 异步计算（5 次采样，1 次预热）

| 段数 | 指标 | Before Median | After Median | 变化 |
| ---: | --- | ---: | ---: | ---: |
| 50 | `normalizeLineBreaks` | 0.00 ms | 0.00 ms | 0.00 ms (0.0%) |
| 50 | 增量编辑坐标/换行规范化 | 0.00 ms | 0.08 ms | +0.08 ms |
| 50 | `pairSegments` 分段计算 | 0.51 ms | 0.47 ms | -0.04 ms (-7.8%) |
| 50 | `canonicalOf` 主线程同步 vs Worker 派发 | 0.35 ms | 0.06 ms (e2e 1.37 ms) | 主线程 -82.9% |
| 50 | 控制器 20 次连续编辑突发 | 23.77 ms | 16.43 ms | -7.34 ms (-30.9%) |
| 200 | `normalizeLineBreaks` | 0.02 ms | 0.02 ms | 0.00 ms (0.0%) |
| 200 | 增量编辑坐标/换行规范化 | 0.02 ms | 0.02 ms | 0.00 ms (0.0%) |
| 200 | `pairSegments` 分段计算 | 1.46 ms | 1.29 ms | -0.17 ms (-11.6%) |
| 200 | `canonicalOf` 主线程同步 vs Worker 派发 | 1.07 ms | 0.08 ms (e2e 4.50 ms) | 主线程 -92.5% |
| 200 | 控制器 20 次连续编辑突发 | 97.58 ms | 71.79 ms | -25.79 ms (-26.4%) |
| 500 | `normalizeLineBreaks` | 0.03 ms | 0.03 ms | 0.00 ms (0.0%) |
| 500 | 增量编辑坐标/换行规范化 | 0.02 ms | 0.06 ms | +0.04 ms (+200.0%) |
| 500 | `pairSegments` 分段计算 | 2.89 ms | 3.18 ms | +0.29 ms (+10.0%) |
| 500 | `canonicalOf` 主线程同步 vs Worker 派发 | 2.26 ms | 0.15 ms (e2e 12.12 ms) | 主线程 -93.4% |
| 500 | 控制器 20 次连续编辑突发 | 230.13 ms | 196.77 ms | -33.36 ms (-14.5%) |

---

## 3. 真实 Chromium 浏览器渲染与交互耗时（生产 `dist/`）

在 Playwright Chromium 中实测 Quick 模式网络传输、无偏模式切换（在计时窗外由构建产物清单预判 `hasCm6`，双方均待目标编辑器可见并完成双 `requestAnimationFrame` 渲染帧提交）、50/200/500 段 workfile 导入挂载，以及在编辑器末尾连续输入字符直至双 `requestAnimationFrame` 提交的真实帧耗时（5 次采样）：

| 指标 | Before (`df0a4d0`) | After（当前分支） | 变化 |
| --- | ---: | ---: | ---: |
| Quick 模式 JS 网络传输（实际请求数） | 1,028,026 B (1,003.93 KiB, 15 reqs) | 1,054,097 B (1,029.39 KiB, 16 reqs) | +26,071 B (+2.5%) |
| Quick 模式发起 Worker 请求数 | 0 | 0 | 保持 0 请求 |
| 切换至文稿模式（含懒加载 CM6 挂载） | 83.82 ms | 130.78 ms | +46.96 ms (+56.0%) |
| 切换至文稿模式增量 JS 传输 | 0 B（原生 textarea） | 284,572 B (`cm6-editor`) | 按需加载 |
| 50 段导入并挂载 | 68.33 ms | 129.33 ms | +61.00 ms (+89.3%) |
| 50 段输入帧耗时 Median | 32.00 ms | 31.60 ms | -0.40 ms (-1.3%) |
| 200 段导入并挂载 | 98.83 ms | 184.42 ms | +85.59 ms (+86.6%) |
| 200 段输入帧耗时 Median | 31.90 ms | 31.40 ms | -0.50 ms (-1.6%) |
| 500 段导入并挂载 | 150.73 ms | 231.65 ms | +80.92 ms (+53.7%) |
| 500 段输入帧耗时 Median | 54.90 ms | 40.40 ms | -14.50 ms (-26.4%) |

**交互与内核结论**：
1. **Quick 模式零冗余加载**：`cm6-editor` 与 `canonical.worker` 均未在 Quick 模式首屏触发任何网络请求；Quick 冷启动网络传输仅增 `+2.5%`。
2. **大型稿件按键延迟显著下降**：在 500 段（约 177k chars 双语合计）场景下，尽管当前分支使用功能更完整的 CodeMirror 6 编辑器，但凭借去抖动 + Web Worker 卸载 `canonicalOf`，主线程单次输入帧延迟从 `54.90 ms` 降至 `40.40 ms`（**-26.4%**）；控制器 20 次连续编辑突发耗时从 `230.13 ms` 降至 `196.77 ms`（**-14.5%**）。
3. **文稿模式切换与导入挂载权衡**：从 Quick 切换至文稿模式并首次初始化懒加载 `cm6-editor` 带来 `+46.96 ms` 的首次切换耗时（`83.82 ms` → `130.78 ms`），首次导入 50–500 段稿件初始化 CM6 视图带来 `+61.00 ms` 至 `+85.59 ms` 的一次性挂载开销，换取了稳态编辑期间显著更低的主线程帧延迟与完整的内联高亮/CRLF 保真能力。
