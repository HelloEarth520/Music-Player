# MusicPlayer 代码重构方案

> 架构师：高见远  
> 目标：在**严格保持原有业务逻辑与功能行为 1:1 不变**的前提下，提升 4 个核心 JS 文件的可读性与可维护性。  
> 项目根目录：`E:\MusicPlayer`

---

## 1. 现状分析

### 1.1 各文件职责清单

#### `main.js`（344 行）— Electron 主进程
| 职责 | 位置 |
|---|---|
| 开启 SharedArrayBuffer 特性 | L15 |
| 文件关联启动参数解析 `extractFilesFromArgs` | L23-29 |
| 主窗口创建 `createWindow`（含 COOP/COEP 头注入、ready-to-show、DevTools） | L36-81 |
| 系统菜单构建 `buildMenu`（文件/播放/工具/帮助四组） | L86-163 |
| IPC 处理器：`dialog:openFile` / `dialog:openFolder` / `file:read` / `file:readDir` / `file:save` / `file:saveBatch` | L170-301 |
| 单实例锁 + `second-instance` 处理 | L306-318 |
| 应用生命周期（`whenReady` / `window-all-closed` / `activate` / `open-file`） | L323-344 |

#### `player.js`（939 行）— 渲染进程播放器逻辑（最大文件）
| 职责 | 位置 |
|---|---|
| 全局状态 `state` / 均衡器状态 `eqState` / 虚拟化配置 `VIRTUAL_CONFIG` | L18-55 |
| DOM 引用集合（约 22 个 `getElementById`） | L60-84 |
| 格式→MIME 映射 `FORMAT_MIME` + `getMime` / `isSupported` | L89-116 |
| 工具函数 `formatTime` / `getExt` / `getBaseName` / `randomColor` | L121-146 |
| 虚拟化滚动渲染（`initVirtualScroll` / `onPlaylistScroll` / `renderVisibleItems` / `createPlaylistItem` / `renderPlaylist`） | L151-246 |
| 智能元数据预加载（`preloadMetadata` / `loadTrackMetadata`） | L251-322 |
| 文件加载 `loadFiles`（兼容 Electron 路径与浏览器 File） | L327-379 |
| 核心播放（`playAt` / `updateBgColor` / `togglePlay` / `updatePlayBtn` / `startCoverSpin` / `pauseCoverSpin`） | L384-473 |
| 上一首/下一首/随机/循环模式（`playPrev` / `playNext` / `buildShuffleOrder` / `getShuffleNext` / `cycleMode`） | L478-534 |
| 进度条交互（`timeupdate` / `loadedmetadata` / `ended` / `seekTo` + 拖拽） | L539-582 |
| 音量控制（滑块 / 静音切换 / `updateVolIcon`） | L587-611 |
| 键盘快捷键 | L616-638 |
| 拖拽文件入窗 | L643-650 |
| 按钮事件绑定 | L655-684 |
| Electron IPC 监听（`onOpenFiles` / `onOpenFolder` / `onCommand`） | L687-701 |
| 窗口 resize 重算虚拟化 | L706-711 |
| **均衡器全套**（初始化 / 增益 / 预设 / 开关 / 面板 / 可视化 / 事件绑定） | L716-917 |
| 底部初始化块 | L922-938 |

#### `transcoder.js`（662 行）— FFmpeg.wasm 转码模块
| 职责 | 位置 |
|---|---|
| 转码状态 `tcState` | L15-24 |
| FFmpegLib 就绪事件监听 | L29-41 |
| DOM 引用集合（约 22 个） | L46-67 |
| 格式→编码器映射 `FORMAT_CONFIG` | L72-80 |
| 安全文件名生成 `safeName` / `safeOutputName` | L85-100 |
| CDN 配置 `CDN_CORES` + `makeBlobURL` + `loadFFmpeg` | L105-196 |
| 状态文本 `setStatus` | L198-201 |
| 源文件管理 `addSourceFiles` / `renderSourceFiles` | L208-251 |
| 参数读取 `getParams` | L256-265 |
| FFmpeg 命令构建 `buildArgs` / `buildAtempo` | L270-310 |
| 文件字节读取 `readSourceBytes` | L315-325 |
| 任务渲染 `renderTasks` / `statusLabel` / `updateTaskProgress` | L330-392 |
| 核心转码流程 `startTranscode`（95 行超长函数） | L397-491 |
| MIME 查询 `getMimeByExt` | L493-500 |
| 下载/导入/批量导出 `downloadTask` / `batchExportAll` / `importTaskToPlaylist` | L505-579 |
| 日志/Toast `appendLog` / `showToast` | L584-600 |
| 事件绑定 + 初始化 | L605-661 |

