/**
 * transcoder.js - FFmpeg.wasm 转码模块（修复版）
 *
 * 职责：
 *   - 等待 FFmpegLib 就绪（监听 ffmpeglib-ready / ffmpeglib-error 事件）
 *   - 懒加载 FFmpeg Core（多 CDN 回退）
 *   - 管理源文件列表、转码参数构建、任务队列渲染
 *   - 逐文件转码（读取字节 → 写虚拟 FS → 执行 FFmpeg → 读输出 → 清理）
 *   - 下载 / 导入播放列表 / 批量导出 ZIP
 *
 * 修复历史：
 *   1. FFmpegLib 加载时序（等待 ffmpeglib-ready 事件）
 *   2. 文件名特殊字符（统一使用安全文件名）
 *   3. Electron 本地路径文件转码（通过 IPC 读取文件字节）
 *   4. CDN 不可用自动回退
 */

'use strict';

// ============================================================
// 状态
// ============================================================
const tcState = {
  ffmpeg: null,
  isLoaded: false,
  isLoading: false,
  sourceFiles: [],   // { name, size, file: File | null, localPath: string | null }
  tasks: [],
  taskIdCounter: 0,
  currentTaskId: null,
  libReady: false,   // FFmpegLib 是否已挂载
};

// ============================================================
// 监听 FFmpegLib 就绪事件
// ============================================================
if (window.FFmpegLib) {
  tcState.libReady = true;
} else {
  window.addEventListener('ffmpeglib-ready', () => {
    tcState.libReady = true;
    setStatus('loading', 'FFmpeg 库已就绪，点击"加载 FFmpeg"初始化引擎...');
    btnLoadFFmpeg.disabled = false;
    console.log('[Transcoder] FFmpegLib 就绪');
  });
  window.addEventListener('ffmpeglib-error', (e) => {
    setStatus('error', `❌ FFmpeg 库加载失败: ${e.detail}（请检查网络）`);
  });
}

// ============================================================
// DOM
// ============================================================
const tcOverlay      = document.getElementById('transcode-overlay');
const btnTranscode   = document.getElementById('btn-transcode');
const btnCloseTC     = document.getElementById('btn-close-transcode');
const ffmpegStatus   = document.getElementById('ffmpeg-status');
const ffmpegStatusTx = document.getElementById('ffmpeg-status-text');
const btnLoadFFmpeg  = document.getElementById('btn-load-ffmpeg');
const tcDropZone     = document.getElementById('tc-drop-zone');
const tcFileInput    = document.getElementById('tc-file-input');
const tcFileList     = document.getElementById('tc-file-list');
const tcFormatSel    = document.getElementById('tc-format');
const tcBitrateSel   = document.getElementById('tc-bitrate');
const tcSampleSel    = document.getElementById('tc-samplerate');
const tcChannelSel   = document.getElementById('tc-channels');
const tcVolumeInput  = document.getElementById('tc-volume');
const tcSpeedInput   = document.getElementById('tc-speed');
const btnStart       = document.getElementById('btn-start-transcode');
const tcTasksEl      = document.getElementById('tc-tasks');
const tcLogEl        = document.getElementById('tc-log');
const rowBitrate     = document.getElementById('row-bitrate');
const tcBatchActions = document.getElementById('tc-batch-actions');
const btnBatchExport = document.getElementById('btn-batch-export');
const tcBatchCount   = document.getElementById('tc-batch-count');

// ============================================================
// 格式→编码器映射
// ============================================================
const FORMAT_CONFIG = {
  mp3:  { codec: 'libmp3lame', ext: 'mp3',  hasBitrate: true  },
  flac: { codec: 'flac',       ext: 'flac', hasBitrate: false },
  wav:  { codec: 'pcm_s16le',  ext: 'wav',  hasBitrate: false },
  ogg:  { codec: 'libvorbis',  ext: 'ogg',  hasBitrate: true  },
  aac:  { codec: 'aac',        ext: 'aac',  hasBitrate: true  },
  opus: { codec: 'libopus',    ext: 'opus', hasBitrate: true  },
  m4a:  { codec: 'aac',        ext: 'm4a',  hasBitrate: true  },
};

