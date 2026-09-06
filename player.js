/**
 * MusicPlayer - player.js (Optimized)
 * 支持格式：MP3, FLAC, WAV, OGG, AAC, M4A, OPUS, WebM, WMA, APE(部分), AIFF, ALAC
 * 兼容：浏览器模式 & Electron 模式
 * 优化：懒加载文件夹、智能预加载、虚拟化渲染
 */

'use strict';

// ==============================
// Toast 提示（简版，与 transcoder.js 共享样式）
// ==============================
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'tc-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 2500);
}

// ==============================
// 系统时钟（标题栏显示）
// ==============================
function updateHeaderClock() {
  const el = document.getElementById('header-clock');
  if (!el) return;
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  el.textContent = `${h}:${m}:${s}`;
}
setInterval(updateHeaderClock, 1000);
updateHeaderClock();

// ==============================
// Electron 环境检测
// ==============================
const IS_ELECTRON = !!(window.electronAPI && window.electronAPI.isElectron);

// ==============================
// 状态
// ==============================
const state = {
  playlist: [],       // { name, ext, url, duration, localPath, _metadataLoaded }
  currentIndex: -1,
  isPlaying: false,
  mode: 'list',       // list | repeat | repeatOne
  shuffle: false,
  shuffleOrder: [],
};

// ==============================
// 内存管理：最多 200MB，只保留当前/上一首/下一首 的 ObjectURL
// ==============================
const MAX_MEMORY_BYTES = 200 * 1024 * 1024; // 200MB
let totalMemoryBytes = 0;  // 已加载音频占用的近似内存

/**
 * 内存管理：保留当前播放曲目附近最大范围的 ObjectURL
 *
 * 规则：
 *  - 内存足够（<200MB）：保留 N-2, N-1, N, N+1, N+2（5 首）
 *  - 内存超限（>=200MB）：缩小到 N-1, N, N+1（3 首）
 *  - 初始加载：只建前 3 首的 URL
 */
function cleanupObjectURLs(keepIndex) {
  // 根据当前内存决定保留范围
  const range = (totalMemoryBytes > MAX_MEMORY_BYTES) ? 1 : 2;
  const minKeep = Math.max(0, keepIndex - range);
  const maxKeep = Math.min(state.playlist.length - 1, keepIndex + range);
  
  state.playlist.forEach((track, i) => {
    if (!track._isOwnObjectUrl) return;
    
    if (i < minKeep || i > maxKeep) {
      if (track.url && track._ownUrl) {
        URL.revokeObjectURL(track._ownUrl);
        track.url = null;
        track._ownUrl = null;
        track._lazy = true;
        totalMemoryBytes -= (track._estimatedSize || 0);
      }
    }
  });
}

/** 清空播放列表时释放所有 ObjectURL，避免内存泄漏 */
function cleanupAllObjectURLs() {
  state.playlist.forEach(track => {
    if (track._isOwnObjectUrl && track._ownUrl) {
      URL.revokeObjectURL(track._ownUrl);
      track.url = null;
      track._ownUrl = null;
    }
  });
  totalMemoryBytes = 0;
}

/**
 * 确保指定索引的歌曲有 ObjectURL（懒加载）
 */
function ensureTrackURL(index) {
  const track = state.playlist[index];
  if (!track) return;
  
  if (track._lazy && track._fileObj && !track.url) {
    const url = URL.createObjectURL(track._fileObj);
    track.url = url;
    track._ownUrl = url;
    track._isOwnObjectUrl = true;
    track._lazy = false;
    totalMemoryBytes += (track._estimatedSize || 0);
  }
}

// ==============================
// 均衡器状态
// ==============================
const eqState = {
  enabled: true,
  audioContext: null,
  source: null,
  filters: [],
  gainNode: null,
  presets: {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [8, 6, 4, 2, 0, 0, 0, 0, 0, 0],
    vocal: [0, 0, 0, 2, 4, 6, 4, 2, 0, 0],
    treble: [0, 0, 0, 0, 0, 0, 2, 4, 6, 8],
    electronic: [6, 4, 0, -2, 0, 2, 4, 6, 4, 2],
    rock: [5, 4, 2, 0, -2, 0, 3, 5, 4, 2],
    jazz: [0, 0, 2, 4, 3, 0, 2, 4, 3, 0],
    classical: [0, 0, 0, 2, 4, 4, 2, 0, 0, 0],
    pop: [0, 1, 2, 3, 4, 3, 2, 1, 0, 0],
  },
  frequencies: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
};

// 虚拟化渲染配置
const VIRTUAL_CONFIG = {
  itemHeight: 56,     // 每行高度（px）
  bufferSize: 5,      // 上下缓冲行数
  containerHeight: 0, // 容器高度（动态计算）
};

// ==============================
// DOM 引用
// ==============================
const $ = id => document.getElementById(id);
const audio         = $('audio-engine');
const cover         = $('cover');
const trackTitle    = $('track-title');
const trackArtist   = $('track-artist');
const trackFormat   = $('track-format');
const currentTime   = $('current-time');
const totalTime     = $('total-time');
const progressFill  = $('progress-fill');
const progressThumb = $('progress-thumb');
const progressWrap  = $('progress-bar-wrap');
const volumeSlider  = $('volume');
const volValue      = $('vol-value');
const volIcon       = $('vol-icon');
const playBtn       = $('btn-play');
const prevBtn       = $('btn-prev');
const nextBtn       = $('btn-next');
// 模式切换按钮（3个独立按钮）
const modeBtnRepeatOne = $('btn-mode-repeatOne');
const modeBtnRepeat    = $('btn-mode-repeat');
const modeBtnShuffle   = $('btn-mode-shuffle');
const coverImg      = $('cover-img');
const coverIcon     = $('cover-icon');
const lyricSection  = $('lyric-section');
const lyricRows     = lyricSection ? lyricSection.querySelectorAll('.lyric-row') : [];
const playlistEl    = $('playlist');
const trackCount    = $('track-count');
const fileInput     = $('file-input');
const folderInput   = $('folder-input');
const btnOpenFile   = $('btn-open-file');
const btnOpenFolder = $('btn-open-folder');

// ==============================
// 格式支持映射
// ==============================
const FORMAT_MIME = {
  mp3:  'audio/mpeg',
  flac: 'audio/flac',
  wav:  'audio/wav',
  ogg:  'audio/ogg',
  oga:  'audio/ogg',
  aac:  'audio/aac',
  m4a:  'audio/mp4',
  mp4:  'audio/mp4',
  opus: 'audio/ogg; codecs=opus',
  webm: 'audio/webm',
  wma:  'audio/x-ms-wma',
  ape:  'audio/ape',
  aiff: 'audio/aiff',
  aif:  'audio/aiff',
  alac: 'audio/mp4',
  '3gp': 'audio/3gpp',
};

function getMime(ext) {
  return FORMAT_MIME[ext.toLowerCase()] || 'audio/*';
}

function isSupported(ext) {
  const mime = getMime(ext);
  const support = audio.canPlayType(mime);
  return support === 'probably' || support === 'maybe';
}

// ==============================
// 工具函数
// ==============================
function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function getExt(filename) {
  return filename.split('.').pop().toLowerCase();
}