#### `preload.js`（47 行）— contextBridge 桥接
| 职责 | 位置 |
|---|---|
| 暴露 `electronAPI` 对象（11 个成员：`isElectron` / `openFile` / `openFolder` / `readFile` / `saveFile` / `saveFilesAsZip` / `readDir` / `onOpenFiles` / `onOpenFolder` / `onCommand` / `getFileURL`） | L10-47 |

### 1.2 识别出的问题点（按严重度）

#### P0 — 重复代码（跨位置复制粘贴，维护隐患）
1. **`main.js` 音频扩展名列表重复 4 次**：L99（菜单过滤器）、L175（dialog:openFile 过滤器）、L191（dialog:openFolder Set）、L210（file:readDir Set）。任何一处漏改都会导致行为不一致。
2. **`player.js` 音量更新逻辑重复 6 处**：L587-591（滑块 input）、L622-627（键盘↑）、L628-633（键盘↓）、L609-611（静音点击）、L697（volUp 命令）、L698（volDown 命令）。每处都做 `audio.volume = x; volumeSlider.value = x; volValue.textContent = ...; updateVolIcon(x);` 四步操作。
3. **`transcoder.js` vs `player.js` MIME 映射重复**：`getMimeByExt`（transcoder L493）与 `getMime`（player L108）各自维护一份音频 MIME 表，内容相近但不完全一致。
4. **`transcoder.js` `safeName` / `safeOutputName`**（L86-100）共享同一套 `replace(/[^a-zA-Z0-9_\-]/g,'_').substring(0,40)` 逻辑，仅前缀不同。

#### P1 — 超长函数
5. **`transcoder.js` `startTranscode`**（L397-491，95 行）：混合了任务创建、逐文件转码循环、字节读取、FS 写入、命令执行、输出读取、错误清理、UI 刷新，单一函数承担过多职责。
6. **`main.js` `file:saveBatch` 处理器**（L230-301，72 行）：内联 archiver 流管道搭建 + 逐文件 append + 错误收集，可读性差。
7. **`main.js` `buildMenu`**（L86-163，78 行）：纯数据模板，可读性尚可，但可加结构注释。

#### P2 — 魔法数字
8. `player.js`：音量步长 `0.05`（L623/629/697/698）、快进秒数 `5`（L620/621）、元数据超时 `5000`（L315）、预加载范围 `3`（L252）、音量图标阈值 `0.3`/`0.7`（L595/596）、默认音量 `0.8`（L922/606）。
9. `player.js` `updateBgColor`（L425）正则 `/#[0-9a-f]{6}/gi` 与渐变拼装逻辑无注释。
10. `transcoder.js` `safeName` 截断长度 `40`（L90/97）、`_fileCounter` 模块级可变状态无说明。

#### P3 — 职责混杂 / 模块过大
11. **`player.js` 939 行单文件**：均衡器（L716-917，约 200 行）与播放核心耦合度极低，仅在底部 init 处调用 `initEqualizer()` / `bindEqualizerEvents()`，是理想的拆分边界。
12. `player.js` `onCommand` 处理器（L693-700）把 volUp/volDown 逻辑内联，与键盘快捷键的音量逻辑重复且分散。