// ============================================================
// 工具：生成安全文件名（只保留 ASCII 字母数字+下划线）
// ============================================================
let _fileCounter = 0;

/**
 * 从原始文件名中提取安全 base 名：去扩展名 → 仅保留 [a-zA-Z0-9_-] → 截断 40 字符。
 * safeName 与 safeOutputName 共用此逻辑，仅前缀不同。
 * @param {string} originalName - 原始文件名（可能含扩展名和特殊字符）
 * @returns {string} 安全 base 名（不含扩展名，最长 40 字符）
 */
function sanitizeBaseName(originalName) {
  // 去掉原扩展名
  const base = originalName.replace(/\.[^.]+$/, '');
  // 只保留安全字符，其余替换为下划线
  return base.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 40);
}

/**
 * 生成输入文件的安全名（用于写入虚拟 FS）。
 * @param {string} originalName - 原始文件名
 * @param {string} ext - 文件扩展名
 * @returns {string} 形如 `input_1_safe_name.mp3`
 */
function safeName(originalName, ext) {
  const safe = sanitizeBaseName(originalName);
  const id = ++_fileCounter;
  return `input_${id}_${safe}.${ext}`;
}

/**
 * 生成输出文件的安全名（复用当前计数器值，与对应的 safeName 配对）。
 * @param {string} originalName - 原始文件名
 * @param {string} outputExt - 输出扩展名
 * @returns {string} 形如 `out_1_safe_name.mp3`
 */
function safeOutputName(originalName, outputExt) {
  const safe = sanitizeBaseName(originalName);
  const id = _fileCounter;
  return `out_${id}_${safe}.${outputExt}`;
}

// ============================================================
// FFmpeg 初始化（懒加载）
// ============================================================
const CDN_CORES = {
  single: {
    base: [
      'https://cdn.npmmirror.com/packages/@ffmpeg/core/0.12.10/files/dist/esm',
      'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm',
    ],
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm'],
  },
  multi: {
    base: [
      'https://cdn.npmmirror.com/packages/@ffmpeg/core-mt/0.12.10/files/dist/esm',
      'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm',
    ],
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'],
  },
};

/**
 * 依次尝试多个 CDN 基址，将远程文件转为 Blob URL。
 * @param {Function} toBlobURL - @ffmpeg/util 的 toBlobURL 函数
 * @param {string[]} bases - CDN 基址数组
 * @param {string} filename - 要加载的文件名
 * @param {string} type - MIME 类型（如 'text/javascript' / 'application/wasm'）
 * @returns {Promise<string>} Blob URL
 * @throws {Error} 所有 CDN 均不可用时抛出
 */
async function makeBlobURL(toBlobURL, bases, filename, type) {
  for (const base of bases) {
    try {
      const url = `${base}/${filename}`;
      appendLog(`尝试加载: ${url}`);
      const blobUrl = await toBlobURL(url, type);
      return blobUrl;
    } catch (e) {
      appendLog(`  失败，切换 CDN... (${e.message})`);
    }
  }
  throw new Error(`无法加载 ${filename}，所有 CDN 均不可用`);
}

/**
 * 懒加载 FFmpeg Core（支持多线程 / 单线程，多 CDN 回退）。
 * 加载成功后设置 tcState.ffmpeg / isLoaded，并更新 UI。
 * @returns {Promise<boolean>} 是否加载成功（已加载时直接返回 true）
 */