function getBaseName(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function randomColor() {
  const colors = [
    'linear-gradient(135deg,#6d28d9,#2563eb)',
    'linear-gradient(135deg,#db2777,#f97316)',
    'linear-gradient(135deg,#0891b2,#059669)',
    'linear-gradient(135deg,#7c3aed,#db2777)',
    'linear-gradient(135deg,#1d4ed8,#06b6d4)',
    'linear-gradient(135deg,#b45309,#d97706)',
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ==============================
// 虚拟化渲染：只渲染可见区域
// ==============================
function initVirtualScroll() {
  // 计算容器高度
  VIRTUAL_CONFIG.containerHeight = playlistEl.clientHeight;
  
  // 创建滚动容器
  const scrollContainer = document.createElement('div');
  scrollContainer.className = 'playlist-scroll-container';
  scrollContainer.style.cssText = `
    position: relative;
    height: ${state.playlist.length * VIRTUAL_CONFIG.itemHeight}px;
    overflow: hidden;
  `;
  
  // 清空并重新组织
  playlistEl.innerHTML = '';
  playlistEl.appendChild(scrollContainer);
  
  // 监听滚动
  playlistEl.addEventListener('scroll', onPlaylistScroll, { passive: true });
  
  // 初始渲染
  renderVisibleItems();
}

function onPlaylistScroll() {
  renderVisibleItems();
}

function renderVisibleItems() {
  const container = playlistEl.querySelector('.playlist-scroll-container');
  if (!container) return;
  
  const scrollTop = playlistEl.scrollTop;
  const startIndex = Math.max(0, Math.floor(scrollTop / VIRTUAL_CONFIG.itemHeight) - VIRTUAL_CONFIG.bufferSize);
  const endIndex = Math.min(
    state.playlist.length - 1,
    Math.ceil((scrollTop + VIRTUAL_CONFIG.containerHeight) / VIRTUAL_CONFIG.itemHeight) + VIRTUAL_CONFIG.bufferSize
  );
  
  // 只渲染可见区域
  container.innerHTML = '';
  
  for (let i = startIndex; i <= endIndex; i++) {
    const track = state.playlist[i];
    const item = createPlaylistItem(track, i);
    item.style.position = 'absolute';
    item.style.top = `${i * VIRTUAL_CONFIG.itemHeight}px`;
    item.style.left = '0';
    item.style.right = '0';
    item.style.height = `${VIRTUAL_CONFIG.itemHeight}px`;
    container.appendChild(item);
  }

  // 注意：不要在滚动渲染时调用 scrollIntoView，否则用户滑动会被强制拉回当前歌曲位置
  // 切歌时的滚动定位由 playAt 单独处理
}

function createPlaylistItem(track, index) {
  const li = document.createElement('div');
  li.className = 'playlist-item' + (index === state.currentIndex ? ' active' : '');
  li.dataset.index = index;
  
  const supported = isSupported(track.ext);
  const notSupportedMark = supported ? '' : ' <span title="浏览器不支持此格式">⚠️</span>';
  
  li.innerHTML = `
    <span class="playlist-item-num">${index + 1}</span>
    <div class="playlist-item-info">
      <div class="playlist-item-title">${track.name}${notSupportedMark}</div>
      <div class="playlist-item-meta">${track.ext.toUpperCase()}</div>
    </div>
    <span class="playlist-item-dur">${track.duration ? formatTime(track.duration) : '--:--'}</span>
  `;
  
  li.addEventListener('click', () => playAt(index));
  return li;
}

// ==============================
// 播放列表渲染（虚拟化入口）
// ==============================
function renderPlaylist() {
  trackCount.textContent = `${state.playlist.length} 首`;
  
  if (state.playlist.length === 0) {
    playlistEl.innerHTML = '<div class="playlist-empty">拖入文件或点击打开按钮</div>';
    return;
  }
  
  initVirtualScroll();
}

// ==============================
// 智能预加载：只加载前后3首的元数据
// ==============================
function preloadMetadata(centerIndex) {
  const PRELOAD_RANGE = 3; // 前后各3首
  const start = Math.max(0, centerIndex - PRELOAD_RANGE);
  const end = Math.min(state.playlist.length - 1, centerIndex + PRELOAD_RANGE);
  
  for (let i = start; i <= end; i++) {
    const track = state.playlist[i];
    if (track._metadataLoaded || track.duration) continue;
    
    // 异步加载元数据
    loadTrackMetadata(i);
  }
}

function loadTrackMetadata(index) {
  const track = state.playlist[index];
  if (!track || track._metadataLoaded) return;
  
  track._metadataLoading = true;
  
  const tmpAudio = new Audio();
  tmpAudio.preload = 'metadata';
  tmpAudio.src = track.url;
  
  const onLoaded = () => {
    track.duration = tmpAudio.duration;
    track._metadataLoaded = true;
    track._metadataLoading = false;
    
    // 更新列表显示
    const container = playlistEl.querySelector('.playlist-scroll-container');
    if (container) {
      const item = container.querySelector(`[data-index="${index}"]`);
      if (item) {
        const durEl = item.querySelector('.playlist-item-dur');
        if (durEl) durEl.textContent = formatTime(track.duration);
      }
    }
    
    // 如果是当前播放项，更新总时长显示
    if (index === state.currentIndex) {
      totalTime.textContent = formatTime(track.duration);
    }
    
    cleanup();
  };
  
  const onError = () => {
    track._metadataLoaded = true; // 标记为已处理，避免重复尝试
    track._metadataLoading = false;
    track.duration = 0; // 标记为无效
    cleanup();
  };
  
  const cleanup = () => {
    tmpAudio.removeEventListener('loadedmetadata', onLoaded);
    tmpAudio.removeEventListener('error', onError);
    tmpAudio.src = '';
  };
  
  tmpAudio.addEventListener('loadedmetadata', onLoaded);
  tmpAudio.addEventListener('error', onError);
  
  // 5秒超时
  setTimeout(() => {
    if (!track._metadataLoaded) {
      cleanup();
      track._metadataLoaded = true;
      track._metadataLoading = false;
    }
  }, 5000);
}

// ==============================
// 文件加载（优化版：只记录路径，不预读）
// ==============================
/**
 * 加载 SAF 返回的文件（Android SAF content:// URI）
 * 转换为播放器可识别的 track 格式
 */
function loadSafFiles(safFiles, treeUri) {
  const audioExts = new Set(Object.keys(FORMAT_MIME));
  const newTracks = [];

  // 打开新目录时清空旧播放列表（替换而非追加）
  if (state.playlist.length > 0) {
    cleanupAllObjectURLs();
    state.playlist = [];
    state.currentIndex = -1;
    state.shuffleOrder = [];
    state.isPlaying = false;
  }

  for (const f of safFiles) {
    const ext = getExt(f.name);
    if (!audioExts.has(ext)) continue;

    // 统一命名：_safTreeUri 和 _safDocumentId vs _treeUri / _isSafFile
    newTracks.push({
      name: getBaseName(f.name),
      ext,
      url: null,  // SAF 文件不直接生成 URL，播放时动态读取
      duration: null,
      color: f._color || randomColor(),
      _metadataLoaded: false,
      _metadataLoading: false,
      _isSafFile: true,
      _safTreeUri: f._treeUri || treeUri,
      _safDocumentId: f.documentId,
      // 同目录兄弟文件（Java 端匹配好）：.lrc 歌词 / 封面图
      _lyricDocId: f._lyricDocId || null,
      _coverDocId: f._coverDocId || null,
    });
  }

  if (newTracks.length === 0) {
    alert('该目录下未找到支持的音频文件！');
    return;
  }

  state.playlist.push(...newTracks);
  renderPlaylist();

  if (state.currentIndex === -1) {
    playAt(state.playlist.length - newTracks.length);
  }
}

function loadFiles(files) {
  const audioExts = new Set(Object.keys(FORMAT_MIME));
  const newTracks = [];
  
  for (const f of files) {
    if (typeof f === 'string') {
      // Electron 本地路径
      const name = f.replace(/\\/g, '/').split('/').pop();
      const ext  = getExt(name);
      if (!audioExts.has(ext)) continue;
      const url = IS_ELECTRON ? window.electronAPI.getFileURL(f) : `file:///${f.replace(/\\/g,'/')}`;
      newTracks.push({ 
        name: getBaseName(name), 
        ext, 
        url, 
        duration: null, 
        color: randomColor(), 
        localPath: f,
        _metadataLoaded: false,
        _metadataLoading: false
      });
    } else {
      // 浏览器 File 对象
      const ext = getExt(f.name);
      if (!audioExts.has(ext) && !f.type.startsWith('audio/')) continue;
      
      const estimatedSize = f.size || 0;
      
      // 累计超过 200MB 或已经有大量队列时，标记为懒加载
      // 但前 3 首始终创建 URL
      const shouldLazy = (totalMemoryBytes > MAX_MEMORY_BYTES) ||
                         (newTracks.length >= 3 && (totalMemoryBytes + estimatedSize > MAX_MEMORY_BYTES));
      
      let url = null;
      let ownUrl = null;
      if (!shouldLazy) {
        url = URL.createObjectURL(f);
        ownUrl = url;
        totalMemoryBytes += estimatedSize;
      }
      
      newTracks.push({ 
        name: getBaseName(f.name), 
        ext, 
        url,  // lazy 时为 null
        duration: null, 
        color: randomColor(),
        _metadataLoaded: false,
        _metadataLoading: false,
        _fileObj: f,  // 保存 File 引用，用于提取专辑封面 + 懒加载
        _lazy: shouldLazy,
        _ownUrl: ownUrl,
        _isOwnObjectUrl: true,
        _estimatedSize: estimatedSize
      });
    }
  }
  
  if (newTracks.length === 0) {
    alert('未找到支持的音频文件！');
    return;
  }
  
  state.playlist.push(...newTracks);
  renderPlaylist();
  
  // 如果当前没有播放，自动开始第一首
  // 并且预加载第一首的元数据
  if (state.currentIndex === -1) {
    const startIndex = state.playlist.length - newTracks.length;
    playAt(startIndex);
  }
}

// ==============================
// 核心播放函数（带智能预加载）
// ==============================
function playAt(index) {
  if (index < 0 || index >= state.playlist.length) return;
  
  const track = state.playlist[index];
  state.currentIndex = index;
  
  // 重置封面为默认渐变
  setCoverArt(null, track.color);
  // 切歌瞬间清空歌词，避免上一首残留；新歌词由 loadLyrics 异步加载
  resetLyricDisplay();
  
  // 内存管理：确保当前歌曲有 URL
  ensureTrackURL(index);
  // 预加载前后最多 2 首（cleanup 会根据内存自动决定保留 3 首还是 5 首）
  ensureTrackURL(index - 1);
  ensureTrackURL(index + 1);
  ensureTrackURL(index - 2);
  ensureTrackURL(index + 2);
  // 清理超出范围的 URL（内存 <200MB 保留±2 首, ≥200MB 缩小到±1 首）
  cleanupObjectURLs(index);
  
  // 更新 Audio 源
  if (track._isSafFile && window.AndroidDirectoryPicker && window.AndroidDirectoryPicker.plugin) {
    // 立即更新 UI（不等异步读取完成，避免一直显示"未选择音乐"）
    trackTitle.textContent = track.name;
    trackArtist.textContent = '--';
    trackFormat.textContent = track.ext.toUpperCase();
    if (track.duration) {
      totalTime.textContent = formatTime(track.duration);
    } else {
      totalTime.textContent = '--:--';
    }
    preloadMetadata(index);
    renderPlaylist();

    // SAF 文件：流式拷贝到缓存，拿同源 https 虚拟路径播放（不整文件读入内存，根治大文件 OOM）
    (async () => {
      try {
        const res = await window.AndroidDirectoryPicker.getPlayableFile(track._safTreeUri, track._safDocumentId, track.ext);
        track.url = res.url;
        // 关键：以 CORS 模式加载（crossOrigin 必须在设 src 前）。否则 <audio> 按 no-cors
        // 拉取 saf.local 音频，接入均衡器(Web Audio)的 MediaElementAudioSource 输出会被
        // 浏览器规范强制置零 → 进度条/时长正常但完全没声音。
        audio.crossOrigin = 'anonymous';
        audio.src = res.url;
        audio.volume = parseFloat(volumeSlider.value);
        audio.play().then(() => {
          state.isPlaying = true;
          updatePlayBtn();
          startCoverSpin();
          updateBgColor(track.color);
        }).catch(err => console.warn('播放失败:', err));

        // SAF 封面：优先同目录封面图（B-*.jpg），其次音频内嵌封面
        loadSafCover(track);
        // SAF 歌词：读取同目录 .lrc 并显示
        loadLyrics(track);
      } catch(e) {
        console.error('[SAF] 获取播放文件失败:', e);
      }
    })();
    return;
  }
  
  // 非 SAF 播放：恢复默认 no-cors，避免上一个 SAF 源的 anonymous 设置残留影响本地文件
  audio.crossOrigin = null;
  audio.src = track.url;
  audio.volume = parseFloat(volumeSlider.value);
  
  audio.play().then(() => {
    state.isPlaying = true;
    updatePlayBtn();
    startCoverSpin();
    updateBgColor(track.color);
  }).catch(err => {
    console.warn('播放失败:', err);
    trackTitle.textContent = track.name;
    trackFormat.textContent = `${track.ext.toUpperCase()} — 当前浏览器可能不支持此格式`;
  });
  
  trackTitle.textContent = track.name;
  trackArtist.textContent = '--';
  trackFormat.textContent = track.ext.toUpperCase();
  
  // 如果已有元数据，立即显示
  if (track.duration) {
    totalTime.textContent = formatTime(track.duration);
  } else {
    totalTime.textContent = '--:--';
  }
  
  // 智能预加载：当前 + 前后3首
  preloadMetadata(index);
  
  // 更新列表高亮
  renderPlaylist();
  
  // 非 SAF 文件：尝试从 File 对象提取专辑封面
  if (!track._isSafFile && track._fileObj) {
    extractAlbumArt(track._fileObj, track.ext).then(covUrl => {
      if (covUrl) {
        track._coverUrl = covUrl;
        setCoverArt(covUrl, track.color);
      }
    });
  }
}

function updateBgColor(gradient) {
  // 背景固定用桌面壁纸，封面圈固定为液态玻璃，不再随歌曲改变颜色。
}

// ==============================
// 专辑封面提取与显示
// ==============================

/**
 * 从音频文件中提取专辑封面（支持 MP3 ID3v2 APIC 和 M4A 封面）
 * @param {File|Blob} file - 音频文件对象
 * @param {string} ext - 文件扩展名
 * @returns {Promise<string|null>} data URL 或 null
 */
async function extractAlbumArt(file, ext) {
  if (!file) return null;
  
  try {
    // 只读取文件前 5MB 来寻找封面
    const maxBytes = 5 * 1024 * 1024;
    const slice = file.size > maxBytes ? file.slice(0, maxBytes) : file;
    const buffer = await slice.arrayBuffer();
    const view = new Uint8Array(buffer);
    
    if (ext === 'mp3' || ext === 'mp2') {
      return extractID3v2APIC(view);
    } else if (ext === 'm4a' || ext === 'mp4' || ext === 'aac') {
      return extractMP4Cover(view);
    } else if (ext === 'flac') {
      return extractFLACCover(view);
    }
  } catch (e) {
    console.warn('[Cover] 提取封面失败:', e.message);
  }
  return null;
}

/**
 * 解析 MP3 ID3v2 APIC 帧（专辑封面）
 */
function extractID3v2APIC(data) {
  // ID3v2 header: 10 bytes
  if (data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return null; // "ID3"
  
  const majorVer = data[3];
  const flags = data[5];
  const hasFooter = flags & 0x10;
  
  // 提取大小（syncsafe integer: 4 x 7 bits）
  let tagSize = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9];
  
  let offset = 10; // 跳过 ID3v2 header
  
  // ID3v2.4 footer 多 10 字节
  if (hasFooter) {
    offset += 10;
    tagSize -= 10;
  }
  
  const endPos = Math.min(10 + tagSize, data.length);
  
  // 逐帧查找 APIC
  while (offset + 10 <= endPos) {
    const frameId = String.fromCharCode(data[offset], data[offset+1], data[offset+2], data[offset+3]);
    
    let frameSize;
    if (majorVer >= 4) {
      // ID3v2.4: syncsafe integer
      frameSize = (data[offset+4] << 21) | (data[offset+5] << 14) | (data[offset+6] << 7) | data[offset+7];
    } else {
      // ID3v2.2/3: regular integer
      frameSize = (data[offset+4] << 24) | (data[offset+5] << 16) | (data[offset+6] << 8) | data[offset+7];
    }
    
    if (frameSize === 0 || offset + 10 + frameSize > endPos) break;
    
    if (frameId === 'APIC' || frameId === 'PIC') {
      // APIC frame encoding: 1 byte
      let pos = offset + 10;
      
      if (frameId === 'APIC') {
        // ID3v2.3+: text encoding (1 byte) + MIME type (null-terminated) + picture type (1 byte) + description (null-terminated) + image data
        const encoding = data[pos];
        pos++;
        
        // MIME type (null-terminated)
        let mimeStart = pos;
        while (pos < endPos && data[pos] !== 0) pos++;
        const mime = String.fromCharCode(...data.slice(mimeStart, pos));
        if (!mime || (!mime.startsWith('image/'))) return null;
        pos++; // skip null
        
        pos++; // skip picture type byte
        
        // description (null-terminated)
        if (encoding === 1 || encoding === 2) {
          // UTF-16: 2-byte null terminator
          while (pos + 1 < endPos && (data[pos] !== 0 || data[pos+1] !== 0)) pos++;
          pos += 2;
        } else {
          while (pos < endPos && data[pos] !== 0) pos++;
          pos++;
        }
        
        // image data
        const imgData = data.slice(pos, offset + 10 + frameSize);
        const blob = new Blob([imgData], { type: mime });
        return URL.createObjectURL(blob);
      }
    }
    
    offset += 10 + frameSize;
  }
  
  return null;
}

/**
 * 解析 M4A/MP4 封面（moov > trak > mdia > minf > stbl > stsd > ... > covr）
 * 简化：搜索 'covr' atom
 */
function extractMP4Cover(data) {
  // 搜索 'covr' box
  let pos = 0;
  while (pos + 8 < data.length) {
    const boxSize = (data[pos] << 24) | (data[pos+1] << 16) | (data[pos+2] << 8) | data[pos+3];
    const boxType = String.fromCharCode(data[pos+4], data[pos+5], data[pos+6], data[pos+7]);
    
    if (boxType === 'covr' && boxSize > 8 && pos + boxSize <= data.length) {
      // covr 内部有一个 data atom
      let innerPos = pos + 8;
      const innerEnd = pos + boxSize;
      while (innerPos + 8 <= innerEnd) {
        const innerSize = (data[innerPos] << 24) | (data[innerPos+1] << 16) | (data[innerPos+2] << 8) | data[innerPos+3];
        const innerType = String.fromCharCode(data[innerPos+4], data[innerPos+5], data[innerPos+6], data[innerPos+7]);
        
        if (innerType === 'data' && innerSize > 16) {
          // skip 8 bytes (type + locale)
          const imgData = data.slice(innerPos + 16, innerPos + innerSize);
          const blob = new Blob([imgData], { type: 'image/jpeg' });
          return URL.createObjectURL(blob);
        }
        innerPos += innerSize || 8;
        if (innerSize === 0) break;
      }
    }
    
    pos += boxSize || 1;
  }
  return null;
}

/**
 * 解析 FLAC 封面（METADATA_BLOCK_PICTURE）
 */
function extractFLACCover(data) {
  // FLAC 以 'fLaC' 开头
  if (data[0] !== 0x66 || data[1] !== 0x4C || data[2] !== 0x61 || data[3] !== 0x43) return null;
  
  let pos = 4;
  let lastBlock = false;
  
  while (!lastBlock && pos + 4 <= data.length) {
    lastBlock = (data[pos] & 0x80) !== 0;
    const blockType = data[pos] & 0x7F;
    const blockSize = (data[pos+1] << 16) | (data[pos+2] << 8) | data[pos+3];
    pos += 4;
    
    if (blockType === 6 && pos + blockSize <= data.length) {
      // METADATA_BLOCK_PICTURE
      // type (4) + mime + description + width(4) + height(4) + depth(4) + colors(4) + picture data
      let p = pos;
      p += 4; // picture type
      
      // MIME type
      let mimeLen = (data[p] << 24) | (data[p+1] << 16) | (data[p+2] << 8) | data[p+3];
      p += 4;
      const mime = String.fromCharCode(...data.slice(p, p + mimeLen));
      if (!mime.startsWith('image/')) return null;
      p += mimeLen;
      
      // description (UTF-8 string)
      let descLen = (data[p] << 24) | (data[p+1] << 16) | (data[p+2] << 8) | data[p+3];
      p += 4 + descLen;
      p += 16; // skip width, height, depth, colors
      
      // picture data
      let picLen = (data[p] << 24) | (data[p+1] << 16) | (data[p+2] << 8) | data[p+3];
      p += 4;
      
      if (p + picLen <= data.length) {
        const imgData = data.slice(p, p + picLen);
        const blob = new Blob([imgData], { type: mime });
        return URL.createObjectURL(blob);
      }
    }
    
    pos += blockSize;
  }
  return null;
}

/**
 * 设置封面显示：封面旋转开启且有封面图 → 显示图片并随 .cover 旋转；
 * 否则显示音符标志。color 参数保留（历史调用方传入），不在此驱动背景。
 */
function setCoverArt(imageUrl, color) {
  const show = appSettings.coverRotEnabled && !!imageUrl;
  if (coverImg) {
    if (show) {
      coverImg.src = imageUrl;
      coverImg.style.display = '';
    } else {
      coverImg.style.display = 'none';
      coverImg.src = '';
    }
  }
  if (coverIcon) coverIcon.style.display = show ? 'none' : 'inline';
}

/**
 * 加载 SAF 歌曲封面：优先同目录封面图（网易云导出 B-*.jpg，Java 端已匹配 _coverDocId），
 * 无则回退从音频流提取内嵌封面。
 */
async function loadSafCover(track) {
  try {
    if (track._coverDocId && window.AndroidDirectoryPicker) {
      const img = await window.AndroidDirectoryPicker.getPlayableFile(track._safTreeUri, track._coverDocId, '');
      if (img && img.url) {
        track._coverUrl = img.url;
        if (state.playlist[state.currentIndex] === track) setCoverArt(img.url, track.color);
        return;
      }
    }
    // 回退：内嵌封面（fetch 同源虚拟路径可跨域，Java 端已带 ACAO 头）
    if (track.url && window.AndroidDirectoryPicker) {
      const blob = await (await fetch(track.url)).blob();
      const covUrl = await extractAlbumArt(blob, track.ext);
      if (covUrl) {
        track._coverUrl = covUrl;
        if (state.playlist[state.currentIndex] === track) setCoverArt(covUrl, track.color);
      }
    }
  } catch (e) { /* 封面失败静默，保持音符 */ }
}

// =============================================================
// 歌词（.lrc）：最近 5 行（当前句 + 前后各 2 行），随播放滚动
// =============================================================

/** 解析 LRC 文本 → [{ time: 秒, text }] 按时间升序
 *  兼容：标准 [mm:ss.xx]、网易云逐字歌词([ms,ms](ms,ms,n)逐词…)、
 *        网易云逐字 JSON 词条({"t":ms,"c":[{"tx":词}...]})；元数据 JSON 自动跳过
 */
function parseLRC(text) {
  const out = [];
  if (!text) return out;
  const lineRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const verbatimHead = /^\[(\d+)[,，](\d+)\]/;
  const wordTagRe = /\(\d+[,，]\d+[,，]\d+\)/g;
  // 网易云元数据/信息头（作词/作曲/编曲等），不作为歌词
  const metaHeadRe = /^(作词|作曲|编曲|制作|监制|OP|SP|企划|出品)[:：]/;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // JSON 行：可能是元数据(作曲/作词) 或 逐字词条 {"t":ms,"c":[{"tx":词}]}
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line);
        if (j && Array.isArray(j.c)) {
          const tx = j.c.map(x => (x && typeof x.tx === 'string') ? x.tx : '').join('').trim();
          if (tx && !metaHeadRe.test(tx)) {
            if (typeof j.t === 'number' && j.t >= 0) {
              out.push({ time: j.t / 1000, text: tx });   // 逐字 JSON 词条
            }
            // 无 t 或 t<0（纯元数据）：跳过
          }
        }
      } catch (e) { /* 非 JSON 的 { 行忽略 */ }
      continue;
    }
    // 网易云逐字歌词行：[毫秒,毫秒](…)词 (…)词 → 整句作为一条，时间=行首毫秒
    const vh = line.match(verbatimHead);
    if (vh) {
      const sentence = line
        .replace(verbatimHead, '')
        .replace(wordTagRe, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (sentence) out.push({ time: parseInt(vh[1], 10) / 1000, text: sentence });
      continue;
    }
    // 标准 LRC 行（可能混有逐字词标签 [mm:ss.xx](ms,ms,n)词 → 去标签取纯文本）
    const content = line.replace(lineRe, '').replace(wordTagRe, '').trim();
    if (!content) continue;
    let m;
    lineRe.lastIndex = 0;
    while ((m = lineRe.exec(line)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const fracStr = m[3] || '';
      let frac = 0;
      if (fracStr) frac = fracStr.length >= 3 ? parseInt(fracStr, 10) / 1000 : parseInt(fracStr, 10) / 100;
      out.push({ time: min * 60 + sec + frac, text: content });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** 隐藏歌词区并清空 5 行（切歌/无歌词时调用）。同时失效当前歌的防抖窗口，
 *  避免"切走再切回同一首歌、且歌词窗口相同"时被防抖误判跳过导致歌词空白 */
function resetLyricDisplay() {
  if (!lyricRows.length) return;
  for (const row of lyricRows) row.textContent = '';
  if (lyricSection) lyricSection.classList.add('hidden');
  const t = state.playlist[state.currentIndex];
  if (t) t._lrcWinStart = undefined;
}

/**
 * 渲染当前时间的歌词窗口：当前句 + 前后各 2 行。
 * 无歌词/开关关闭 → 隐藏。
 */
function renderLyricWindow(track, time) {
  if (!lyricRows.length) return;
  const lrc = track && Array.isArray(track._lrc) ? track._lrc : null;
  if (!appSettings.lyricEnabled || !lrc || lrc.length === 0) {
    resetLyricDisplay();
    return;
  }
  // 当前行 = 最后一个 time <= 当前播放时间
  let cur = 0;
  for (let i = 0; i < lrc.length; i++) {
    if (lrc[i].time <= time) cur = i; else break;
  }
  const start = cur - 2;
  // 防抖：当前窗口未变且歌词区可见则不重绘（timeupdate 约 4Hz）；
  // 若歌词区刚被 reset 隐藏（hidden），必须强制重绘一次恢复显示
  if (track._lrcWinStart === start && lyricSection && !lyricSection.classList.contains('hidden')) return;
  track._lrcWinStart = start;
  lyricRows.forEach((row, off) => {
    const idx = start + off;
    if (idx >= 0 && idx < lrc.length) {
      row.textContent = lrc[idx].text;
    } else {
      row.textContent = '';
    }
    row.classList.toggle('lyric-active', off === 2 && idx >= 0 && idx < lrc.length);
  });
  if (lyricSection) lyricSection.classList.remove('hidden');
}

/** 加载当前 SAF 歌曲的同目录 .lrc 歌词（异步，带切歌竞态保护）
 *  已缓存（切回同一首歌）时不再重复读文件，立即渲染恢复歌词 */
async function loadLyrics(track) {
  if (!appSettings.lyricEnabled || !track._lyricDocId || !window.AndroidDirectoryPicker) {
    track._lrc = [];
    resetLyricDisplay();
    return;
  }
  // 缓存命中：返回上一首时秒显歌词
  if (Array.isArray(track._lrc)) {
    if (state.playlist[state.currentIndex] === track) {
      track._lrcWinStart = undefined;
      renderLyricWindow(track, audio.currentTime || 0);
    }
    return;
  }
  try {
    const text = await window.AndroidDirectoryPicker.readTextFile(track._safTreeUri, track._lyricDocId);
    track._lrc = parseLRC(text);
  } catch (e) {
    track._lrc = [];
  }
  track._lrcWinStart = undefined; // 强制渲染首帧（防抖窗口失效）
  // 竞态保护：若期间已切歌则丢弃
  if (state.playlist[state.currentIndex] !== track) return;
  renderLyricWindow(track, audio.currentTime || 0);
}

// =====================================================
// 桌面壁纸背景
// =====================================================
// 背景直接由系统动态壁纸透出（原生 FLAG_SHOW_WALLPAPER + 透明 WebView），
// 无需在 Web 层读取或绘制壁纸，因此这里没有额外的加载逻辑。
// 这样第三方动态壁纸的动画会直接显示在播放器后面。

// ==============================
// 播放/暂停
// ==============================
function togglePlay() {
  if (state.playlist.length === 0) {
    btnOpenFile.click();
    return;
  }
  if (state.currentIndex === -1) {
    playAt(0);
    return;
  }
  
  if (audio.paused) {
    audio.play();
    state.isPlaying = true;
    startCoverSpin();
  } else {
    audio.pause();
    state.isPlaying = false;
    pauseCoverSpin();
  }
  updatePlayBtn();
}

function updatePlayBtn() {
  const playIcon  = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  if (state.isPlaying) {
    playIcon.style.display  = 'none';
    pauseIcon.style.display = 'inline';
  } else {
    playIcon.style.display  = 'inline';
    pauseIcon.style.display = 'none';
  }
}

function startCoverSpin() {
  cover.classList.remove('spinning-paused');
  cover.classList.add('spinning');
}

function pauseCoverSpin() {
  cover.classList.remove('spinning');
  cover.classList.add('spinning-paused');
}

// ==============================
// 上一首 / 下一首（切换时触发预加载）
// ==============================
function playPrev() {
  if (state.playlist.length === 0) return;
  let idx = state.currentIndex - 1;
  if (idx < 0) idx = state.playlist.length - 1;
  playAt(idx);
}

function playNext() {
  if (state.playlist.length === 0) return;
  
  if (state.mode === 'repeatOne') {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  
  if (state.mode === 'shuffle') {
    const idx = getShuffleNext();
    playAt(idx);
    return;
  }
  
  // 无论什么模式，播放到最后一首时自动回到第一首
  let idx = state.currentIndex + 1;
  if (idx >= state.playlist.length) {
    idx = 0;
  }
  playAt(idx);
}

// ==============================
// 随机播放
// ==============================
function buildShuffleOrder() {
  state.shuffleOrder = Array.from({ length: state.playlist.length }, (_, i) => i)
    .filter(i => i !== state.currentIndex)
    .sort(() => Math.random() - 0.5);
}

function getShuffleNext() {
  if (state.shuffleOrder.length === 0) buildShuffleOrder();
  return state.shuffleOrder.shift() ?? 0;
}

// ==============================
// 播放模式切换（3个独立按钮：单曲循环 / 列表循环 / 随机）
// ==============================
function setPlayMode(mode) {
  state.mode = mode;
  state.shuffle = (mode === 'shuffle');
  
  // 更新按钮高亮
  const btns = [modeBtnRepeatOne, modeBtnRepeat, modeBtnShuffle];
  btns.forEach(b => b && b.classList.remove('active'));
  
  const modeMap = { repeatOne: modeBtnRepeatOne, repeat: modeBtnRepeat, shuffle: modeBtnShuffle };
  const activeBtn = modeMap[mode];
  if (activeBtn) activeBtn.classList.add('active');
}

// 绑定模式按钮点击事件
if (modeBtnRepeatOne) {
  modeBtnRepeatOne.addEventListener('click', () => setPlayMode('repeatOne'));
}
if (modeBtnRepeat) {
  modeBtnRepeat.addEventListener('click', () => setPlayMode('repeat'));
}
if (modeBtnShuffle) {
  modeBtnShuffle.addEventListener('click', () => setPlayMode('shuffle'));
}

// ==============================
// 进度条
// ==============================
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  progressFill.style.width = `${pct}%`;
  progressThumb.style.left = `${pct}%`;
  currentTime.textContent = formatTime(audio.currentTime);
});

// 歌词随播放进度滚动（当前句 + 前后 2 行）
audio.addEventListener('timeupdate', () => {
  const t = state.playlist[state.currentIndex];
  if (t && t._lrc && appSettings.lyricEnabled) {
    renderLyricWindow(t, audio.currentTime);
  }
});

audio.addEventListener('loadedmetadata', () => {
  totalTime.textContent = formatTime(audio.duration);
  // 更新列表时长
  if (state.currentIndex >= 0) {
    const track = state.playlist[state.currentIndex];
    if (track) {
      track.duration = audio.duration;
      track._metadataLoaded = true;
      
      const container = playlistEl.querySelector('.playlist-scroll-container');
      if (container) {
        const item = container.querySelector(`[data-index="${state.currentIndex}"]`);
        if (item) {
          const dur = item.querySelector('.playlist-item-dur');
          if (dur) dur.textContent = formatTime(audio.duration);
        }
      }
    }
  }
});

audio.addEventListener('ended', playNext);

// 点击进度条跳转
let isDragging = false;

function seekTo(e) {
  const bar = progressWrap.querySelector('.progress-bar');
  const rect = bar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
}

progressWrap.addEventListener('mousedown', e => { isDragging = true; seekTo(e); });
document.addEventListener('mousemove', e => { if (isDragging) seekTo(e); });
document.addEventListener('mouseup', () => { isDragging = false; });

// ==============================
// 音量
// ==============================
volumeSlider.addEventListener('input', () => {
  audio.volume = parseFloat(volumeSlider.value);
  volValue.textContent = `${Math.round(audio.volume * 100)}%`;
  updateVolIcon(audio.volume);
});

function updateVolIcon(v) {
  if (v === 0) volIcon.textContent = '🔇';
  else if (v < 0.3) volIcon.textContent = '🔈';
  else if (v < 0.7) volIcon.textContent = '🔉';
  else volIcon.textContent = '🔊';
}

volIcon.addEventListener('click', () => {
  if (audio.volume > 0) {
    audio._prevVol = audio.volume;
    audio.volume = 0;
    volumeSlider.value = 0;
  } else {
    audio.volume = audio._prevVol || 0.8;
    volumeSlider.value = audio.volume;
  }
  volValue.textContent = `${Math.round(audio.volume * 100)}%`;
  updateVolIcon(audio.volume);
});

// ==============================
// 键盘快捷键
// ==============================
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  switch (e.code) {
    case 'Space':       e.preventDefault(); togglePlay(); break;
    case 'ArrowRight':  audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); break;
    case 'ArrowLeft':   audio.currentTime = Math.max(0, audio.currentTime - 5); break;
    case 'ArrowUp':
      audio.volume = Math.min(1, audio.volume + 0.05);
      volumeSlider.value = audio.volume;
      volValue.textContent = `${Math.round(audio.volume * 100)}%`;
      updateVolIcon(audio.volume);
      break;
    case 'ArrowDown':
      audio.volume = Math.max(0, audio.volume - 0.05);
      volumeSlider.value = audio.volume;
      volValue.textContent = `${Math.round(audio.volume * 100)}%`;
      updateVolIcon(audio.volume);
      break;
    case 'KeyN':        playNext(); break;
    case 'KeyP':        playPrev(); break;
    case 'KeyM':        cycleMode(); break;
  }
});