#### P4 — 命名 / 注释
13. `transcoder.js` `batchExportAll`（L522-569）含大量 `console.log` 调试输出（L524/531-533/542/549/552），生产代码中冗余（不影响功能，但污染控制台）。
14. 各文件函数普遍缺少 JSDoc 参数/返回值说明。
15. `player.js` `audio._prevVol`（L602/606）是挂在 DOM 元素上的运行时属性，无注释说明其为静音前的音量缓存。

---

## 2. 重构策略

### 2.1 命名优化清单

> 原则：**仅在内部辅助函数/常量层面改名**，所有跨进程/跨文件契约名（IPC channel、preload API、DOM id、命令字符串、事件名）**一律不动**（详见第 5 节铁律）。

| 旧名 | 新名 | 位置 | 理由 |
|---|---|---|---|
| （内联数组）`['mp3','flac',...]` | `SUPPORTED_AUDIO_EXTENSIONS` | main.js | 消除 4 处重复，单一数据源 |
| （内联 Set）`new Set([...])` | `AUDIO_EXT_SET` | main.js | 复用上面的常量派生 |
| （内联过滤器）`{name:'音频文件',...}` | `AUDIO_DIALOG_FILTERS` | main.js | 复用常量 |
| `safeName` 内部 base 处理 | 抽出 `sanitizeBaseName(name)` | transcoder.js | safeName/safeOutputName 共用 |
| （内联音量四步操作） | `applyVolume(value)` / `adjustVolume(delta)` | player.js | 消除 6 处重复 |
| `0.05` / `5` / `5000` / `3` / `0.8` | `VOLUME_STEP` / `SEEK_STEP` / `METADATA_TIMEOUT_MS` / `PRELOAD_RANGE` / `DEFAULT_VOLUME` | player.js | 消除魔法数字 |
| `0.3` / `0.7` | `VOL_ICON_LOW` / `VOL_ICON_MID` | player.js | 阈值语义化 |

> 注：以上均为**新增常量/辅助函数**，不删除任何现有函数名。现有对外函数名（`playAt` / `togglePlay` / `loadFiles` / `initEqualizer` 等）保持不变。

### 2.2 函数拆分方案

#### `transcoder.js` — `startTranscode` 拆分
将 L397-491 的 95 行函数拆为：
- `startTranscode()`：保留任务创建、按钮状态切换、循环调度（精简为 ~30 行）
- `transcodeOne(task, params, ffmpeg)`：抽出循环体（L430-483），单一职责=转码单个文件（读取字节→写 FS→执行→读输出→清理），返回更新后的 task

#### `main.js` — `file:saveBatch` 拆分
将 L230-301 拆为：
- IPC handler `file:saveBatch`：选保存路径 + 调用打包（~15 行）
- `createZipArchive(files, zipPath)`：搭建 archiver 流管道、逐文件 append、错误收集，返回 Promise（~45 行）

#### `main.js` — 提取 `sendOpenFiles(files)` 辅助
L70/L315/L340 三处 `mainWindow.webContents.send('open-files', ...)` 合并为带空值守卫的辅助函数。

#### `player.js` — 提取音量辅助
- `applyVolume(value)`：clamp[0,1] → 设 `audio.volume` → 同步 `volumeSlider.value` → 更新 `volValue` 文本 → `updateVolIcon`。替换 L587-591 / L609-611 / L622-627 / L628-633 / L697-698 共 6 处。
- `adjustVolume(delta)` = `applyVolume(audio.volume + delta)`，供键盘↑↓与 volUp/volDown 命令复用。

### 2.3 冗余/重复代码移除点
1. main.js：4 处音频扩展名字面量 → 1 个常量 + 1 个派生 Set + 1 个过滤器常量。
2. player.js：6 处音量四步操作 → 2 个辅助函数。
3. transcoder.js：safeName/safeOutputName 共用 `sanitizeBaseName`。
4. transcoder.js `batchExportAll`：将 6 条 `console.log('[BatchExport]...')` 调试日志收敛为 1 条可选调试开关（行为不变，仅减少控制台噪声；若主理人希望保留可跳过此条）。

### 2.4 模块化建议：player.js 是否拆分？

**结论：是，建议拆分。仅拆出均衡器，其余保留在 player.js 内部整理。**