async function loadFFmpeg() {
  if (tcState.isLoaded) return true;
  if (tcState.isLoading) return false;

  if (!tcState.libReady || !window.FFmpegLib) {
    setStatus('error', '❌ FFmpeg 库尚未就绪，请等待页面加载完成或检查网络');
    return false;
  }

  tcState.isLoading = true;
  btnLoadFFmpeg.disabled = true;
  btnLoadFFmpeg.textContent = '⏳ 加载中...';

  const canMT = typeof SharedArrayBuffer !== 'undefined';
  const coreSet = canMT ? CDN_CORES.multi : CDN_CORES.single;

  setStatus('loading', `⏳ 正在下载 FFmpeg Core（${canMT ? '多线程' : '单线程'}，约 31 MB）...`);

  try {
    const { FFmpeg, toBlobURL } = window.FFmpegLib;
    const ffmpeg = new FFmpeg();

    ffmpeg.on('log', ({ message }) => {
      appendLog(message);
    });

    ffmpeg.on('progress', ({ progress }) => {
      if (tcState.currentTaskId != null) {
        const pct = Math.min(99, Math.round(progress * 100));
        updateTaskProgress(tcState.currentTaskId, pct);
      }
    });

    const coreURL   = await makeBlobURL(toBlobURL, coreSet.base, 'ffmpeg-core.js',   'text/javascript');
    const wasmURL   = await makeBlobURL(toBlobURL, coreSet.base, 'ffmpeg-core.wasm', 'application/wasm');
    const loadOpts  = { coreURL, wasmURL };

    if (canMT) {
      loadOpts.workerURL = await makeBlobURL(toBlobURL, coreSet.base, 'ffmpeg-core.worker.js', 'text/javascript');
    }

    await ffmpeg.load(loadOpts);

    tcState.ffmpeg    = ffmpeg;
    tcState.isLoaded  = true;
    tcState.isLoading = false;

    setStatus('ready', `✅ FFmpeg 引擎就绪（${canMT ? '多线程' : '单线程'}）`);
    btnLoadFFmpeg.style.display = 'none';
    updateStartBtn();
    return true;

  } catch (err) {
    tcState.isLoading = false;
    console.error('[FFmpeg] 加载失败', err);
    setStatus('error', `❌ 加载失败: ${err.message}`);
    btnLoadFFmpeg.disabled = false;
    btnLoadFFmpeg.textContent = '🔄 重试加载';
    return false;
  }
}

function setStatus(type, text) {
  ffmpegStatus.className = 'ffmpeg-status ' + type;
  ffmpegStatusTx.textContent = text;
}

// ============================================================
// 源文件管理
// ============================================================
const AUDIO_EXTS = new Set(['mp3','flac','wav','ogg','aac','m4a','opus','webm','wma','ape','aiff','aif']);

function addSourceFiles(files) {
  for (const f of files) {
    // f 可以是 File 对象，也可以是本地路径字符串（Electron 播放列表拖入）
    if (typeof f === 'string') {
      const name = f.replace(/\\/g, '/').split('/').pop();
      const ext  = name.split('.').pop().toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;
      const size = 0; // 路径模式下暂不知道大小
      if (tcState.sourceFiles.find(sf => sf.localPath === f)) continue;
      tcState.sourceFiles.push({ name, size, file: null, localPath: f, ext });
    } else {
      const ext = f.name.split('.').pop().toLowerCase();
      if (!AUDIO_EXTS.has(ext) && !f.type.startsWith('audio/')) continue;
      if (tcState.sourceFiles.find(sf => sf.name === f.name && sf.size === f.size)) continue;
      tcState.sourceFiles.push({ name: f.name, size: f.size, file: f, localPath: null, ext });
    }
  }
  renderSourceFiles();
  updateStartBtn();
}

function renderSourceFiles() {
  tcFileList.innerHTML = '';
  if (tcState.sourceFiles.length === 0) {
    tcFileList.innerHTML = '<li class="tc-file-empty">未选择文件</li>';
    return;
  }
  tcState.sourceFiles.forEach((sf, i) => {
    const li = document.createElement('li');
    li.className = 'tc-file-item';
    const sizeTxt = sf.size > 0 ? (sf.size / 1024 / 1024).toFixed(2) + ' MB' : '本地文件';
    li.innerHTML = `
      <span class="tc-file-name" title="${sf.name}">${sf.name}</span>
      <span class="tc-file-size">${sizeTxt}</span>
      <button class="tc-file-remove" data-i="${i}">✕</button>
    `;
    li.querySelector('.tc-file-remove').addEventListener('click', () => {
      tcState.sourceFiles.splice(i, 1);
      renderSourceFiles();
      updateStartBtn();
    });
    tcFileList.appendChild(li);
  });
}