// ==============================
// 拖拽文件到窗口
// ==============================
document.addEventListener('dragover', e => { e.preventDefault(); document.body.style.outline = '2px dashed #a78bfa'; });
document.addEventListener('dragleave', () => { document.body.style.outline = ''; });
document.addEventListener('drop', e => {
  e.preventDefault();
  document.body.style.outline = '';
  const files = Array.from(e.dataTransfer.files);
  loadFiles(files);
});

// ==============================
// 按钮事件绑定
// ==============================
playBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', playPrev);
nextBtn.addEventListener('click', playNext);
// 模式切换已由 3 个独立按钮处理（btn-mode-repeatOne / repeat / shuffle）

btnOpenFile.addEventListener('click', async () => {
  if (IS_ELECTRON) {
    const paths = await window.electronAPI.openFile();
    if (paths && paths.length > 0) loadFiles(paths);
  } else {
    fileInput.click();
  }
});

btnOpenFolder.addEventListener('click', async () => {
  if (IS_ELECTRON) {
    const paths = await window.electronAPI.openFolder();
    if (paths && paths.length > 0) loadFiles(paths);
  } else if (window.AndroidDirectoryPicker && window.AndroidDirectoryPicker.plugin) {
    // Android 13+ SAF 目录选择
    try {
      const result = await window.AndroidDirectoryPicker.pickDirectory();
      if (result && result.files && result.files.length > 0) {
        // 把 SAF 返回的文件信息转为播放器可识别的格式
        const treeUri = result.uri;
        for (const f of result.files) {
          // 保存 SAF 信息，播放时通过 SAF 读取
          // _safTreeUri 统一命名（playAt 中用 _safTreeUri 和 _safDocumentId）
          f._treeUri = treeUri;
          f._isSafFile = true;
        }
        loadSafFiles(result.files, treeUri);
      }
    } catch (e) {
      console.error('[SAF] 目录选择失败:', e);
      // 回退到传统方式
      folderInput.click();
    }
  } else {
    folderInput.click();
  }
});