**理由**：
1. `player.js` 939 行过大，但其中均衡器部分（L716-917，约 200 行）**几乎完全自包含**：
   - 自带独立状态 `eqState`（L30-48）；
   - 仅依赖 DOM 上的 `audio-engine` 元素与一批 `eq-*` / `equalizer-*` 选择器；
   - 不读写 `state`（播放状态）、不调用 `playAt` / `loadFiles` 等核心函数；
   - 与 player.js 核心的唯一耦合点是底部 init 的 `initEqualizer()` + `bindEqualizerEvents()` 两句调用。
2. 拆出后 player.js 核心约 740 行，均衡器 200 行独立成文件，两者各自聚焦，可维护性显著提升。
3. **风险可控**：均衡器文件自底部自初始化（保留原 try/catch），player.js 底部 init 删除这两句调用即可，不改变执行时机与顺序（均在 DOM 就绪后、脚本末尾执行）。

**不进一步拆分虚拟滚动/元数据预加载的理由**：这两块与 `state.playlist`、`state.currentIndex`、`renderPlaylist`、`playAt` 深度耦合，强行拆分会引入大量全局共享，得不偿失。保留在 player.js 内做内部整理（提取常量、补注释）即可。

**新文件**：
- `E:\MusicPlayer\player-equalizer.js`（新增）
  - 内容：`eqState` 常量 + `initEqualizer` / `setEQGain` / `applyEQPreset` / `updateEQDisplay` / `toggleEQ` / `openEqualizer` / `closeEqualizer` / `startEQVisualizer` / `stopEQVisualizer` / `bindEqualizerEvents` + 模块级变量 `eqVisualizerId` / `eqAnalyser` + 底部自初始化 try/catch 块。
  - 自取 `audio` DOM 引用：`const audio = document.getElementById('audio-engine');`（与 player.js 指向同一节点，互不冲突）。
  - 不依赖 player.js 任何全局变量/函数。

**依赖关系**：
- `player-equalizer.js` ←（无依赖，自初始化）
- `player.js` ←（不再调用 EQ 函数，无依赖）
- 两者加载顺序不敏感（均自包含）。为逻辑清晰，建议在 `index.html` 中把 `player-equalizer.js` 置于 `player.js` 之前。

**需同步更新的配置**：
- `index.html` L339 前插入 `<script src="player-equalizer.js"></script>`
- `package.json` `build.files` 数组追加 `"player-equalizer.js"`

> **保守替代方案**（若主理人/工程师评估拆分风险过高）：不新增文件，仅在 player.js 内部用 `// ============ 均衡器 ============` 分节注释 + 提取常量做整理。本方案默认采用拆分方案。

---

## 3. 文件列表

### 3.1 将变更的文件
| 相对路径 | 变更类型 | 涉及任务 |
|---|---|---|
| `preload.js` | 修改（补 JSDoc + 分组注释） | T2 |
| `main.js` | 修改（提取常量、拆分 saveBatch/sendOpenFiles、JSDoc） | T3 |
| `transcoder.js` | 修改（拆分 startTranscode、抽 sanitizeBaseName、JSDoc） | T4 |
| `player.js` | 修改（移除 EQ 代码、提取音量辅助与常量、JSDoc） | T5b |
| `index.html` | 修改（L339 前新增 1 个 script 标签） | T6 |
| `package.json` | 修改（`build.files` 追加 `player-equalizer.js`） | T6 |

### 3.2 新增文件
| 相对路径 | 说明 | 涉及任务 |
|---|---|---|
| `player-equalizer.js` | 从 player.js 拆出的均衡器模块（约 200 行） | T5a |
| `_backup_refactor/main.js` | 原文件备份 | T1 |
| `_backup_refactor/player.js` | 原文件备份 | T1 |
| `_backup_refactor/transcoder.js` | 原文件备份 | T1 |
| `_backup_refactor/preload.js` | 原文件备份 | T1 |
| `REFACTOR_PLAN.md` | 本方案文档（已生成） | — |

