/**
 * transcoder.js - FFmpeg 转码模块（多平台支持）
 * 支持：
 *  1. 浏览器环境：FFmpeg.wasm
 *  2. Electron 环境：FFmpeg.wasm + IPC
 *  3. Android 环境：原生 FFmpeg Kit
 */

'use strict';

// ============================================================
// 平台检测
// ============================================================
const isAndroid = () => {
  return window.Capacitor && window.Capacitor.getPlatform() === 'android';
};

const isElectron = () => {
  return window.electronAPI && window.electronAPI.isElectron;
};

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
  isAndroid: false,  // 是否为 Android 环境
};

// ============================================================
// FFmpegLib 懒加载（浏览器/Electron 环境）
// 默认未就绪；仅在用户点击「加载 FFmpeg」或「开始转码」时才动态 import，
// 避免启动时就把 ffmpeg 库（及后续约 31MB wasm）读入内存。
// Android 走原生桥接 / Web Audio，本库完全不会被加载。
// ============================================================
tcState.libReady = false;

async function ensureFFmpegLib() {
  if (window.FFmpegLib) { tcState.libReady = true; return true; }
  try {
    const ffmpegMod = await import('./vendor/ffmpeg-lib/index.js');
    const utilMod   = await import('./vendor/ffmpeg-util/index.js');
    window.FFmpegLib = {
      FFmpeg: ffmpegMod.FFmpeg,
      fetchFile: utilMod.fetchFile,
      toBlobURL: utilMod.toBlobURL,
    };
    tcState.libReady = true;
    console.log('[Transcoder] FFmpegLib 已懒加载');
    return true;
  } catch (err) {
    console.error('[FFmpeg] 本地库加载失败:', err.message);
    window.FFmpegLibError = err.message;
    return false;
  }
}