// ============================================================
// 转码参数
// ============================================================
function getParams() {
  const format     = tcFormatSel.value;
  const config     = FORMAT_CONFIG[format];
  const bitrate    = tcBitrateSel.value;
  const samplerate = tcSampleSel.value;
  const channels   = tcChannelSel.value;
  const volumeDB   = parseFloat(tcVolumeInput.value) || 0;
  const speed      = parseFloat(tcSpeedInput.value) || 1.0;
  return { format, config, bitrate, samplerate, channels, volumeDB, speed };
}

// ============================================================
// 构建 FFmpeg 命令
// ============================================================

/**
 * 根据转码参数构建 FFmpeg 命令行参数数组。
 * @param {string} inputName - 虚拟 FS 中的输入文件名
 * @param {string} outputName - 虚拟 FS 中的输出文件名
 * @param {object} params - 转码参数（含 config/bitrate/samplerate/channels/volumeDB/speed）
 * @returns {string[]} FFmpeg 命令参数数组
 */
function buildArgs(inputName, outputName, params) {
  const { config, bitrate, samplerate, channels, volumeDB, speed } = params;
  const args = ['-i', inputName];

  // 忽略视频/封面图流（含封面的 FLAC/MP3 会卡在图片转换上）
  args.push('-vn');

  args.push('-c:a', config.codec);

  if (config.hasBitrate) {
    args.push('-b:a', bitrate);
  }

  args.push('-ar', samplerate);
  args.push('-ac', channels);

  const filters = [];
  if (volumeDB !== 0) {
    filters.push(`volume=${volumeDB}dB`);
  }
  if (Math.abs(speed - 1.0) > 0.01) {
    filters.push(...buildAtempo(speed));
  }
  if (filters.length > 0) {
    args.push('-af', filters.join(','));
  }

  // 避免挂起：不读 stdin
  args.push('-nostdin');
  args.push('-y', outputName);
  return args;
}

/**
 * 构建 atempo 滤镜链（FFmpeg atempo 单次范围 0.5~2.0，超出需链式拆分）。
 * @param {number} speed - 目标速度倍率
 * @returns {string[]} atempo 滤镜字符串数组
 */
function buildAtempo(speed) {
  const result = [];
  let s = speed;
  while (s > 2.0) { result.push('atempo=2.0'); s /= 2.0; }
  while (s < 0.5) { result.push('atempo=0.5'); s *= 2.0; }
  result.push(`atempo=${s.toFixed(4)}`);
  return result;
}

// ============================================================
// 读取文件字节（兼容 File 对象 和 Electron 本地路径）
// ============================================================

/**
 * 读取源文件字节（浏览器 File 对象或 Electron 本地路径）。
 * @param {{file: File|null, localPath: string|null, name: string}} sf - 源文件对象
 * @returns {Promise<Uint8Array>} 文件字节数组
 * @throws {Error} 无法读取文件时抛出
 */
async function readSourceBytes(sf) {
  if (sf.file) {
    // 浏览器 File 对象
    return new Uint8Array(await sf.file.arrayBuffer());
  } else if (sf.localPath && window.electronAPI) {
    // Electron 本地路径：通过 IPC 读取
    const buf = await window.electronAPI.readFile(sf.localPath);
    return new Uint8Array(buf);
  }
  throw new Error(`无法读取文件: ${sf.name}`);
}