### 3.3 明确不动的文件
- `style.css`
- `scripts/generate_icon.py`
- `android/`（Capacitor 工程，整目录）
- `assets/`
- `build.bat`
- `installer.nsh`
- `set-default.bat`
- `index.html` 中除新增 1 个 script 标签外的所有内容（DOM 结构、`<script type="module">` FFmpegLib 加载器、现有 script 标签顺序中 player.js/transcoder.js 的相对顺序保持不变）

---

## 4. 任务列表（按实现顺序，含依赖）

### T1：备份原文件
- **涉及文件**：新建 `E:\MusicPlayer\_backup_refactor\` 目录，拷入 `main.js` / `player.js` / `transcoder.js` / `preload.js` 四个文件
- **具体做什么**：创建备份目录，将 4 个核心 JS 原样复制进去（保留原始时间戳与内容），作为重构失败的回滚锚点
- **依赖**：无
- **优先级**：P0

### T2：重构 preload.js（最小，热身）
- **涉及文件**：`preload.js`
- **具体做什么**：
  1. 为 `contextBridge.exposeInMainWorld` 的每个成员补 JSDoc（参数、返回值、对应 IPC channel）
  2. 用分组注释把 API 分为「对话框」「文件读写」「事件监听」「工具」四组
  3. **不改任何 API 名称、参数签名、IPC channel 名**（契约铁律）
- **依赖**：T1
- **优先级**：P1

### T3：重构 main.js
- **涉及文件**：`main.js`
- **具体做什么**：
  1. 在文件顶部（require 之后）新增常量：`SUPPORTED_AUDIO_EXTENSIONS`（数组）、`AUDIO_EXT_SET`（派生 Set）、`AUDIO_DIALOG_FILTERS`（对话框过滤器）
  2. 将 L99/L175 的过滤器字面量、L191/L210 的 Set 字面量替换为上述常量引用
  3. 提取 `sendOpenFiles(files)` 辅助函数，替换 L70/L315/L340 三处 `mainWindow.webContents.send('open-files', ...)`
  4. 从 `file:saveBatch` 处理器（L230-301）抽出 `createZipArchive(files, zipPath)` 辅助函数，handler 精简为「选路径→调用打包→返回结果」
  5. 为 `extractFilesFromArgs` / `createWindow` / `buildMenu` 及各 IPC handler 补 JSDoc
  6. **不改任何 IPC channel 名、命令行参数解析逻辑、COOP/COEP 头、菜单 accelerator 与 click 行为**
- **依赖**：T1
- **优先级**：P0

### T4：重构 transcoder.js
- **涉及文件**：`transcoder.js`
- **具体做什么**：
  1. 从 `safeName` / `safeOutputName`（L86-100）抽出共用 `sanitizeBaseName(name)`（返回截断后的安全 base），两个函数改为调用它 + 加前缀
  2. 从 `startTranscode`（L397-491）抽出 `transcodeOne(task, params, ffmpeg)`，承载单文件转码循环体；`startTranscode` 精简为任务创建 + 循环调度 + 按钮状态
  3. 为 `loadFFmpeg` / `makeBlobURL` / `buildArgs` / `buildAtempo` / `readSourceBytes` / `transcodeOne` / `batchExportAll` 补 JSDoc
  4. （可选）将 `batchExportAll` 中 6 条 `console.log('[BatchExport]...')` 收敛为 1 条受 `const DEBUG_BATCH = false` 开关控制的输出；若主理人要求零行为差异则跳过
  5. **不改 FFmpegLib 事件名、`tcState` 字段名、DOM id、`FORMAT_CONFIG` 结构、FFmpeg 命令参数构造逻辑、CDN 地址**
- **依赖**：T1
- **优先级**：P0

### T5a：从 player.js 拆出均衡器到 player-equalizer.js
- **涉及文件**：新建 `player-equalizer.js`；修改 `player.js`（删除 EQ 段）
- **具体做什么**：
  1. 新建 `player-equalizer.js`，文件头注释说明来源与职责
  2. 迁移以下内容（原样搬运，不改逻辑）：`eqState` 常量（L30-48）、`initEqualizer` / `setEQGain` / `applyEQPreset` / `updateEQDisplay` / `toggleEQ` / `openEqualizer` / `closeEqualizer` / `startEQVisualizer` / `stopEQVisualizer` / `bindEqualizerEvents`（L716-917）、模块级变量 `eqVisualizerId` / `eqAnalyser`（L823-824）
  3. 在新文件内自取 `const audio = document.getElementById('audio-engine');`（替代原 player.js 的全局 `audio` 引用）
  4. 在新文件底部迁移原 player.js L931-936 的 EQ 自初始化 try/catch 块（`initEqualizer(); bindEqualizerEvents();`）
  5. 从 `player.js` 删除上述已迁移的代码段（L30-48 的 eqState、L716-917 的 EQ 函数、L823-824 变量、L931-936 的 EQ init 调用）
  6. **校验**：player.js 中除底部 init 外无任何对 EQ 函数的引用（确认 playAt/onCommand 等均不调用 EQ），保证删除后无悬挂引用
- **依赖**：T1
- **优先级**：P0

### T5b：重构 player.js 核心
- **涉及文件**：`player.js`
- **具体做什么**：
  1. 新增常量：`VOLUME_STEP=0.05` / `SEEK_STEP=5` / `METADATA_TIMEOUT_MS=5000` / `PRELOAD_RANGE=3` / `DEFAULT_VOLUME=0.8` / `VOL_ICON_LOW=0.3` / `VOL_ICON_MID=0.7`
  2. 提取 `applyVolume(value)` 与 `adjustVolume(delta)` 辅助函数，替换 L587-591 / L609-611 / L622-627 / L628-633 / L697-698 共 6 处音量四步操作
  3. `loadTrackMetadata` 的 `setTimeout(...,5000)` 改用 `METADATA_TIMEOUT_MS`；`preloadMetadata` 的 `PRELOAD_RANGE=3` 改用常量
  4. 为 `formatTime` / `getExt` / `getBaseName` / `loadFiles` / `playAt` / `togglePlay` / `playNext` / `playPrev` / `loadTrackMetadata` / `renderVisibleItems` 等补 JSDoc
  5. 在 `updateBgColor`（L423-434）补注释说明正则提取渐变色 hex 的意图
  6. 在 `audio._prevVol`（L602）处补注释：「静音前音量缓存，DOM 运行时属性」
  7. **不改任何 DOM id 引用、`state` 字段名、`FORMAT_MIME` 内容、播放/随机/循环逻辑、事件监听器行为**
- **依赖**：T5a
- **优先级**：P0

### T6：同步 index.html 与 package.json
- **涉及文件**：`index.html`、`package.json`
- **具体做什么**：
  1. `index.html`：在现有 `<script src="player.js"></script>`（L339）**之前**插入 `<script src="player-equalizer.js"></script>`；不改动 `<script type="module">`（L296 FFmpegLib 加载器）与 `<script src="transcoder.js">`（L340）
  2. `package.json`：在 `build.files` 数组中追加 `"player-equalizer.js"`（建议置于 `"player.js"` 之后）
  3. **校验**：三个 script 标签加载顺序为 `player-equalizer.js` → `player.js` → `transcoder.js`，符合各自依赖
- **依赖**：T5a
- **优先级**：P0

### T7：全局一致性审查
- **涉及文件**：全部 4 个核心 JS + player-equalizer.js + index.html + package.json
- **具体做什么**：
  1. 全文搜索确认第 5 节「不可变更契约」中列出的所有名称仍 1:1 存在（IPC channel、preload API、DOM id、命令字符串、事件名、`loadFiles` 全局、`window.electronAPI` / `window.FFmpegLib`）
  2. 启动应用（`npm run dev`）逐项验证：打开文件/文件夹、播放/暂停/上下首、随机/循环、音量±/静音、进度条拖拽、键盘快捷键、拖拽入窗、均衡器开关/预设/滑块/可视化、转码加载FFmpeg/单文件转码/下载/导入/批量导出、文件关联启动、单实例二次打开
  3. 对比 `_backup_refactor/` 原文件，确认无功能行为差异
  4. 检查浏览器控制台与主进程控制台无新增报错
- **依赖**：T2、T3、T4、T5b、T6
- **优先级**：P0

---

## 5. 共享约定（跨文件，铁律）

### 5.1 命名规范
- **变量/函数**：camelCase（与现有代码一致）
- **常量**：UPPER_SNAKE_CASE（如 `SUPPORTED_AUDIO_EXTENSIONS`、`VOLUME_STEP`）
- **IPC channel**：`命名空间:动作` 格式（如 `dialog:openFile`、`file:read`），**保持现有命名不变**
- **菜单命令字符串**：小写驼峰（`togglePlay` / `prev` / `next` / `volUp` / `volDown` / `openTranscode`），**不变**
- **自定义事件**：kebab-case（`open-files` / `open-folder` / `ffmpeglib-ready` / `ffmpeglib-error`），**不变**

### 5.2 注释规范
- **文件头**：每个 `.js` 文件保留/补全文件头块注释（文件名、职责、关键依赖）
- **函数 JSDoc**：所有对外/跨模块函数补 `/** ... */`，含 `@param` / `@returns` / 复杂逻辑说明
- **分节**：沿用现有 `// ============ 标题 ============` 风格的分节注释
- **复杂逻辑块**：正则、位运算、音频图连接、FFmpeg 命令构造等处补行内注释