fileInput.addEventListener('change', e => { loadFiles(Array.from(e.target.files)); fileInput.value = ''; });
folderInput.addEventListener('change', e => { loadFiles(Array.from(e.target.files)); folderInput.value = ''; });

// Electron：监听主进程推送的文件
if (IS_ELECTRON) {
  window.electronAPI.onOpenFiles(paths => loadFiles(paths));
  window.electronAPI.onOpenFolder(folder => {
    const files = window.electronAPI.readDir(folder);
    if (files.length > 0) loadFiles(files);
  });
  window.electronAPI.onCommand(cmd => {
    if (cmd === 'togglePlay') togglePlay();
    else if (cmd === 'prev')    playPrev();
    else if (cmd === 'next')    playNext();
    else if (cmd === 'volUp')   { audio.volume = Math.min(1, audio.volume + 0.05); volumeSlider.value = audio.volume; volValue.textContent = `${Math.round(audio.volume*100)}%`; updateVolIcon(audio.volume); }
    else if (cmd === 'volDown') { audio.volume = Math.max(0, audio.volume - 0.05); volumeSlider.value = audio.volume; volValue.textContent = `${Math.round(audio.volume*100)}%`; updateVolIcon(audio.volume); }
    else if (cmd === 'openTranscode') {
      if (!appSettings.transcodeEnabled) { if (typeof showToast === 'function') showToast('转码功能已关闭，请在「设置」中开启'); }
      else document.getElementById('transcode-overlay')?.classList.remove('hidden');
    }
  });
}

// ==============================
// 窗口大小变化时重新计算虚拟化
// ==============================
window.addEventListener('resize', () => {
  VIRTUAL_CONFIG.containerHeight = playlistEl.clientHeight;
  if (state.playlist.length > 0) {
    renderVisibleItems();
  }
});

