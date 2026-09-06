/**
 * Android FFmpeg 桥接层（重写版）
 * - 使用 Capacitor 原生 API 调用 FFmpegPlugin
 * - 自动复制 content:// URI 文件到缓存目录（FFmpeg 需要真实路径）
 * - 文件选择 + 转码完整流程
 */

(function() {
  'use strict';

  const TAG = '[AndroidFFmpeg]';
  window.__IS_ANDROID = false;

  // ====================================================
  // 工具函数
  // ====================================================
  function log(...args) { console.log(TAG, ...args); }

  // 检测是否在 Capacitor Android 环境
  function isCapacitorAndroid() {
    return !!(window.Capacitor && window.Capacitor.getPlatform() === 'android');
  }

  // 等待 Capacitor 就绪
  function waitForCapacitor() {
    return new Promise(resolve => {
      if (window.Capacitor) return resolve();
      let tries = 0;
      const iv = setInterval(() => {
        tries++;
        if (window.Capacitor) { clearInterval(iv); resolve(); }
        if (tries > 100) { clearInterval(iv); resolve(); } // 超时 10s
      }, 100);
    });
  }

  // 从 File 对象读取 ArrayBuffer
  function fileToArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  // 生成临时文件名
  function makeTempName(fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    return `musicplayer_${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
  }

  // ====================================================
  // 主桥接对象
  // ====================================================
  window.AndroidFFmpeg = {
    plugin: null,       // Capacitor.Plugins.FFmpegPlugin
    ready: false,
    cacheDir: null,

    async init() {
      await waitForCapacitor();

      if (!isCapacitorAndroid()) {
        log('不是 Android 环境，跳过');
        return false;
      }

      window.__IS_ANDROID = true;
      window.__IS_ELECTRON = false;

      try {
        this.plugin = window.Capacitor.Plugins.FFmpegPlugin;
        log('原生 FFmpeg 插件已获取');

        // 获取缓存目录
        // 注意：Capacitor Filesystem.getUri 必须传 path 参数，否则报 "input parameters aren't valid"
        if (window.Capacitor.Plugins.Filesystem) {
          const info = await window.Capacitor.Plugins.Filesystem.getUri({
            path: '',
            directory: 'CACHE'
          });
          this.cacheDir = info.uri;
          log('缓存目录:', this.cacheDir);
        }

        this.ready = true;
        log('桥接层初始化完成 ✅');
        return true;
      } catch (err) {
        console.error(TAG, '初始化失败:', err);
        return false;
      }
    },

    /**
     * 复制文件到缓存，返回可用的文件路径
     * @param {File} file - 从 <input> 获取的 File 对象
     * @returns {string} 缓存中的文件路径
     */
    async copyToCache(file) {
      if (!this.cacheDir) throw new Error('缓存目录不可用');

      const cacheName = makeTempName(file.name);
      const uint8 = await fileToArrayBuffer(file);

      // 用 Capacitor Filesystem 写入缓存
      await window.Capacitor.Plugins.Filesystem.writeFile({
        path: cacheName,
        data: uint8,
        directory: 'CACHE'
      });

      const cachePath = this.cacheDir + '/' + cacheName;
      log('文件已复制到缓存:', cachePath);
      return cachePath;
    },

    /**
     * 同步转码
     */
    async transcode(options) {
      if (!this.ready) throw new Error('FFmpeg 插件未就绪');
      
      const result = await this.plugin.transcode({
        inputPath: options.inputPath,
        outputPath: options.outputPath,
        codec: options.codec || 'libmp3lame',
        bitrate: options.bitrate || '192k',
        sampleRate: options.sampleRate || '44100',
        channels: options.channels || '2'
      });

      return result;
    },

    /**
     * 异步转码（带进度）
     */
    async transcodeAsync(options) {
      if (!this.ready) throw new Error('FFmpeg 插件未就绪');

      const taskId = options.taskId || `task_${Date.now()}`;

      const result = await this.plugin.transcodeAsync({
        taskId: taskId,
        inputPath: options.inputPath,
        outputPath: options.outputPath,
        codec: options.codec || 'libmp3lame',
        bitrate: options.bitrate || '192k',
        sampleRate: options.sampleRate || '44100',
        channels: options.channels || '2'
      });

      return { taskId, ...result };
    },

    /**
     * 完整的转码流程：自动复制文件 + 转码 + 清理缓存
     * 前端直接调用这个即可
     */
    async transcodeFile(file, format = 'mp3', bitrate = '192k') {
      // 使用已知的应用包名路径
    const PACKAGE = 'com.musicplayer.app';
    const CACHE_DIR = `/data/data/${PACKAGE}/cache`;
    
    // 1. 读取文件并写入 APP 缓存目录（FFmpeg 需要真实文件路径）
    const inputName = makeTempName(file.name);
    const outputName = makeTempName(file.name.replace(/\.[^.]+$/, '') + '_converted.' + format);
    
    const bytes = await fileToArrayBuffer(file);
    // base64 编码
    let binaryStr = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binaryStr += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const base64Data = btoa(binaryStr);
    
    // 用 Capacitor Filesystem 写入缓存
    await window.Capacitor.Plugins.Filesystem.writeFile({
      path: inputName,
      data: base64Data,
      directory: 'CACHE'
    });
    
    const inputPath = `${CACHE_DIR}/${inputName}`;
    const outputPath = `${CACHE_DIR}/${outputName}`;
    
    // 2. 调用原生 FFmpeg 转码
    log('开始转码:', inputPath, '→', outputPath);
    const result = await this.transcode({
      inputPath: inputPath,
      outputPath: outputPath,
      codec: format === 'mp3' ? 'libmp3lame' :
             format === 'aac' ? 'aac' :
             format === 'flac' ? 'flac' :
             format === 'ogg' ? 'libvorbis' :
             format === 'opus' ? 'libopus' :
             format === 'wav' ? 'pcm_s16le' : 'libmp3lame',
      bitrate: bitrate,
      sampleRate: '44100',
      channels: '2'
    });

    // 3. 读取转码后的文件
    const readResult = await window.Capacitor.Plugins.Filesystem.readFile({
      path: outputName,
      directory: 'CACHE'
    });

    // 清理缓存文件
    try {
      await window.Capacitor.Plugins.Filesystem.deleteFile({ path: inputName, directory: 'CACHE' });
      await window.Capacitor.Plugins.Filesystem.deleteFile({ path: outputName, directory: 'CACHE' });
    } catch(e) { /* 清理失败不影响结果 */ }

    // 4. 返回 Blob
    const rawStr = atob(readResult.data);
    const uint8 = new Uint8Array(rawStr.length);
    for (let i = 0; i < rawStr.length; i++) {
      uint8[i] = rawStr.charCodeAt(i);
    }
    const blob = new Blob([uint8.buffer], { type: 'audio/' + format });
    blob.name = outputName;
    return blob;
    },

    /**
     * 获取媒体信息
     */
    async getMediaInfo(path) {
      if (!this.ready) throw new Error('FFmpeg 插件未就绪');
      return await this.plugin.getMediaInfo({ path });
    },

    /**
     * 取消转码
     */
    async cancel(taskId) {
      if (!this.ready) return;
      await this.plugin.cancelTranscode({ taskId });
    }
  };

  // 自动初始化（受「转码开关」控制：关闭时不初始化原生 FFmpeg，避免占用内存）
  function transcodeEnabledInSettings() {
    try {
      const raw = localStorage.getItem('musicplayer_appearance');
      if (!raw) return true;                 // 无设置时默认开启
      const s = JSON.parse(raw);
      return s.transcodeEnabled !== false;    // 仅 false 才关闭
    } catch { return true; }
  }
  if (transcodeEnabledInSettings()) {
    window.AndroidFFmpeg.init().then(ok => {
      if (ok) log('桥接层就绪 ✅');
      else log('非 Android 环境或初始化失败，将回退到 FFmpeg.wasm');
      window.dispatchEvent(new CustomEvent('android-ffmpeg-ready', { detail: { ready: ok } }));
    });
  } else {
    log('转码功能已关闭（设置），跳过原生 FFmpeg 初始化以节省内存');
  }
})();

// ================================================================
// SAF 目录选择器（Android 13+ Storage Access Framework）
// 每次打开重新选，不持久化授权
// ================================================================
// 等待 Capacitor 就绪（与 AndroidFFmpeg 共用同一函数）
// waitForCapacitor 定义在上方

window.AndroidDirectoryPicker = {
  plugin: null,

  async init() {
    // 等 Capacitor 完全初始化
    if (typeof waitForCapacitor === 'function') {
      await waitForCapacitor();
    } else {
      // 没有 waitForCapacitor？自己等
      await new Promise(resolve => {
        if (window.Capacitor) return resolve();
        let tries = 0;
        const iv = setInterval(() => {
          tries++;
          if (window.Capacitor) { clearInterval(iv); resolve(); }
          if (tries > 100) { clearInterval(iv); resolve(); }
        }, 100);
      });
    }
    
    // Capacitor 就绪后，再等一小段时间让插件注册完成
    await new Promise(r => setTimeout(r, 300));
    
    if (window.Capacitor && window.Capacitor.getPlatform() === 'android' && 
        window.Capacitor.Plugins.DirectoryPicker) {
      this.plugin = window.Capacitor.Plugins.DirectoryPicker;
      console.log('[DirPicker] 插件已获取 ✅');
      return true;
    }
    
    console.warn('[DirPicker] 未检测到 DirectoryPicker 插件');
    return false;
  },

  /**
   * 打开 SAF 目录选择器
   * @returns {{ uri: string, files: Array<{name,size,docId}>, count: number }}
   */
  async pickDirectory() {
    if (!this.plugin) await this.init();
    if (!this.plugin) throw new Error('DirectoryPicker 插件不可用');

    const result = await this.plugin.pickDirectory();
    console.log('[DirPicker] SAF 目录已选择:', result.uri, '文件数:', result.count);
    return result;
  },

  /**
   * 检查保存的目录 URI 是否仍有访问权限
   * @param {string} uri - 保存的 content:// URI
   * @returns {{ granted: boolean }}
   */
  async checkPermission(uri) {
    if (!this.plugin) await this.init();
    if (!this.plugin) return { granted: false };
    
    try {
      const result = await this.plugin.checkPermission({ uri });
      return result;
    } catch (e) {
      console.warn('[DirPicker] checkPermission 失败:', e);
      return { granted: false };
    }
  },

  /**
   * 通过已保存的 URI 重新列出目录下的文件（需要持久化权限）
   * @param {string} treeUri - 已保存的 content:// URI
   * @returns {{ files: Array, count: number }}
   */
  async listFiles(treeUri) {
    if (!this.plugin) await this.init();
    if (!this.plugin) throw new Error('DirectoryPicker 插件不可用');
    
    // 复用 pickDirectory 相同逻辑，只传 URI
    // 但 Java 端 pickDirectory 依赖 ActivityResult，不能无 UI 调用
    // 所以这里复用 readFile 的思路，直接查询 content resolver
    // 在 Java 端新增 listFiles 方法
    const result = await this.plugin.listFiles({ treeUri });
    console.log('[DirPicker] 列出文件:', result.count, '个');
    return result;
  },

  /**
   * 通过 SAF content:// URI 读取文件内容
   * @param {string} treeUri - 目录的 content:// URI
   * @param {string} documentId - 文件的 documentId
   * @returns {Uint8Array} 文件数据
   */
  async readFile(treeUri, documentId) {
    if (!this.plugin) throw new Error('DirectoryPicker 插件不可用');

    const result = await this.plugin.readFile({ treeUri, documentId });
    
    // Base64 转 Uint8Array
    const raw = atob(result.data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
  },

  /**
   * 把 SAF 文件拷到应用缓存并返回同源可播放 URL（大文件不进内存，避免 OOM）
   * @param {string} treeUri - 目录的 content:// URI
   * @param {string} documentId - 文件的 documentId
   * @param {string} [ext] - 文件扩展名（含点，如 ".mp3"），用于 MIME 嗅探
   * @returns {{ url: string, path: string, size: number }}
   */
  async getPlayableFile(treeUri, documentId, ext) {
    if (!this.plugin) await this.init();
    if (!this.plugin) throw new Error('DirectoryPicker 插件不可用');
    const result = await this.plugin.getPlayableFile({ treeUri, documentId, ext: ext || '' });
    return result; // { url, path, size }
  },

  /**
   * 读取同目录小文本文件（.lrc 歌词等）
   * @param {string} treeUri - 目录的 content:// URI
   * @param {string} documentId - 文件的 documentId
   * @returns {string} 文件文本内容（UTF-8）
   */
  async readTextFile(treeUri, documentId) {
    if (!this.plugin) await this.init();
    if (!this.plugin) throw new Error('DirectoryPicker 插件不可用');
    const result = await this.plugin.readTextFile({ treeUri, documentId });
    return result.text || '';
  }
};

// 初始化 SAF 目录选择器
(async function initDirPicker() {
  await window.AndroidDirectoryPicker.init();
  if (window.AndroidDirectoryPicker.plugin) {
    console.log('[DirPicker] SAF 目录选择器已就绪 ✅');
  }
})();