### 5.3 不可变更的契约（重构时名称/值必须 1:1 保留，否则破坏运行时行为）

#### IPC channel 名（main.js ↔ preload.js ↔ 渲染进程）
- `dialog:openFile`、`dialog:openFolder`
- `file:read`、`file:readDir`、`file:save`、`file:saveBatch`
- `open-files`、`open-folder`、`cmd`

#### preload 通过 contextBridge 暴露的 API 名（`window.electronAPI.*`）
- `isElectron`、`openFile`、`openFolder`、`readFile`、`saveFile`、`saveFilesAsZip`、`readDir`、`onOpenFiles`、`onOpenFolder`、`onCommand`、`getFileURL`
- `saveFile(defaultName, buffer)` 与 `saveFilesAsZip(files)` 的参数结构（`{defaultName, buffer}` / `{files}`）不变

#### DOM 元素 id（player.js / player-equalizer.js / transcoder.js ↔ index.html）
- 播放器：`audio-engine`、`cover`、`track-title`、`track-artist`、`track-format`、`current-time`、`total-time`、`progress-fill`、`progress-thumb`、`progress-bar-wrap`、`volume`、`vol-value`、`vol-icon`、`btn-play`、`btn-prev`、`btn-next`、`btn-mode`、`btn-shuffle`、`playlist`、`track-count`、`file-input`、`folder-input`、`btn-open-file`、`btn-open-folder`、`bg-blur`
- 均衡器：`equalizer-overlay`、`btn-equalizer`、`btn-close-equalizer`、`btn-eq-toggle`、`eq-preset`、`eq-canvas`
- 转码：`transcode-overlay`、`btn-transcode`、`btn-close-transcode`、`ffmpeg-status`、`ffmpeg-status-text`、`btn-load-ffmpeg`、`tc-drop-zone`、`tc-file-input`、`tc-file-list`、`tc-format`、`tc-bitrate`、`tc-samplerate`、`tc-channels`、`tc-volume`、`tc-speed`、`btn-start-transcode`、`tc-tasks`、`tc-log`、`row-bitrate`、`tc-batch-actions`、`btn-batch-export`、`tc-batch-count`