// ==============================
// 均衡器功能
// ==============================
function initEqualizer() {
  if (!window.AudioContext && !window.webkitAudioContext) {
    console.warn('[EQ] 浏览器不支持 Web Audio API');
    return;
  }

  // 创建音频上下文
  eqState.audioContext = new (window.AudioContext || window.webkitAudioContext)();

  // 创建源节点（从 audio 元素）
  eqState.source = eqState.audioContext.createMediaElementSource(audio);

  // 创建 10 个滤波器
  eqState.filters = [];
  let lastNode = eqState.source;

  eqState.frequencies.forEach((freq, index) => {
    const filter = eqState.audioContext.createBiquadFilter();
    filter.type = 'peaking';
    filter.frequency.value = freq;
    filter.Q.value = 1.4;
    filter.gain.value = 0;

    // 串联连接
    lastNode.connect(filter);
    lastNode = filter;
    eqState.filters.push(filter);
  });

  // 连接到输出
  lastNode.connect(eqState.audioContext.destination);

  console.log('[EQ] 均衡器已初始化');
}

function setEQGain(index, gain) {
  if (!eqState.filters[index]) return;
  eqState.filters[index].gain.value = gain;
}

function applyEQPreset(presetName) {
  const preset = eqState.presets[presetName];
  if (!preset) return;

  const sliders = document.querySelectorAll('.eq-slider-vertical');
  sliders.forEach((slider, index) => {
    const value = preset[index] || 0;
    slider.value = value;
    updateEQDisplay(index, value);
    if (eqState.enabled) {
      setEQGain(index, value);
    }
  });
}

function updateEQDisplay(index, value) {
  const band = document.querySelector(`.eq-band[data-index="${index}"]`);
  if (band) {
    const dbLabel = band.querySelector('.eq-db');
    if (dbLabel) {
      dbLabel.textContent = value > 0 ? `+${value}` : value;
    }
    // 同时更新滑块值
    const slider = band.querySelector('.eq-slider-vertical');
    if (slider) {
      slider.value = value;
    }
  }
}

function toggleEQ(enabled) {
  ensureEqInit();
  eqState.enabled = enabled;
  appSettings.eqEnabled = enabled;
  saveSettings();
  const btn = document.getElementById('btn-eq-toggle');

  if (enabled) {
    btn.textContent = '开启';
    btn.classList.add('active');
    // 应用当前滑块值
    document.querySelectorAll('.eq-slider').forEach((slider, index) => {
      setEQGain(index, parseFloat(slider.value));
    });
  } else {
    btn.textContent = '关闭';
    btn.classList.remove('active');
    // 重置所有增益为 0
    eqState.filters.forEach(filter => {
      filter.gain.value = 0;
    });
  }
}

// ==============================
// 均衡器面板控制
// ==============================
function ensureEqInit() {
  if (!eqState.audioContext) {
    try { initEqualizer(); } catch (e) { console.error('[EQ] 初始化失败:', e); }
  }
}

function openEqualizer() {
  ensureEqInit();
  document.getElementById('equalizer-overlay')?.classList.remove('hidden');
  startEQVisualizer();
}

function closeEqualizer() {
  document.getElementById('equalizer-overlay')?.classList.add('hidden');
  stopEQVisualizer();
}

// ==============================
// 均衡器可视化
// ==============================
let eqVisualizerId = null;
let eqAnalyser = null;

function startEQVisualizer() {
  const canvas = document.getElementById('eq-canvas');
  if (!canvas || !eqState.audioContext) return;

  const ctx = canvas.getContext('2d');

  // 创建分析器
  if (!eqAnalyser && eqState.filters.length > 0) {
    eqAnalyser = eqState.audioContext.createAnalyser();
    eqAnalyser.fftSize = 256;
    // 连接到最后一级滤波器
    eqState.filters[eqState.filters.length - 1].disconnect();
    eqState.filters[eqState.filters.length - 1].connect(eqAnalyser);
    eqAnalyser.connect(eqState.audioContext.destination);
  }

  if (!eqAnalyser) return;

  const bufferLength = eqAnalyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    eqVisualizerId = requestAnimationFrame(draw);

    eqAnalyser.getByteFrequencyData(dataArray);

    ctx.fillStyle = 'rgba(20, 16, 50, 0.3)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 2.5;
    let barHeight;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      barHeight = (dataArray[i] / 255) * canvas.height * 0.8;

      const gradient = ctx.createLinearGradient(0, canvas.height - barHeight, 0, canvas.height);
      gradient.addColorStop(0, '#34d399');
      gradient.addColorStop(1, 'rgba(52, 211, 153, 0.2)');

      ctx.fillStyle = gradient;
      ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

      x += barWidth + 1;
    }
  }

  draw();
}

function stopEQVisualizer() {
  if (eqVisualizerId) {
    cancelAnimationFrame(eqVisualizerId);
    eqVisualizerId = null;
  }
}

// ==============================
// 均衡器事件绑定
// ==============================
function bindEqualizerEvents() {
  // 打开/关闭面板
  document.getElementById('btn-equalizer')?.addEventListener('click', openEqualizer);
  document.getElementById('btn-close-equalizer')?.addEventListener('click', closeEqualizer);

  // 点击遮罩关闭
  document.getElementById('equalizer-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'equalizer-overlay') closeEqualizer();
  });

  // 滑块事件 - 使用新的选择器
  document.querySelectorAll('.eq-slider-vertical').forEach((slider) => {
    const index = parseInt(slider.parentElement.dataset.index);
    slider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      updateEQDisplay(index, value);
      if (eqState.enabled) {
        setEQGain(index, value);
      }
    });
  });

  // 开关按钮
  document.getElementById('btn-eq-toggle')?.addEventListener('click', () => {
    toggleEQ(!eqState.enabled);
  });

  // 预设选择
  document.getElementById('eq-preset')?.addEventListener('change', (e) => {
    applyEQPreset(e.target.value);
  });
}

// ==============================
// 外观设置（模糊 / 毛玻璃）
// ==============================
const SETTINGS_KEY = 'musicplayer_appearance';
const SETTINGS_DEFAULT = {
  blurOn: true, blurPx: 10,
  frostOn: true, frostPct: 18,
  eqEnabled: true,   // 均衡器开关：true=启动即加载 AudioContext；false=启动不加载（首次打开面板再懒加载）
  transcodeEnabled: false, // 转码开关：false=启动不初始化原生 FFmpeg（不占内存）；true=启用后懒加载
  coverRotEnabled: true,   // 封面旋转：true=封面圆显示歌曲同目录封面图并随播放旋转；false=保持音符标志
  lyricEnabled: true,      // 歌词显示开关（同目录 .lrc）
  lyricFontSize: 15,       // 歌词字号 px
  lyricColor: '#ffffff',   // 歌词颜色（默认白色，透明设计）
  lyricRainbow: false,     // 炫彩流逝样式（当前行渐变色流动）
  appTitle: 'MusicPlayer-一切皆可自定',  // 顶栏左上角自定义文字
  showLogoMark: true,       // 是否显示音符 🎵 标志
  colorTitlebar: '#f1f0ff',
  colorPlaylist: '#f1f0ff',
  colorMain: '#f1f0ff',
  colorTranscode: '#111111',  // 转码面板文字默认黑色（毛玻璃下浅色看不清）
  colorEqualizer: '#f1f0ff',
};
let appSettings = { ...SETTINGS_DEFAULT };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) appSettings = Object.assign({}, SETTINGS_DEFAULT, JSON.parse(raw));
  } catch { appSettings = { ...SETTINGS_DEFAULT }; }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings)); } catch {}
}

// 把设置写入 CSS 变量（titlebar / playlist / 两个 modal 都引用）
function applySettings() {
  const root = document.documentElement.style;
  const blur = appSettings.blurOn ? appSettings.blurPx : 0;
  const alpha = appSettings.frostOn ? (appSettings.frostPct / 100) : 0;
  root.setProperty('--glass-blur', blur + 'px');
  root.setProperty('--glass-frost', alpha.toFixed(3));
  root.setProperty('--text-titlebar', appSettings.colorTitlebar);
  root.setProperty('--text-playlist', appSettings.colorPlaylist);
  root.setProperty('--text-main', appSettings.colorMain);
  root.setProperty('--text-transcode', appSettings.colorTranscode);
  root.setProperty('--text-equalizer', appSettings.colorEqualizer);
  root.setProperty('--lyric-size', (appSettings.lyricFontSize || 15) + 'px');
  root.setProperty('--lyric-color', appSettings.lyricColor || '#ffffff');
  if (lyricSection) lyricSection.classList.toggle('rainbow', !!(appSettings.lyricEnabled && appSettings.lyricRainbow));
  applyAppTitle();
}

// 应用标题：把顶栏 logo 文字与音符标志写到 DOM（自定义文字，持久化到设置）
// 文字清空时不回退成 "MusicPlayer"，直接隐藏文字节点
function applyAppTitle() {
  const logoText = document.getElementById('logo-text');
  const title = (appSettings.appTitle || '').trim();
  if (logoText) {
    logoText.textContent = title;
    logoText.style.display = title ? '' : 'none';
  }
  const logoMark = document.getElementById('logo-mark');
  if (logoMark) logoMark.style.display = appSettings.showLogoMark ? '' : 'none';
}

// 转码开关：控制顶栏「转码」按钮是否可用，以及是否允许原生 FFmpeg 初始化
function applyTranscodeEnabled() {
  const btn = document.getElementById('btn-transcode');
  if (!btn) return;
  if (appSettings.transcodeEnabled) {
    btn.disabled = false;
    btn.classList.remove('tc-disabled');
    btn.title = '转码工具';
  } else {
    btn.disabled = true;
    btn.classList.add('tc-disabled');
    btn.title = '转码功能已关闭，请在「设置」中开启';
  }
}