// ============================================================
// Android 环境初始化
// ============================================================
async function initAndroidFFmpeg() {
  // 等待 AndroidFFmpeg 桥接层就绪
  if (window.AndroidFFmpeg && window.AndroidFFmpeg.ready) {
    tcState.isAndroid = true;
    tcState.isLoaded = true;
    setStatus('ready', '✅ Android 原生 FFmpeg 已就绪');
    btnLoadFFmpeg.style.display = 'none';
    updateStartBtn();
    console.log('[Transcoder] Android FFmpeg 初始化成功');
    return true;
  }
  
  // 还没就绪？等一次事件
  return new Promise((resolve) => {
    const handler = () => {
      window.removeEventListener('android-ffmpeg-ready', handler);
      if (window.AndroidFFmpeg && window.AndroidFFmpeg.ready) {
        tcState.isAndroid = true;
        tcState.isLoaded = true;
        setStatus('ready', '✅ Android 原生 FFmpeg 已就绪');
        btnLoadFFmpeg.style.display = 'none';
        updateStartBtn();
        console.log('[Transcoder] Android FFmpeg 初始化成功');
        resolve(true);
      } else {
        resolve(false);
      }
    };
    window.addEventListener('android-ffmpeg-ready', handler);
    // 5秒超时
    setTimeout(() => {
      window.removeEventListener('android-ffmpeg-ready', handler);
      resolve(false);
    }, 5000);
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
function safeName(originalName, ext) {
  // 去掉原扩展名
  const base = originalName.replace(/\.[^.]+$/, '');
  // 只保留安全字符，其余替换为下划线
  const safe = base.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 40);
  const id = ++_fileCounter;
  return `input_${id}_${safe}.${ext}`;
}

function safeOutputName(originalName, outputExt) {
  const base = originalName.replace(/\.[^.]+$/, '');
  const safe = base.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 40);
  const id = _fileCounter;
  return `out_${id}_${safe}.${outputExt}`;
}

// ============================================================
// FFmpeg 初始化（懒加载）
// ============================================================
const CDN_CORES = {
  single: {
    base: [
      './vendor/ffmpeg-core',
    ],
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm'],
  },
  multi: {
    base: [
      './vendor/ffmpeg-core',
    ],
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'],
  },
};

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

  // 非 Android 环境：先确保 ffmpeg 库已懒加载（仅首次需要）
  if (!isAndroid()) {
    if (!tcState.libReady || !window.FFmpegLib) {
      setStatus('loading', '⏳ 正在加载 FFmpeg 库（约 31MB，按需加载）...');
      const ok = await ensureFFmpegLib();
      if (!ok) {
        tcState.isLoading = false;
        btnLoadFFmpeg.disabled = false;
        btnLoadFFmpeg.textContent = '🔄 重试加载';
        setStatus('error', '❌ FFmpeg 库加载失败（请检查 vendor/ 文件是否完整）');
        return false;
      }
    }
  }

  const canMT = typeof SharedArrayBuffer !== 'undefined';
  const coreSet = canMT ? CDN_CORES.multi : CDN_CORES.single;
  // 取第一个 base 路径
  const basePath = coreSet.base[0];

  setStatus('loading', `⏳ 加载 FFmpeg Core ${canMT ? '🧵多线程' : '单线程'}（约 31 MB）...`);

  try {
    const { FFmpeg } = window.FFmpegLib;
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

    // ⚡ 直接使用本地路径，不经过 toBlobURL 的 fetch → Blob 转换
    // 避免 Android WebView 下 Worker + blob URL 的兼容问题
    const coreURL  = `${basePath}/ffmpeg-core.js`;
    const wasmURL  = `${basePath}/ffmpeg-core.wasm`;
    const loadOpts = { coreURL, wasmURL };

    appendLog(`加载核心: ${coreURL}`);

    if (canMT) {
      loadOpts.workerURL = `${basePath}/ffmpeg-core.worker.js`;
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
    
    // 如果直接路径失败，回退到 toBlobURL 方式
    appendLog('直接路径失败，尝试 toBlobURL 方式...');
    try {
      const { toBlobURL } = window.FFmpegLib;
      const coreURL = await makeBlobURL(toBlobURL, coreSet.base, 'ffmpeg-core.js', 'text/javascript');
      const wasmURL = await makeBlobURL(toBlobURL, coreSet.base, 'ffmpeg-core.wasm', 'application/wasm');
      const loadOpts = { coreURL, wasmURL };
      if (canMT) {
        loadOpts.workerURL = await makeBlobURL(toBlobURL, coreSet.base, 'ffmpeg-core.worker.js', 'text/javascript');
      }
      await tcState.ffmpeg.load(loadOpts);
      
      tcState.isLoaded  = true;
      tcState.isLoading = false;
      setStatus('ready', `✅ FFmpeg 引擎就绪（${canMT ? '多线程' : '单线程'}）`);
      btnLoadFFmpeg.style.display = 'none';
      updateStartBtn();
      return true;
    } catch (fallbackErr) {
      tcState.isLoading = false;
      console.error('[FFmpeg] 全部加载方式失败', err, fallbackErr);
      setStatus('error', `❌ 加载失败: ${err.message}`);
      btnLoadFFmpeg.disabled = false;
      btnLoadFFmpeg.textContent = '🔄 重试加载';
      return false;
    }
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
// Android 批量转码流程
// ============================================================
async function startAndroidTranscodeBatch() {
  if (tcState.sourceFiles.length === 0) return;
  
  const params = getParams();
  
  const newTasks = tcState.sourceFiles.map(sf => {
    const id = ++tcState.taskIdCounter;
    const baseName = sf.name.replace(/\.[^.]+$/, '');
    const displayOut = `${baseName}_converted.${params.config.ext}`;
    return {
      id,
      sf,
      displayName: displayOut,
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
  
  for (const task of newTasks) {
    task.status = 'working';
    tcState.currentTaskId = task.id;
    renderTasks();
    
    try {
      appendLog(`\n===== 开始: ${task.sf.name} -> ${task.displayName} =====`);
      await startAndroidTranscodeSingle(task, params);
    } catch (err) {
      task.status = 'error';
      task.error = err.message;
      appendLog(`失败: ${err.message}`);
    }
    
    tcState.currentTaskId = null;
    renderTasks();
  }
  
  btnStart.disabled = false;
  btnStart.textContent = '⚙️ 开始转码';
}

async function startAndroidTranscodeSingle(task, params) {
  const taskId = `task_${task.id}_${Date.now()}`;

  // 生成临时文件路径
  const inputFileName = safeName(task.sf.name, task.sf.ext || 'tmp');
  const outputFileName = safeOutputName(task.sf.name, params.config.ext);

  let outputPath = '';

  try {
    if (!task.sf.file) {
      throw new Error('Android 转码需要 File 对象');
    }

    // 优先尝试原生 FFmpeg 桥接
    if (window.AndroidFFmpeg && window.AndroidFFmpeg.ready) {
      appendLog(`正在使用原生 FFmpeg 转码...`);
      try {
        const blob = await window.AndroidFFmpeg.transcodeFile(
          task.sf.file,
          params.config.ext,
          params.bitrate
        );
        task.outputBlob = blob;
        task.outputUrl = URL.createObjectURL(blob);
        task.status = 'done';
        task.progress = 100;
        appendLog(`完成: ${task.displayName} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
        return;
      } catch (nativeErr) {
        appendLog(`原生 FFmpeg 失败: ${nativeErr.message}，回退到 Web Audio WAV 转码...`);
        console.warn('[Transcoder] 原生 FFmpeg 失败，回退 Web Audio', nativeErr);
      }
    }

    // 回退方案：Web Audio API WAV 转码（完全离线、无依赖）
    appendLog(`使用 Web Audio API 转码为 WAV...`);
    const blob = await transcodeWithWebAudio(task.sf.file, {
      sampleRate: parseInt(params.samplerate) || 44100,
      channels: parseInt(params.channels) || 2
    });
    // 更新任务显示名为 .wav
    task.displayName = task.sf.name.replace(/\.[^.]+$/, '') + '_converted.wav';
    task.outputBlob = blob;
    task.outputUrl = URL.createObjectURL(blob);
    task.status = 'done';
    task.progress = 100;
    appendLog(`完成 (WAV): ${task.displayName} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);

  } catch (err) {
    task.status = 'error';
    task.error = err.message;
    appendLog(`失败: ${err.message}`);
    console.error('[Transcoder] 转码失败', err);
  }
}

/**
 * Web Audio API WAV 转码（完全离线备选方案）
 * 用 AudioContext.decodeAudioData 解码 → OfflineAudioContext 重采样 → 编码 WAV
 * 限制：只能输出 WAV(PCM)，但支持输入 MP3/WAV/M4A/AAC/OGG 等
 */
async function transcodeWithWebAudio(file, options = {}) {
  const arrayBuffer = file.arrayBuffer ? await file.arrayBuffer() : await blobToArrayBuffer(file);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('浏览器不支持 Web Audio API');

  const audioCtx = new AudioCtx();
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } catch (e) {
    throw new Error(`无法解码音频: ${e.message}（该格式可能不支持）`);
  }
  await audioCtx.close();

  const targetSampleRate = options.sampleRate || audioBuffer.sampleRate;
  const targetChannels = Math.min(options.channels || 2, audioBuffer.numberOfChannels);

  // 用 OfflineAudioContext 重采样
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const duration = audioBuffer.duration;
  const length = Math.ceil(duration * targetSampleRate);
  const offlineCtx = new OfflineCtx(targetChannels, length, targetSampleRate);

  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();

  // 编码为 WAV (PCM 16-bit)
  return audioBufferToWavBlob(rendered);
}

/** AudioBuffer → WAV Blob (PCM 16-bit) */
function audioBufferToWavBlob(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * numChannels * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // WAV 文件头
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);        // fmt chunk size
  view.setUint16(20, 1, true);         // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true);              // block align
  view.setUint16(34, 16, true);        // bits per sample
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // 交错 PCM 数据
  const channels = [];
  for (let i = 0; i < numChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }

  let offset = headerSize;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = channels[ch][i];
      sample = Math.max(-1, Math.min(1, sample));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

// ============================================================
// 核心转码流程
// ============================================================
async function startTranscode() {
  // Android 环境：优先原生 FFmpeg，失败自动回退 Web Audio WAV 转码
  if (isAndroid()) {
    // 不再强制要求 AndroidFFmpeg 就绪，允许走 Web Audio 备选
    if (window.AndroidFFmpeg && window.AndroidFFmpeg.ready) {
      setStatus('ready', '✅ 使用原生 FFmpeg 转码');
    } else {
      setStatus('loading', '⚠️ 原生 FFmpeg 未就绪，将使用 Web Audio WAV 转码（仅 WAV 格式）');
    }
    await startAndroidTranscodeBatch();
    return;
  }
  
  // 浏览器/Electron 环境使用 FFmpeg.wasm
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

    tcState.currentTaskId = null;
    renderTasks();
  }

  btnStart.disabled = false;
  btnStart.textContent = '⚙️ 开始转码';
}

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

// 批量导出所有已完成的转码任务（打包为 zip）
async function batchExportAll() {
  const doneTasks = tcState.tasks.filter(t => t.status === 'done' && t.outputBlob);
  console.log('[BatchExport] 可导出任务数:', doneTasks.length);
  if (doneTasks.length === 0) {
    showToast('没有可导出的转码文件');
    return;
  }

  // 检查 ZIP 打包 API 是否可用
  console.log('[BatchExport] electronAPI:', !!window.electronAPI);
  console.log('[BatchExport] isElectron:', window.electronAPI?.isElectron);
  console.log('[BatchExport] saveFilesAsZip:', !!window.electronAPI?.saveFilesAsZip);
  
  if (window.electronAPI && window.electronAPI.isElectron && window.electronAPI.saveFilesAsZip) {
    // Electron 环境：打包为 zip 后一次性保存
    showToast(`正在打包 ${doneTasks.length} 个文件...`);

    // 构造文件列表
    const files = [];
    for (const task of doneTasks) {
      console.log('[BatchExport] 处理文件:', task.displayName, 'Blob大小:', task.outputBlob?.size);
      const buffer = await task.outputBlob.arrayBuffer();
      files.push({
        name: task.displayName,
        buffer: buffer
      });
    }
    console.log('[BatchExport] 准备发送', files.length, '个文件到主进程');

    const result = await window.electronAPI.saveFilesAsZip(files);
    console.log('[BatchExport] 结果:', result);
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

// 检测平台并初始化
// 注意：Capacitor 注入 window.Capacitor 是异步的，脚本加载时可能还没就绪
// 所以不能立即调 isAndroid()，要等 android-ffmpeg-ready 事件或超时回退
(async function init() {
  // 先等一小段时间让 Capacitor 有机会注入
  await new Promise(r => setTimeout(r, 100));

  if (isAndroid()) {
    console.log('[Transcoder] 检测到 Android 环境');
    // AndroidFFmpeg 桥接层可能还没初始化完，监听事件
    if (window.AndroidFFmpeg && window.AndroidFFmpeg.ready) {
      // 已经就绪（bridge 脚本先执行完）
      await initAndroidFFmpeg();
    } else {
      // 等 android-ffmpeg-ready 事件（由 android-ffmpeg-bridge.js dispatch）
      setStatus('loading', '⏳ 初始化 Android 原生 FFmpeg...');
      let androidReady = false;
      const handler = () => {
        androidReady = true;
        window.removeEventListener('android-ffmpeg-ready', handler);
        initAndroidFFmpeg();
      };
      window.addEventListener('android-ffmpeg-ready', handler);
      // 8 秒超时：如果原生桥接没起来，启用 Web Audio WAV 转码备选
      setTimeout(() => {
        if (!androidReady) {
          window.removeEventListener('android-ffmpeg-ready', handler);
          console.warn('[Transcoder] Android 原生 FFmpeg 超时，启用 Web Audio WAV 转码备选');
          setStatus('ready', '✅ 转码就绪（Web Audio WAV 模式）');
          btnLoadFFmpeg.style.display = 'none';
          tcState.isLoaded = true;  // 允许直接开始转码
          updateStartBtn();
        }
      }, 8000);
    }
  } else if (isElectron()) {
    console.log('[Transcoder] 检测到 Electron 环境');
    btnLoadFFmpeg.disabled = false;
    setStatus('loading', '点击「加载 FFmpeg」初始化转码引擎（约 31MB，按需加载）');
  } else {
    console.log('[Transcoder] 检测到浏览器环境');
    btnLoadFFmpeg.disabled = false;
    setStatus('loading', '点击「加载 FFmpeg」初始化转码引擎（约 31MB，按需加载）');
  }
})();

console.log('[Transcoder] 转码模块已加载（多平台版）');