#### DOM class（与 style.css 契约）
- `playlist-item`、`active`、`spinning`、`spinning-paused`、`playlist-scroll-container`、`playlist-empty`、`playlist-item-num/info/title/meta/dur`
- `eq-slider-vertical`、`eq-slider`、`eq-band`、`eq-db`
- `tc-file-item/name/size/remove`、`tc-file-empty`、`tc-task`、`tc-task-pending/working/done/error`、`tc-task-info/name/status/bar-wrap/bar/fill/pct/error/actions`、`tc-btn-dl`、`tc-btn-import`、`tc-empty`、`tc-toast`、`drag-over`
- `hidden`（显隐切换契约）

#### DOM 属性 / data 契约
- `data-index`（播放列表项与 EQ band 均用）
- `audio._prevVol`（静音前音量缓存，运行时属性）
- track 对象字段：`name`、`ext`、`url`、`duration`、`color`、`localPath`、`_metadataLoaded`、`_metadataLoading`

#### 命令字符串 / 事件名
- 菜单命令：`togglePlay`、`prev`、`next`、`volUp`、`volDown`、`openTranscode`
- 自定义事件：`ffmpeglib-ready`（`e.detail` 为错误信息）、`ffmpeglib-error`

#### 全局对象 / 全局函数
- `window.electronAPI`（preload 暴露）
- `window.FFmpegLib`（`<script type="module">` 注入，含 `FFmpeg` / `toBlobURL`）
- `loadFiles`（全局函数，transcoder.js 的 `importTaskToPlaylist` 通过 `typeof loadFiles === 'function'` 调用）— **player.js 必须保持 `loadFiles` 为全局函数声明，不得改为模块内私有**