function bindSettingsEvents() {
  const overlay = document.getElementById('settings-overlay');
  document.getElementById('btn-settings')?.addEventListener('click', () => overlay?.classList.remove('hidden'));
  document.getElementById('btn-close-settings')?.addEventListener('click', () => overlay?.classList.add('hidden'));
  overlay?.addEventListener('click', (e) => { if (e.target.id === 'settings-overlay') overlay.classList.add('hidden'); });

  // 模糊：开关 + 滑块(px)
  const blurToggle = document.getElementById('set-blur-toggle');
  const blurSlider = document.getElementById('set-blur-slider');
  const blurVal = document.getElementById('set-blur-val');
  const refreshBlur = () => {
    blurSlider.value = appSettings.blurPx;
    blurVal.textContent = appSettings.blurPx + 'px';
    blurToggle.classList.toggle('active', appSettings.blurOn);
    blurToggle.textContent = appSettings.blurOn ? '开启' : '关闭';
    applySettings(); saveSettings();
  };
  blurToggle?.addEventListener('click', () => { appSettings.blurOn = !appSettings.blurOn; refreshBlur(); });
  blurSlider?.addEventListener('input', (e) => { appSettings.blurPx = parseInt(e.target.value) || 0; refreshBlur(); });

  // 毛玻璃：开关 + 滑块(%) + 加减号
  const frostToggle = document.getElementById('set-frost-toggle');
  const frostSlider = document.getElementById('set-frost-slider');
  const frostVal = document.getElementById('set-frost-val');
  const frostMinus = document.getElementById('set-frost-minus');
  const frostPlus = document.getElementById('set-frost-plus');
  const refreshFrost = () => {
    frostSlider.value = appSettings.frostPct;
    frostVal.textContent = appSettings.frostPct + '%';
    frostToggle.classList.toggle('active', appSettings.frostOn);
    frostToggle.textContent = appSettings.frostOn ? '开启' : '关闭';
    applySettings(); saveSettings();
  };
  frostToggle?.addEventListener('click', () => { appSettings.frostOn = !appSettings.frostOn; refreshFrost(); });
  frostSlider?.addEventListener('input', (e) => { appSettings.frostPct = parseInt(e.target.value) || 0; refreshFrost(); });
  const stepFrost = (d) => { appSettings.frostPct = Math.max(0, Math.min(100, appSettings.frostPct + d)); refreshFrost(); };
  frostMinus?.addEventListener('click', () => stepFrost(-5));
  frostPlus?.addEventListener('click', () => stepFrost(5));

  // 文字颜色：每区域一个取色器，实时写入 CSS 变量
  const colorMap = {
    'set-color-titlebar':  ['colorTitlebar',  '--text-titlebar'],
    'set-color-playlist':  ['colorPlaylist',  '--text-playlist'],
    'set-color-main':      ['colorMain',      '--text-main'],
    'set-color-transcode': ['colorTranscode', '--text-transcode'],
    'set-color-equalizer': ['colorEqualizer', '--text-equalizer'],
  };
  const refreshColors = () => {
    Object.entries(colorMap).forEach(([id, [key, varName]]) => {
      const el = document.getElementById(id);
      if (el) { el.value = appSettings[key]; document.documentElement.style.setProperty(varName, appSettings[key]); }
    });
    applySettings(); saveSettings();
  };
  Object.entries(colorMap).forEach(([id, [key]]) => {
    const el = document.getElementById(id);
    el?.addEventListener('input', (e) => { appSettings[key] = e.target.value; refreshColors(); });
  });
  document.getElementById('set-color-reset')?.addEventListener('click', () => {
    appSettings.colorTitlebar  = SETTINGS_DEFAULT.colorTitlebar;
    appSettings.colorPlaylist  = SETTINGS_DEFAULT.colorPlaylist;
    appSettings.colorMain      = SETTINGS_DEFAULT.colorMain;
    appSettings.colorTranscode = SETTINGS_DEFAULT.colorTranscode;
    appSettings.colorEqualizer = SETTINGS_DEFAULT.colorEqualizer;
    refreshColors();
    if (typeof showToast === 'function') showToast('已恢复默认文字颜色');
  });

  // 应用标题：自定义文字 + 音符标志开关
  const appTitleInput = document.getElementById('set-app-title');
  const refreshAppTitle = () => {
    if (appTitleInput) {
      appTitleInput.value = appSettings.appTitle || '';
      const logoText = document.getElementById('logo-text');
      if (logoText) {
        const title = (appSettings.appTitle || '').trim();
        logoText.textContent = title;
        logoText.style.display = title ? '' : 'none';
      }
    }
    saveSettings();
  };
  appTitleInput?.addEventListener('input', (e) => { appSettings.appTitle = e.target.value; refreshAppTitle(); });

  // 音符标志开关
  const markToggle = document.getElementById('set-logo-mark-toggle');
  const refreshMark = () => {
    if (markToggle) {
      markToggle.classList.toggle('active', appSettings.showLogoMark);
      markToggle.textContent = appSettings.showLogoMark ? '开启' : '关闭';
      const logoMark = document.getElementById('logo-mark');
      if (logoMark) logoMark.style.display = appSettings.showLogoMark ? '' : 'none';
    }
    saveSettings();
  };
  markToggle?.addEventListener('click', () => { appSettings.showLogoMark = !appSettings.showLogoMark; refreshMark(); });

  // 初始化应用标题 UI 状态（打开设置时输入框/开关同步当前值）
  refreshAppTitle(); refreshMark();

  // 转码开关
  const tcToggle = document.getElementById('set-transcode-toggle');
  const refreshTranscode = () => {
    tcToggle.classList.toggle('active', appSettings.transcodeEnabled);
    tcToggle.textContent = appSettings.transcodeEnabled ? '开启' : '关闭';
    applyTranscodeEnabled();
    saveSettings();
    // 运行时开启：立即懒加载原生 FFmpeg（仅 Android），关闭则不加载
    if (appSettings.transcodeEnabled && window.AndroidFFmpeg && !window.AndroidFFmpeg.ready) {
      window.AndroidFFmpeg.init().then(ok => {
        window.dispatchEvent(new CustomEvent('android-ffmpeg-ready', { detail: { ready: ok } }));
      });
    }
  };
  tcToggle?.addEventListener('click', () => { appSettings.transcodeEnabled = !appSettings.transcodeEnabled; refreshTranscode(); });

  // 封面旋转开关
  const coverRotToggle = document.getElementById('set-cover-rot-toggle');
  const refreshCoverRot = () => {
    if (coverRotToggle) {
      coverRotToggle.classList.toggle('active', appSettings.coverRotEnabled);
      coverRotToggle.textContent = appSettings.coverRotEnabled ? '开启' : '关闭';
    }
    // 立即生效：当前歌若无封面显示则回退音符
    const t = state.playlist[state.currentIndex];
    if (t) setCoverArt(appSettings.coverRotEnabled ? (t._coverUrl || null) : null, t.color);
    saveSettings();
  };
  coverRotToggle?.addEventListener('click', () => { appSettings.coverRotEnabled = !appSettings.coverRotEnabled; refreshCoverRot(); });

  // 歌词：开关 / 字号 / 颜色 / 炫彩
  const lyricToggle = document.getElementById('set-lyric-toggle');
  const lyricSizeInput = document.getElementById('set-lyric-size');
  const lyricColorInput = document.getElementById('set-lyric-color');
  const lyricRainbowToggle = document.getElementById('set-lyric-rainbow-toggle');
  const refreshLyric = () => {
    if (lyricToggle) {
      lyricToggle.classList.toggle('active', appSettings.lyricEnabled);
      lyricToggle.textContent = appSettings.lyricEnabled ? '开启' : '关闭';
    }
    if (lyricSizeInput) lyricSizeInput.value = appSettings.lyricFontSize;
    if (lyricColorInput) lyricColorInput.value = appSettings.lyricColor;
    if (lyricRainbowToggle) {
      lyricRainbowToggle.classList.toggle('active', appSettings.lyricRainbow);
      lyricRainbowToggle.textContent = appSettings.lyricRainbow ? '开启' : '关闭';
    }
    applySettings();
    // 立即刷新当前歌词显示（可能因开关隐藏/显示）
    const t = state.playlist[state.currentIndex];
    if (t) {
      if (appSettings.lyricEnabled && t._isSafFile && !t._lrc && t._lyricDocId) {
        loadLyrics(t);  // 首次打开开关时补读当前歌歌词
      } else if (t._lrc) {
        renderLyricWindow(t, audio.currentTime || 0);
      } else {
        resetLyricDisplay();
      }
    }
    saveSettings();
  };
  lyricToggle?.addEventListener('click', () => { appSettings.lyricEnabled = !appSettings.lyricEnabled; refreshLyric(); });
  lyricSizeInput?.addEventListener('change', (e) => {
    const v = Math.max(10, Math.min(28, parseInt(e.target.value, 10) || 15));
    appSettings.lyricFontSize = v; e.target.value = v; applySettings(); saveSettings();
  });
  lyricColorInput?.addEventListener('input', (e) => { appSettings.lyricColor = e.target.value; applySettings(); saveSettings(); });
  lyricRainbowToggle?.addEventListener('click', () => { appSettings.lyricRainbow = !appSettings.lyricRainbow; refreshLyric(); });

  // 恢复默认
  document.getElementById('set-reset')?.addEventListener('click', () => {
    appSettings = { ...SETTINGS_DEFAULT };
    refreshBlur(); refreshFrost(); refreshColors(); refreshTranscode(); refreshAppTitle(); refreshMark();
    refreshCoverRot(); refreshLyric();
    if (typeof showToast === 'function') showToast('已恢复默认外观');
  });

  refreshBlur(); refreshFrost(); refreshColors(); refreshTranscode(); refreshCoverRot(); refreshLyric();
}

function initSettings() {
  loadSettings();
  applySettings();
  bindSettingsEvents();
  applyTranscodeEnabled();
}

// ================================================================
// 背景来源（动态 / 系统 / 图片 / 视频）
// ================================================================
const BG_KEY = 'musicplayer_bg';
const bgState = {
  source: 'system',   // live | system | image | solid；默认系统静态壁纸，避免首次启动就弹出透明动态壁纸
  image: null,        // dataURL（可持久化）
  solid: null,        // 纯色背景色值（可持久化）
};
const bgEl = () => document.getElementById('bg');

function loadBg() {
  try {
    const raw = localStorage.getItem(BG_KEY);
    if (raw) Object.assign(bgState, JSON.parse(raw));
  } catch { /* keep default */ }
  // 兼容升级：旧版可能存过 'video'，不在新来源集合内则回退系统壁纸
  if (!['live', 'system', 'image', 'solid'].includes(bgState.source)) {
    bgState.source = 'system';
  }
}

function saveBg() {
  try { localStorage.setItem(BG_KEY, JSON.stringify(bgState)); } catch {}
}

function clearBgVisual() {
  const el = bgEl();
  if (!el) return;
  el.style.backgroundImage = 'none';
  const v = el.querySelector('video.bg-video');
  if (v) v.remove();
}

async function applyBackground() {
  const el = bgEl();
  if (!el) return;
  clearBgVisual();

  if (bgState.source === 'live') {
    // 透明窗口 + FLAG_SHOW_WALLPAPER 已透出第三方动态壁纸。
    // 叠加一层极淡渐变衬底，使顶栏/侧栏/文件夹栏的毛玻璃有可模糊内容（壁纸仍基本可见）。
    el.style.backgroundImage = 'linear-gradient(160deg, rgba(20,16,48,0.18), rgba(20,16,48,0.05))';
    el.style.backgroundColor = 'transparent';
    return;
  }
  if (bgState.source === 'system') {
    await applySystemWallpaper(el);
    return;
  }
  if (bgState.source === 'image' && bgState.image) {
    el.style.backgroundImage = `url(${bgState.image})`;
    return;
  }
  if (bgState.source === 'solid' && bgState.solid) {
    el.style.backgroundImage = 'none';
    el.style.backgroundColor = bgState.solid;
    return;
  }
  // 其它情况回退到渐变背景（保证毛玻璃始终有可模糊的内容）
  el.style.backgroundImage = 'linear-gradient(135deg, #6d28d9 0%, #2563eb 45%, #db2777 100%)';
  el.style.backgroundColor = 'transparent';
}

async function applySystemWallpaper(el) {
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.WallpaperPlugin) {
      const r = await window.Capacitor.Plugins.WallpaperPlugin.getSystemWallpaper();
      if (r && r.data) {
        el.style.backgroundImage = `url(${r.data})`;
        el.style.backgroundColor = 'transparent';
        return;
      }
    }
    showToast('系统壁纸不可用，已使用渐变背景');
    el.style.backgroundImage = 'linear-gradient(135deg, #6d28d9 0%, #2563eb 45%, #db2777 100%)';
    el.style.backgroundColor = 'transparent';
  } catch (e) {
    console.warn('[Bg] 系统壁纸失败:', e);
    showToast('系统壁纸读取失败，已使用渐变背景');
    el.style.backgroundImage = 'linear-gradient(135deg, #6d28d9 0%, #2563eb 45%, #db2777 100%)';
    el.style.backgroundColor = 'transparent';
  }
}

// 纯色背景：标准色 + 柔光版（不刺眼，低饱和）
const SOLID_STANDARD = [
  '#ef9a9a', '#f48fb1', '#ce93d8', '#9fa8da', '#90caf9',
  '#80deea', '#a5d6a7', '#ffe082', '#ffcc80', '#bcaaa4',
];
const SOLID_SOFT = [
  '#f7b7c8', '#f9c5d5', '#c8e6c9', '#bfe8d8', '#bbd9f2',
  '#b3d4ed', '#d9c7ee', '#f7e6b3', '#f8d2b8', '#bfe3e6',
];

const solidOverlayEl = () => document.getElementById('solid-color-overlay');