// ============================================================
// 任务渲染
// ============================================================
function renderTasks() {
  tcTasksEl.innerHTML = '';
  if (tcState.tasks.length === 0) {
    tcTasksEl.innerHTML = '<div class="tc-empty">暂无转码任务</div>';
    tcBatchActions.classList.add('hidden');
    return;
  }

  // 更新批量导出按钮状态
  const doneCount = tcState.tasks.filter(t => t.status === 'done' && t.outputBlob).length;
  if (doneCount > 0) {
    tcBatchActions.classList.remove('hidden');
    tcBatchCount.textContent = `(${doneCount} 个文件可导出)`;
  } else {
    tcBatchActions.classList.add('hidden');
  }

  tcState.tasks.slice().reverse().forEach(task => {
    const div = document.createElement('div');
    div.className = `tc-task tc-task-${task.status}`;
    div.id = `tc-task-${task.id}`;

    const actionBtn = task.status === 'done'
      ? `<button class="tc-btn-dl" data-id="${task.id}">⬇️ 下载</button>
         <button class="tc-btn-import" data-id="${task.id}">▶ 导入播放</button>`
      : '';

    div.innerHTML = `
      <div class="tc-task-info">
        <span class="tc-task-name" title="${task.displayName}">${task.displayName}</span>
        <span class="tc-task-status ${task.status}">${statusLabel(task.status)}</span>
      </div>
      <div class="tc-task-bar-wrap" style="${task.status === 'working' ? '' : 'display:none'}">
        <div class="tc-task-bar">
          <div class="tc-task-fill" style="width:${task.progress}%"></div>
        </div>
        <span class="tc-task-pct">${task.progress}%</span>
      </div>
      ${task.error ? `<div class="tc-task-error">${task.error}</div>` : ''}
      <div class="tc-task-actions">${actionBtn}</div>
    `;

    div.querySelector('.tc-btn-dl')?.addEventListener('click', () => downloadTask(task.id));
    div.querySelector('.tc-btn-import')?.addEventListener('click', () => importTaskToPlaylist(task.id));
    tcTasksEl.appendChild(div);
  });
}

function statusLabel(s) {
  return { pending:'⏳ 等待', working:'⚙️ 转码中', done:'✅ 完成', error:'❌ 失败' }[s] || s;
}

function updateTaskProgress(id, pct) {
  const task = tcState.tasks.find(t => t.id === id);
  if (!task) return;
  task.progress = pct;
  const el = document.getElementById(`tc-task-${id}`);
  if (!el) return;
  const fill  = el.querySelector('.tc-task-fill');
  const pctEl = el.querySelector('.tc-task-pct');
  if (fill)  fill.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
}

// ============================================================
// 核心转码流程
// ============================================================

/**
 * 转码单个文件：读取字节 → 写虚拟 FS → 执行 FFmpeg → 读输出 → 清理。
 * 直接更新传入的 task 对象的 status/progress/outputBlob/outputUrl/error 字段。
 * @param {object} task - 任务对象（含 sf/displayName 等）
 * @param {object} params - 转码参数（来自 getParams()）
 * @param {object} ffmpeg - FFmpeg 实例
 * @returns {Promise<void>}
 */