#### 文件关联 / 命令行
- `extractFilesFromArgs` 的切片逻辑：`argv.slice(app.isPackaged ? 1 : 2)`
- `--dev` 参数触发 DevTools
- macOS `open-file` 事件协议
- `getFileURL` 的 `file:///` + 反斜杠转正斜杠格式

#### localStorage / 设置项 key
- 经核查，4 个核心文件**未使用 localStorage 或任何持久化设置**。无需保留任何 key。（若 index.html 内有 localStorage 使用，不在本次改动范围）

#### 与 Android/Capacitor 交互
- 本次重构不涉及 `android/` 目录；`package.json` 中 Capacitor 依赖版本不变。

---

## 6. 待明确事项

1. **transcoder.js 调试日志**：`batchExportAll` 中 6 条 `console.log('[BatchExport]...')` 是否允许收敛/移除？它们不影响功能行为，仅污染控制台。默认建议收敛为受 `DEBUG_BATCH` 开关控制；若主理人要求「控制台输出也属行为、必须 1:1 保留」，则 T4 第 4 步跳过。

2. **`getMime`（player.js）与 `getMimeByExt`（transcoder.js）的跨文件去重**：两者各自维护音频 MIME 表，内容不完全一致（player 的 `FORMAT_MIME` 含 oga/mp4/alac/3gp，transcoder 的 map 仅含 7 种输出格式）。由于二者处于不同 `<script>`、无构建步骤、用途不同（一个是播放兼容性判断，一个是转码输出 Blob 类型），**不建议强行合并**（合并需引入共享文件 + 改 index.html 加载顺序，风险收益比低）。本方案保持两份独立，仅补注释说明差异。请主理人确认是否接受。

3. **`<script type="module">`（index.html L296）的来源未读**：根据 transcoder.js 监听的 `ffmpeglib-ready` / `ffmpeglib-error` 事件推断其为 FFmpegLib CDN 加载器，但未读取其内容。本次重构不改动它。若该模块的加载时序与 player-equalizer.js 的自初始化存在潜在冲突（理论上无，因 EQ init 不依赖 FFmpegLib），请在 T7 审查时一并验证。

4. **player-equalizer.js 加载顺序的最终确认**：本方案建议置于 player.js 之前。由于 player-equalizer.js 完全自包含、自初始化，置于 player.js 之后亦可正常运行。若工程师在 T6 中发现任何加载时序问题（如 EQ 面板按钮在 player.js 某处被引用），可调整为之后加载并复查。请主理人知悉此灵活性。

5. **是否需要为重构后的代码补充单元测试**：本次任务范围仅为「重构不改行为」，未提及测试。若主理人希望补测试，请另行安排（当前项目无测试框架）。

---

*本方案已写入 `E:\MusicPlayer\REFACTOR_PLAN.md`，等待主理人审阅与工程师执行。*