function makeSolidSwatch(col) {
  const b = document.createElement('button');
  b.className = 'solid-swatch';
  b.style.background = col;
  b.title = col;
  b.addEventListener('click', () => {
    bgState.source = 'solid';
    bgState.solid = col;
    saveBg();
    applyBackground();
    const ov = solidOverlayEl();
    if (ov) ov.classList.add('hidden');
    if (typeof showToast === 'function') showToast('已应用纯色：' + col);
  });
  return b;
}

function buildSolidSwatches() {
  const std = document.getElementById('solid-standard');
  const soft = document.getElementById('solid-soft');
  if (std) {
    std.innerHTML = '';
    SOLID_STANDARD.forEach((col) => std.appendChild(makeSolidSwatch(col)));
  }
  if (soft) {
    soft.innerHTML = '';
    SOLID_SOFT.forEach((col) => soft.appendChild(makeSolidSwatch(col)));
  }
}

function openSolidColorPicker() {
  const ov = solidOverlayEl();
  if (ov) ov.classList.remove('hidden');
}

// 进入「自定义纯色」来源：无已选颜色时给一个默认（标准色首个），并弹出选择菜单
function enterSolidSource() {
  if (!bgState.solid) {
    bgState.solid = SOLID_STANDARD[0];
    saveBg();
    applyBackground();
  }
  openSolidColorPicker();
}

function bindSolidColorPicker() {
  buildSolidSwatches();
  const ov = solidOverlayEl();
  const closeBtn = document.getElementById('solid-color-close');
  if (closeBtn) closeBtn.addEventListener('click', () => { if (ov) ov.classList.add('hidden'); });
  if (ov) ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.add('hidden'); });
}

// ================================================================
// 图片裁剪（裁剪框按设备屏幕比例自动缩放，拖动选择区域，canvas 导出）
// ================================================================
let cropDragging = false;
let cropDragOff = { x: 0, y: 0 };
let prevBgSource = 'live';

// 根据设备屏幕宽高比，把裁剪框缩放到舞台内（随屏幕大小比例变化）
function sizeCropFrame() {
  const stage = document.getElementById('crop-stage');
  const frame = document.getElementById('crop-frame');
  if (!stage || !frame) return;
  const sr = stage.getBoundingClientRect();
  if (sr.width === 0 || sr.height === 0) return;
  // 设备屏幕宽高比（横屏/竖屏不同，比例随之变化）
  const ar = (window.screen && window.screen.width && window.screen.height)
    ? (window.screen.width / window.screen.height)
    : (sr.width / sr.height);
  const fill = 0.86; // 框占舞台比例，随屏幕缩放
  let w = sr.width * fill;
  let h = w / ar;
  if (h > sr.height * fill) { h = sr.height * fill; w = h * ar; }
  frame.style.width = Math.round(w) + 'px';
  frame.style.height = Math.round(h) + 'px';
  frame.style.left = Math.round((sr.width - w) / 2) + 'px';
  frame.style.top = Math.round((sr.height - h) / 2) + 'px';
  frame.style.transform = 'none';
}

// 撤销本次图片选择，回到之前的背景来源
function revertBgSource() {
  bgState.source = prevBgSource;
  saveBg();
  applyBackground();
  const cur = document.querySelector(`input[name="bgsrc"][value="${prevBgSource}"]`);
  if (cur) cur.checked = true;
}

function openCrop() {
  const overlay = document.getElementById('crop-overlay');
  // 兜底：背景来源选择只发生在「设置」面板内，面板未打开（首启/初始化）时绝不弹裁剪
  const settingsEl = document.getElementById('settings-overlay');
  if (settingsEl && settingsEl.classList.contains('hidden')) {
    console.log('[Crop] 设置面板未打开，忽略 openCrop');
    return;
  }
  const FP = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FilePicker;
  const showImg = (src) => {
    const img = document.getElementById('crop-img');
    if (!img) return;
    img.onload = () => { sizeCropFrame(); overlay.classList.remove('hidden'); };
    img.src = src;
  };
  if (FP && FP.pickImage) {
    FP.pickImage().then(res => {
      if (!res || !res.data) return;
      showImg(res.data);
    }).catch(err => {
      revertBgSource(); // 取消选择 → 回退之前来源
      if (typeof showToast === 'function') showToast(typeof err === 'string' ? err : '未选择图片');
    });
    return;
  }
  // 桌面 Electron 回退：<input type=file> 可用
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const f = input.files && input.files[0];
    if (!f) { revertBgSource(); return; }
    const reader = new FileReader();
    reader.onload = () => showImg(reader.result);
    reader.readAsDataURL(f);
  };
  input.click();
}

// 裁剪框锁定比例 = 设备屏幕宽高比（横竖屏不同）
function cropAR() {
  if (window.screen && window.screen.width && window.screen.height) {
    return window.screen.width / window.screen.height;
  }
  return 1;
}