async function transcodeOne(task, params, ffmpeg) {
  // 使用安全文件名（只含 ASCII 字母数字下划线）
  const inputFsName  = safeName(task.sf.name, task.sf.ext || task.sf.name.split('.').pop());
  const outputFsName = safeOutputName(task.sf.name, params.config.ext);

  try {
    appendLog(`\n===== 开始: ${task.sf.name} -> ${task.displayName} =====`);
    appendLog(`FS 输入名: ${inputFsName}`);
    appendLog(`FS 输出名: ${outputFsName}`);

    // 读取文件字节
    const bytes = await readSourceBytes(task.sf);
    appendLog(`文件大小: ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB`);

    // 写入虚拟 FS
    await ffmpeg.writeFile(inputFsName, bytes);

    // 构建命令并执行
    const args = buildArgs(inputFsName, outputFsName, params);
    appendLog(`命令: ffmpeg ${args.join(' ')}`);

    const ret = await ffmpeg.exec(args);
    if (ret !== 0) throw new Error(`FFmpeg 退出码: ${ret}`);

    // 读取输出
    const data = await ffmpeg.readFile(outputFsName);
    const mime = getMimeByExt(params.config.ext);
    const blob = new Blob([data.buffer], { type: mime });

    task.outputBlob = blob;
    task.outputUrl  = URL.createObjectURL(blob);
    task.status     = 'done';
    task.progress   = 100;

    // 清理虚拟 FS
    await ffmpeg.deleteFile(inputFsName).catch(() => {});
    await ffmpeg.deleteFile(outputFsName).catch(() => {});

    appendLog(`完成: ${task.displayName} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);

  } catch (err) {
    task.status = 'error';
    task.error  = err.message;
    appendLog(`失败: ${err.message}`);
    console.error('[FFmpeg] 转码失败', err);

    // 尝试清理
    try { await ffmpeg.deleteFile(inputFsName); } catch (_) {}
    try { await ffmpeg.deleteFile(outputFsName); } catch (_) {}
  }
}

/**
 * 启动转码流程：确保 FFmpeg 已加载 → 创建任务 → 逐文件调用 transcodeOne → 恢复按钮状态。
 * @returns {Promise<void>}
 */
async function startTranscode() {
  if (!tcState.isLoaded) {
    const ok = await loadFFmpeg();
    if (!ok) return;
  }
  if (tcState.sourceFiles.length === 0) return;

  const params = getParams();

  const newTasks = tcState.sourceFiles.map(sf => {
    const id = ++tcState.taskIdCounter;
    const baseName   = sf.name.replace(/\.[^.]+$/, '');
    const displayOut = `${baseName}_converted.${params.config.ext}`;
    return {
      id,
      sf,
      displayName: displayOut,   // 显示用（含原始名）
      status: 'pending',
      progress: 0,
      outputUrl: null,
      outputBlob: null,
      error: null,
    };
  });

  tcState.tasks.push(...newTasks);
  renderTasks();

  btnStart.disabled = true;
  btnStart.textContent = '⚙️ 转码中...';

  const ffmpeg = tcState.ffmpeg;

  for (const task of newTasks) {
    task.status = 'working';
    tcState.currentTaskId = task.id;
    renderTasks();

    await transcodeOne(task, params, ffmpeg);

    tcState.currentTaskId = null;
    renderTasks();
  }

  btnStart.disabled = false;
  btnStart.textContent = '⚙️ 开始转码';
}

/**
 * 根据输出扩展名查询 MIME 类型（用于构造转码输出的 Blob）。
 *
 * 注意：此 MIME 表与 player.js 中的 getMime（FORMAT_MIME）保持独立，
 * 因二者用途与加载方式不同（此处仅覆盖 7 种转码输出格式，
 * player.js 的 FORMAT_MIME 覆盖更多播放兼容格式），不合并。
 * @param {string} ext - 输出扩展名
 * @returns {string} MIME 类型；未知时返回 'audio/octet-stream'
 */
function getMimeByExt(ext) {
  const map = {
    mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav',
    ogg: 'audio/ogg',  aac:  'audio/aac',  opus: 'audio/ogg; codecs=opus',
    m4a: 'audio/mp4',
  };
  return map[ext] || 'audio/octet-stream';
}

// ============================================================
// 下载 / 导入播放列表 / 批量导出
// ============================================================

/**
 * 批量导出调试日志开关。设为 true 可在控制台输出详细的批量导出调试信息。
 * （按主理人决策：默认关闭，收敛控制台噪声，不影响功能行为。）
 */
const DEBUG_BATCH = false;

async function downloadTask(id) {
  const task = tcState.tasks.find(t => t.id === id);
  if (!task || !task.outputBlob) return;

  if (window.electronAPI && window.electronAPI.isElectron) {
    const buf    = await task.outputBlob.arrayBuffer();
    const saved  = await window.electronAPI.saveFile(task.displayName, buf);
    if (saved) showToast(`已保存: ${saved}`);
  } else {
    const a = document.createElement('a');
    a.href = task.outputUrl;
    a.download = task.displayName;
    a.click();
  }
}

/**
 * 批量导出所有已完成的转码任务。
 * Electron 环境：打包为 ZIP 后一次性保存。
 * 浏览器环境：逐个触发下载。
 */
async function batchExportAll() {
  const doneTasks = tcState.tasks.filter(t => t.status === 'done' && t.outputBlob);
  if (DEBUG_BATCH) console.log('[BatchExport] 可导出任务数:', doneTasks.length);
  if (doneTasks.length === 0) {
    showToast('没有可导出的转码文件');
    return;
  }

  // 检查 ZIP 打包 API 是否可用
  if (DEBUG_BATCH) {
    console.log('[BatchExport] electronAPI:', !!window.electronAPI);
    console.log('[BatchExport] isElectron:', window.electronAPI?.isElectron);
    console.log('[BatchExport] saveFilesAsZip:', !!window.electronAPI?.saveFilesAsZip);
  }

  if (window.electronAPI && window.electronAPI.isElectron && window.electronAPI.saveFilesAsZip) {
    // Electron 环境：打包为 zip 后一次性保存
    showToast(`正在打包 ${doneTasks.length} 个文件...`);

    // 构造文件列表
    const files = [];
    for (const task of doneTasks) {
      if (DEBUG_BATCH) console.log('[BatchExport] 处理文件:', task.displayName, 'Blob大小:', task.outputBlob?.size);
      const buffer = await task.outputBlob.arrayBuffer();
      files.push({
        name: task.displayName,
        buffer: buffer
      });
    }
    if (DEBUG_BATCH) console.log('[BatchExport] 准备发送', files.length, '个文件到主进程');

    const result = await window.electronAPI.saveFilesAsZip(files);
    if (DEBUG_BATCH) console.log('[BatchExport] 结果:', result);
    if (result.success) {
      showToast(`✅ 已保存: ${result.path} (${result.count} 个文件)`);
    } else {
      showToast('导出已取消或失败');
    }
  } else {
    // 浏览器环境：逐个触发下载
    for (const task of doneTasks) {
      const a = document.createElement('a');
      a.href = task.outputUrl;
      a.download = task.displayName;
      a.click();
      await new Promise(r => setTimeout(r, 200)); // 避免浏览器阻塞
    }
    showToast(`已触发 ${doneTasks.length} 个文件下载`);
  }
}

function importTaskToPlaylist(id) {
  const task = tcState.tasks.find(t => t.id === id);
  if (!task || !task.outputBlob) return;
  const file = new File([task.outputBlob], task.displayName, { type: task.outputBlob.type });
  if (typeof loadFiles === 'function') {
    loadFiles([file]);
    showToast(`"${task.displayName}" 已导入播放列表`);
  }
}

// ============================================================
// 日志面板
// ============================================================
function appendLog(msg) {
  tcLogEl.classList.remove('hidden');
  tcLogEl.textContent += msg + '\n';
  tcLogEl.scrollTop = tcLogEl.scrollHeight;
}

// ============================================================
// Toast 提示
// ============================================================
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'tc-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2500);
}

// ============================================================
// 格式选择→显隐比特率行
// ============================================================
tcFormatSel.addEventListener('change', () => {
  const cfg = FORMAT_CONFIG[tcFormatSel.value];
  rowBitrate.style.display = cfg.hasBitrate ? '' : 'none';
});

// ============================================================
// 按钮事件
// ============================================================
function updateStartBtn() {
  btnStart.disabled = !(tcState.sourceFiles.length > 0);
}

btnTranscode.addEventListener('click', () => {
  tcOverlay.classList.remove('hidden');
});

btnCloseTC.addEventListener('click', () => {
  tcOverlay.classList.add('hidden');
});

tcOverlay.addEventListener('click', e => {
  if (e.target === tcOverlay) tcOverlay.classList.add('hidden');
});

btnLoadFFmpeg.addEventListener('click', loadFFmpeg);

tcDropZone.addEventListener('click', () => tcFileInput.click());
tcFileInput.addEventListener('change', e => {
  addSourceFiles(Array.from(e.target.files));
  tcFileInput.value = '';
});

tcDropZone.addEventListener('dragover', e => { e.preventDefault(); tcDropZone.classList.add('drag-over'); });
tcDropZone.addEventListener('dragleave', () => tcDropZone.classList.remove('drag-over'));
tcDropZone.addEventListener('drop', e => {
  e.preventDefault();
  tcDropZone.classList.remove('drag-over');
  addSourceFiles(Array.from(e.dataTransfer.files));
});

btnStart.addEventListener('click', startTranscode);
btnBatchExport.addEventListener('click', batchExportAll);

// ============================================================
// 初始化
// ============================================================
renderSourceFiles();
renderTasks();
updateStartBtn();

// 初始状态：等待 FFmpegLib 就绪
if (!tcState.libReady) {
  btnLoadFFmpeg.disabled = true;
  setStatus('loading', '⏳ 等待 FFmpeg 库加载...');
}

console.log('[Transcoder] 转码模块已加载（修复版）');