function bindCropEvents() {
  const overlay = document.getElementById('crop-overlay');
  const frame = document.getElementById('crop-frame');
  const stage = document.getElementById('crop-stage');
  const handle = document.getElementById('crop-handle');
  const settings = document.getElementById('settings-overlay');
  if (!frame || !stage) return;

  let mode = null;                 // 'move' | 'resize'
  let offX = 0, offY = 0;        // 拖动偏移（move）
  let sW = 0, sH = 0, sL = 0, sT = 0, sPX = 0, sPY = 0; // resize 起点

  const pt = (e) => (e.touches && e.touches[0]) ? e.touches[0] : e;

  const onDownMove = (e) => {
    if (mode) return;
    mode = 'move';
    const r = frame.getBoundingClientRect();
    const p = pt(e);
    offX = p.clientX - r.left;
    offY = p.clientY - r.top;
    try { frame.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  };
  const onDownResize = (e) => {
    mode = 'resize';
    const r = frame.getBoundingClientRect();
    sW = r.width; sH = r.height; sL = r.left; sT = r.top;
    const p = pt(e);
    sPX = p.clientX; sPY = p.clientY;
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    e.stopPropagation(); // 避免触发 move
  };
  const onMove = (e) => {
    if (!mode) return;
    const p = pt(e);
    const sr = stage.getBoundingClientRect();
    if (mode === 'move') {
      let x = p.clientX - sr.left - offX;
      let y = p.clientY - sr.top - offY;
      x = Math.max(0, Math.min(sr.width - frame.offsetWidth, x));
      y = Math.max(0, Math.min(sr.height - frame.offsetHeight, y));
      frame.style.left = Math.round(x) + 'px';
      frame.style.top = Math.round(y) + 'px';
    } else {
      // 右下角手柄缩放，锁定屏幕比例（左上角锚定）
      const AR = cropAR();
      const dx = p.clientX - sPX;
      const dy = p.clientY - sPY;
      let newW = sW + Math.max(dx, dy * AR);
      const minW = 40;
      const maxW = (sr.left + sr.width) - sL;   // 不超出舞台右
      const maxH = (sr.top + sr.height) - sT;     // 不超出舞台下
      newW = Math.max(minW, Math.min(newW, maxW, maxH * AR));
      const newH = newW / AR;
      frame.style.left = Math.round(sL - sr.left) + 'px';
      frame.style.top = Math.round(sT - sr.top) + 'px';
      frame.style.width = Math.round(newW) + 'px';
      frame.style.height = Math.round(newH) + 'px';
    }
    e.preventDefault();
  };
  const onUp = () => { mode = null; };

  // Pointer 事件（鼠标/触摸统一）
  frame.addEventListener('pointerdown', onDownMove);
  if (handle) handle.addEventListener('pointerdown', onDownResize);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  // 老版本无 PointerEvent 时回退 touch
  if (!window.PointerEvent) {
    frame.addEventListener('touchstart', onDownMove, { passive: false });
    if (handle) handle.addEventListener('touchstart', onDownResize, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  }

  // 旋转/尺寸变化时重新缩放裁剪框
  window.addEventListener('resize', () => {
    if (overlay && !overlay.classList.contains('hidden')) sizeCropFrame();
  });

  document.getElementById('btn-crop-cancel')?.addEventListener('click', () => {
    overlay.classList.add('hidden');
    if (settings) settings.classList.add('hidden'); // 回到主界面
    revertBgSource(); // 撤销本次选择
  });
  document.getElementById('btn-crop-ok')?.addEventListener('click', () => {
    doCrop();
    overlay.classList.add('hidden');
    if (settings) settings.classList.add('hidden'); // 回到主界面
  });
}

function doCrop() {
  const img = document.getElementById('crop-img');
  const frame = document.getElementById('crop-frame');
  const stage = document.getElementById('crop-stage');
  const sr = stage.getBoundingClientRect();
  const fr = frame.getBoundingClientRect();
  const nW = img.naturalWidth, nH = img.naturalHeight;
  if (!nW || !nH) return;
  // object-fit:cover 的精确映射（图片填满舞台后按框选区域反算自然像素）
  const s = Math.max(sr.width / nW, sr.height / nH);
  const ox = (sr.width - nW * s) / 2;
  const oy = (sr.height - nH * s) / 2;
  const fx = fr.left - sr.left, fy = fr.top - sr.top;
  const sx = (fx - ox) / s;
  const sy = (fy - oy) / s;
  const sw = fr.width / s;
  const sh = fr.height / s;

  const cx = Math.max(0, Math.round(sx));
  const cy = Math.max(0, Math.round(sy));
  const cw = Math.min(nW - cx, Math.round(sw));
  const ch = Math.min(nH - cy, Math.round(sh));
  if (cw <= 0 || ch <= 0) return;

  const maxDim = 1080;
  const scale = Math.min(1, maxDim / Math.max(cw, ch));
  const outW = Math.max(1, Math.round(cw * scale));
  const outH = Math.max(1, Math.round(ch * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, cx, cy, cw, ch, 0, 0, outW, outH);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  bgState.source = 'image';
  bgState.image = dataUrl;
  bgState.solid = null;
  saveBg();
  applyBackground();
  if (typeof showToast === 'function') showToast('已应用裁剪后的图片背景');
}

// （已移除「自定义视频」背景；背景来源改为 live / system / image / solid 四类，
//  纯色由上方 SOLID_STANDARD / SOLID_SOFT 调色板在应用内透明菜单中选择）

// ================================================================
// 首开：用户协议 + 数据目录
// ================================================================
const FL_KEY = 'musicplayer_firstlaunch';
const DF_KEY = 'musicplayer_datafolder';
let customFolder = null; // { uri, name }

function dfLabel(v) {
  if (v === 'custom' && customFolder) return '自定义文件夹：' + customFolder.name;
  return ({
    private: '应用私有目录', download: '系统 Download',
    appfolder: 'MusicPlayer 文件夹', custom: '自定义文件夹'
  })[v] || '应用私有目录';
}

function initFirstLaunch() {
  let done = false;
  try { done = localStorage.getItem(FL_KEY) === '1'; } catch {}
  console.log('[FL] start, done=', done, 'FL_KEY=', localStorage.getItem(FL_KEY));
  if (done) { console.log('[FL] already done, skip'); return; } // 已同意过

  const agree = document.getElementById('agreement-overlay');
  const df = document.getElementById('datafolder-overlay');
  const customRow = document.getElementById('df-custom-row');
  const customName = document.getElementById('df-custom-name');
  agree?.classList.remove('hidden');

  // 切换数据目录单选 → 自定义时显示选择行
  document.querySelectorAll('input[name="df"]').forEach(r => {
    r.addEventListener('change', () => {
      if (customRow) customRow.style.display = (r.value === 'custom' && r.checked) ? 'flex' : 'none';
    });
  });

  // 自定义文件夹：调起 SAF 选目录
  document.getElementById('btn-df-pick')?.addEventListener('click', async () => {
    const DP = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DirectoryPicker;
    if (!DP) { if (typeof showToast === 'function') showToast('当前环境不支持文件夹选择'); return; }
    try {
      const res = await DP.pickDirectory();
      if (res && res.uri) {
        customFolder = { uri: res.uri, name: res.name || '已选目录' };
        if (customName) customName.textContent = '已选：' + customFolder.name;
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('未选择文件夹');
    }
  });

  document.getElementById('btn-agree')?.addEventListener('click', () => {
    agree?.classList.add('hidden');
    df?.classList.remove('hidden');
  });

  document.getElementById('btn-disagree')?.addEventListener('click', () => {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.WallpaperPlugin) {
      window.Capacitor.Plugins.WallpaperPlugin.exitApp();
    } else {
      alert('您已拒绝用户协议，应用无法使用。请在系统中关闭或卸载本应用。');
    }
  });

  document.getElementById('btn-df-confirm')?.addEventListener('click', () => {
    const sel = document.querySelector('input[name="df"]:checked');
    const choice = sel ? sel.value : 'private';
    // 自定义必须已选目录
    if (choice === 'custom' && !customFolder) {
      if (typeof showToast === 'function') showToast('请先点击「选择文件夹」指定目录');
      return;
    }
    try {
      const payload = choice === 'custom'
        ? JSON.stringify({ type: 'custom', uri: customFolder.uri, name: customFolder.name })
        : choice;
      localStorage.setItem(DF_KEY, payload);
      localStorage.setItem(FL_KEY, '1');
    } catch {}
    df?.classList.add('hidden');
    if (typeof showToast === 'function') showToast('数据将保存到：' + dfLabel(choice));
  });
}

// ================================================================
// 背景来源设置绑定
// ================================================================
function bindBackgroundSettings() {
  const radios = document.querySelectorAll('input[name="bgsrc"]');
  const hint = document.getElementById('bg-src-hint');
  // 关键修复：用 click 而非 change。部分 Android WebView 会在脚本设置 checked=true 时
  // 异步触发 change，导致首启/取消裁剪时反复误弹「选择背景图片区域」，且点「取消」
  // 里的 revertBgSource() 又会设 checked=true → 又异步 change → 无限重开、关不掉。
  // click 只由用户真实点击触发，脚本设置 checked 不会触发 click，从源头根治。
  radios.forEach(r => {
    r.addEventListener('click', async () => {
      if (!r.checked) return;
      // 背景来源只在「设置」面板内：面板未打开（首启/初始化）时不响应
      const settingsEl = document.getElementById('settings-overlay');
      if (settingsEl && settingsEl.classList.contains('hidden')) return;
      // 首启流程（协议/数据目录页）未完成时不响应
      let firstDone = false;
      try { firstDone = localStorage.getItem(FL_KEY) === '1'; } catch {}
      if (!firstDone) return;
      prevBgSource = bgState.source;
      bgState.source = r.value;
      saveBg();
      if (r.value === 'live') {
        if (hint) hint.textContent = '窗口透明，透出第三方动态壁纸。';
        applyBackground();
      } else if (r.value === 'system') {
        if (hint) hint.textContent = '正在读取系统静态壁纸…';
        await applyBackground();
        if (hint) hint.textContent = '系统静态壁纸（动态壁纸激活时可能为默认图）。';
      } else if (r.value === 'image') {
        if (hint) hint.textContent = '请选择并裁剪一张图片。';
        openCrop();
      } else if (r.value === 'solid') {
        if (hint) hint.textContent = '请选择一个纯色（标准色 / 柔光版）。';
        enterSolidSource();
      }
    });
  });
  bindSolidColorPicker();
  const cur = document.querySelector(`input[name="bgsrc"][value="${bgState.source}"]`);
  if (cur) cur.checked = true;
}

// ==============================
// 初始化
// ==============================
audio.volume = 0.8;
updatePlayBtn();
// 默认列表循环
setPlayMode('repeat');

// 初始空状态
playlistEl.innerHTML = '<div class="playlist-empty">拖入文件或点击打开按钮</div>';

// 初始化均衡器：仅绑定事件；AudioContext / 滤波器图是否创建，由均衡器开关(eqEnabled)决定
try {
  bindEqualizerEvents();
} catch (e) {
  console.error('[EQ] 事件绑定失败:', e);
}

// 初始化外观设置（模糊 / 毛玻璃）
try {
  initSettings();
} catch (e) {
  console.error('[Settings] 初始化失败:', e);
}

// 均衡器开关联动启动加载：开启 → 启动即创建 AudioContext（用户要的“开启就加载”）；
// 关闭 → 启动不加载，延迟到首次打开均衡器面板时再懒加载（降低常驻占用）。
try {
  eqState.enabled = !!appSettings.eqEnabled;
  const eb = document.getElementById('btn-eq-toggle');
  if (eb) {
    eb.classList.toggle('active', eqState.enabled);
    eb.textContent = eqState.enabled ? '开启' : '关闭';
  }
  if (eqState.enabled) ensureEqInit();
} catch (e) {
  console.error('[EQ] 启动加载失败:', e);
}

// 初始化背景来源 + 首开协议 + 图片裁剪
try {
  loadBg();
  console.log('[Init] loadBg ok');
  bindBackgroundSettings();
  console.log('[Init] bindBackgroundSettings ok');
  bindCropEvents();
  console.log('[Init] bindCropEvents ok');
  applyBackground();
  console.log('[Init] applyBackground ok');
  initFirstLaunch();
  console.log('[Init] initFirstLaunch ok');
} catch (e) {
  console.error('[Bg/Launch] 初始化失败:', e);
}

console.log('MusicPlayer loaded (Optimized). 支持格式:', Object.keys(FORMAT_MIME).join(', '));

// ================================================================
// 音乐目录管理（Android SAF + 本地存储）
// 保存多个音乐文件夹，点击切换
// ================================================================

// 状态
const DIR_STORAGE_KEY = 'musicplayer_saved_dirs';
let savedDirs = [];   // [{ name, uri }]
let currentDirUri = null;
let currentDirName = '';

// DOM
const dirList = document.getElementById('dir-list');
const btnAddDir = document.getElementById('btn-add-dir');

// 从 localStorage 加载
function loadSavedDirs() {
  try {
    const raw = localStorage.getItem(DIR_STORAGE_KEY);
    savedDirs = raw ? JSON.parse(raw) : [];
  } catch { savedDirs = []; }
}

// 保存到 localStorage
function saveSavedDirs() {
  localStorage.setItem(DIR_STORAGE_KEY, JSON.stringify(savedDirs));
}

// 渲染目录列表
function renderDirList() {
  if (!dirList) return;
  dirList.innerHTML = '';
  
  if (savedDirs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'dir-item';
    empty.style.opacity = '0.4';
    empty.style.cursor = 'default';
    empty.innerHTML = '<span class="dir-icon">📂</span><span class="dir-name">暂无目录，点击＋添加</span>';
    dirList.appendChild(empty);
    return;
  }
  
  savedDirs.forEach((dir, idx) => {
    const li = document.createElement('li');
    li.className = 'dir-item' + (dir.uri === currentDirUri ? ' active' : '');
    li.innerHTML = `
      <span class="dir-icon">📂</span>
      <span class="dir-name">${escapeHtml(dir.name)}</span>
      <button class="dir-remove" data-idx="${idx}" title="移除">✕</button>
    `;
    
    // 点击加载该目录
    li.addEventListener('click', (e) => {
      if (e.target.closest('.dir-remove')) return;
      loadDirFiles(dir);
    });
    
    // 移除按钮
    li.querySelector('.dir-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      savedDirs.splice(idx, 1);
      saveSavedDirs();
      renderDirList();
      if (dir.uri === currentDirUri) {
        currentDirUri = null;
        currentDirName = '';
      }
    });
    
    dirList.appendChild(li);
  });
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// 使用 SAF 加载目录文件（支持持久化权限，无需每次弹窗）
async function loadDirFiles(dir) {
  if (!window.AndroidDirectoryPicker || !window.AndroidDirectoryPicker.plugin) {
    console.warn('[Dir] SAF 不可用');
    return;
  }
  
  try {
    currentDirUri = dir.uri;
    currentDirName = dir.name;
    renderDirList();
    
    // 检查持久化权限是否仍有效
    const permCheck = await window.AndroidDirectoryPicker.checkPermission(dir.uri);
    
    if (!permCheck.granted) {
      // 权限丢失（极少发生，Android 重启后也可能保留）
      // 需要用户重新选择目录
      console.warn('[Dir] 保存的目录权限已过期，请重新添加');
      // 从已保存列表中移除失效条目
      savedDirs = savedDirs.filter(d => d.uri !== dir.uri);
      saveSavedDirs();
      renderDirList();
      showToast('⚠️ 目录权限已过期，请重新添加');
      return;
    }
    
    console.log('[Dir] 目录权限有效，加载文件:', dir.name);
    
    // 通过 SAF plugin 重新列举该 URI 下的文件
    const result = await window.AndroidDirectoryPicker.listFiles(dir.uri);
    
    if (result && result.files && result.files.length > 0) {
      const treeUri = dir.uri;
      const safFiles = [];
      for (const f of result.files) {
        f._treeUri = treeUri;
        f._isSafFile = true;
        safFiles.push(f);
      }
      loadSafFiles(safFiles, treeUri);
    } else {
      // 可能是空目录或没有权限访问
      // 尝试用 toast 替代
      if (typeof showToast === 'function') {
        showToast('该目录下没有音频文件');
      }
    }
    
  } catch (e) {
    console.error('[Dir] 加载目录失败:', e);
    showToast('加载目录失败，请重新添加');
    // 移除失效条目
    savedDirs = savedDirs.filter(d => d.uri !== dir.uri);
    saveSavedDirs();
    renderDirList();
  }
}

// 添加新目录
async function addNewDirectory() {
  if (!window.AndroidDirectoryPicker || !window.AndroidDirectoryPicker.plugin) {
    alert('此功能仅支持 Android 13+');
    return;
  }
  
  try {
    btnAddDir.disabled = true;
    btnAddDir.textContent = '⏳';
    
    const result = await window.AndroidDirectoryPicker.pickDirectory();
    
    if (result && result.uri && result.count > 0) {
      // 提取文件夹名（从 URI 最后一段）
      const uri = result.uri;
      const name = extractDirName(uri);
      
      // 去重
      if (!savedDirs.find(d => d.uri === uri)) {
        savedDirs.push({ name, uri });
        saveSavedDirs();
      }
      
      // 切换到该目录
      currentDirUri = uri;
      currentDirName = name;
      
      // 加载文件到播放列表
      if (result.files && result.files.length > 0) {
        const treeUri = result.uri;
        const safFiles = [];
        for (const f of result.files) {
          f._treeUri = treeUri;  // _treeUri → loadSafFiles 转为 _safTreeUri
          f._isSafFile = true;
          safFiles.push(f);
        }
        loadSafFiles(safFiles, treeUri);
      }
      
      renderDirList();
    }
  } catch (e) {
    console.error('[Dir] 添加目录失败:', e);
  } finally {
    btnAddDir.disabled = false;
    btnAddDir.textContent = '＋';
  }
}

function extractDirName(uri) {
  try {
    // content://com.android.externalstorage.documents/tree/primary%3AMusic
    const decoded = decodeURIComponent(uri);
    const parts = decoded.split('/');
    const last = parts[parts.length - 1];
    if (last.startsWith('tree:')) {
      const path = last.substring(5); // primary%3AMusic → primary:Music
      const pathParts = path.replace('primary:', '').split(':');
      return pathParts[pathParts.length - 1] || last;
    }
    return last || '未命名目录';
  } catch {
    return '未命名目录';
  }
}

// 初始化
loadSavedDirs();
renderDirList();

if (btnAddDir) {
  btnAddDir.addEventListener('click', addNewDirectory);
}

console.log('[Dir] 目录管理模块已加载，已保存', savedDirs.length, '个目录');
