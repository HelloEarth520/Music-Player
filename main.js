/**
 * main.js - Electron 主进程
 * MusicPlayer - 本地音乐播放器
 *
 * 职责：
 *   - 创建主窗口并注入 COOP/COEP 安全头（SharedArrayBuffer 需要）
 *   - 构建系统菜单（文件 / 播放 / 工具 / 帮助）
 *   - 处理 IPC 请求（对话框、文件读写、ZIP 打包）
 *   - 处理文件关联启动与单实例锁
 *
 * 关键契约（不可变更）：IPC channel 名、菜单命令字符串、COOP/COEP 头、
 *   extractFilesFromArgs 切片逻辑、getFileURL 格式 —— 详见 REFACTOR_PLAN.md 第 5 节。
 */

'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol } = require('electron');
const path  = require('path');
const fs    = require('fs');

// ============================================================
// 关键：允许 SharedArrayBuffer（FFmpeg.wasm 多线程需要）
// ============================================================
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// ============================================================
// 支持的音频扩展名（单一数据源，消除原来 4 处重复）
// ============================================================

/** 所有支持的音频扩展名（不含点，小写） */
const SUPPORTED_AUDIO_EXTENSIONS = [
  'mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a',
  'opus', 'webm', 'wma', 'ape', 'aiff', 'aif',
];

/** 派生 Set，用于快速查找（key 形如 '.mp3'） */
const AUDIO_EXT_SET = new Set(
  SUPPORTED_AUDIO_EXTENSIONS.map(ext => `.${ext}`)
);

/** 文件对话框过滤器（音频文件 + 所有文件） */
const AUDIO_DIALOG_FILTERS = [
  { name: '音频文件', extensions: SUPPORTED_AUDIO_EXTENSIONS },
  { name: '所有文件', extensions: ['*'] },
];

// ============================================================
// 处理通过文件关联启动时传入的文件路径
// ============================================================
let pendingFiles = [];

/**
 * 从命令行参数中提取有效的文件路径（文件关联启动）。
 * 打包版跳过前 1 个参数（exe 路径），开发版跳过前 2 个（electron + 脚本）。
 * @param {string[]} argv - process.argv 或 second-instance 的 argv
 * @returns {string[]} 存在且为文件的路径数组
 */
function extractFilesFromArgs(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter(a => {
    try { return fs.existsSync(a) && fs.statSync(a).isFile(); } catch { return false; }
  });
}

pendingFiles = extractFilesFromArgs(process.argv);

// ============================================================
// 创建主窗口
// ============================================================
let mainWindow = null;

/**
 * 创建主窗口并完成初始化：
 *   - 注入 COOP/COEP 安全头（SharedArrayBuffer 需要）
 *   - 加载 index.html
 *   - ready-to-show 后发送待处理文件（文件关联启动）
 *   - 开发模式（--dev）自动打开 DevTools
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1100,
    height: 720,
    minWidth:  780,
    minHeight: 520,
    title: 'MusicPlayer',
    icon: path.join(__dirname, 'assets', 'icons', 'icon.ico'),
    backgroundColor: '#0f0c29',
    show: false,   // 等 ready-to-show 再显示，避免白屏
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 注入 COOP / COEP 安全头（SharedArrayBuffer 需要）
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy':   ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      },
    });
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 如果通过文件关联启动，发送文件路径给渲染进程
    if (pendingFiles.length > 0) {
      sendOpenFiles(pendingFiles);
      pendingFiles = [];
    }
  });

  // 开发模式下打开 DevTools
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * 向渲染进程发送"打开文件"事件（带空值守卫）。
 * IPC channel: `open-files`
 * @param {string[]} files - 文件路径数组
 */
function sendOpenFiles(files) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-files', files);
  }
}

// ============================================================
// 系统菜单
// ============================================================

/**
 * 构建并设置应用程序菜单（文件 / 播放 / 工具 / 帮助四组）。
 * 菜单命令通过 IPC channel `cmd` 推送给渲染进程。
 */
function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开文件...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: '选择音频文件',
              properties: ['openFile', 'multiSelections'],
              filters: AUDIO_DIALOG_FILTERS,
            });
            if (!result.canceled && result.filePaths.length > 0) {
              sendOpenFiles(result.filePaths);
            }
          },
        },
        {
          label: '打开文件夹...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: '选择音乐文件夹',
              properties: ['openDirectory'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send('open-folder', result.filePaths[0]);
            }
          },
        },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '播放',
      submenu: [
        { label: '播放/暂停', accelerator: 'Space', click: () => mainWindow.webContents.send('cmd', 'togglePlay') },
        { label: '上一首',   accelerator: 'CmdOrCtrl+Left',  click: () => mainWindow.webContents.send('cmd', 'prev') },
        { label: '下一首',   accelerator: 'CmdOrCtrl+Right', click: () => mainWindow.webContents.send('cmd', 'next') },
        { type: 'separator' },
        { label: '音量增加', accelerator: 'CmdOrCtrl+Up',   click: () => mainWindow.webContents.send('cmd', 'volUp') },
        { label: '音量减少', accelerator: 'CmdOrCtrl+Down', click: () => mainWindow.webContents.send('cmd', 'volDown') },
      ],
    },
    {
      label: '工具',
      submenu: [
        { label: '转码工具', accelerator: 'CmdOrCtrl+T', click: () => mainWindow.webContents.send('cmd', 'openTranscode') },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', click: () => mainWindow.webContents.toggleDevTools() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '在 GitHub 查看源码', click: () => shell.openExternal('https://github.com') },
        { label: '关于 MusicPlayer',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '关于 MusicPlayer',
            message: 'MusicPlayer v1.0.0',
            detail: '基于 Electron + FFmpeg.wasm 的本地音乐播放器\n支持 MP3 / FLAC / WAV / OGG / AAC / M4A / OPUS 等格式\n内置 FFmpeg 转码引擎',
            buttons: ['确定'],
          }),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ============================================================
// IPC：渲染进程 → 主进程
// ============================================================

/**
 * IPC handler: 打开文件对话框（渲染进程请求）。
 * Channel: `dialog:openFile`
 * @returns {Promise<string[]>} 选中文件路径数组；取消返回空数组
 */
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择音频文件',
    properties: ['openFile', 'multiSelections'],
    filters: AUDIO_DIALOG_FILTERS,
  });
  return result.canceled ? [] : result.filePaths;
});

/**
 * IPC handler: 打开文件夹对话框，返回文件夹内所有音频文件路径。
 * Channel: `dialog:openFolder`
 * @returns {Promise<string[]>} 音频文件路径数组；取消返回空数组
 */
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择音乐文件夹',
    properties: ['openDirectory'],
  });
  if (result.canceled) return [];
  // 读取文件夹内所有音频文件
  const folder = result.filePaths[0];
  const files = fs.readdirSync(folder)
    .filter(f => AUDIO_EXT_SET.has(path.extname(f).toLowerCase()))
    .map(f => path.join(folder, f));
  return files;
});

/**
 * IPC handler: 读取本地文件为 ArrayBuffer（用于直接加载本地文件，避免 file:// 限制）。
 * Channel: `file:read`
 * @param {string} filePath - 文件绝对路径
 * @returns {Promise<ArrayBuffer|null>} 文件内容；失败返回 null
 */
ipcMain.handle('file:read', async (_, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch (e) {
    return null;
  }
});

/**
 * IPC handler: 读取文件夹内所有音频文件路径。
 * Channel: `file:readDir`
 * @param {string} folderPath - 文件夹绝对路径
 * @returns {Promise<string[]>} 音频文件路径数组；失败返回空数组
 */
ipcMain.handle('file:readDir', async (_, folderPath) => {
  try {
    return fs.readdirSync(folderPath)
      .filter(f => AUDIO_EXT_SET.has(path.extname(f).toLowerCase()))
      .map(f => path.join(folderPath, f));
  } catch { return []; }
});

/**
 * IPC handler: 保存文件（转码后下载）。
 * Channel: `file:save`
 * @param {{defaultName: string, buffer: ArrayBuffer}} data - 文件名与内容
 * @returns {Promise<string|false>} 保存路径；取消返回 false
 */
ipcMain.handle('file:save', async (_, { defaultName, buffer }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存转码文件',
    defaultPath: defaultName,
  });
  if (result.canceled) return false;
  fs.writeFileSync(result.filePath, Buffer.from(buffer));
  return result.filePath;
});

/**
 * 使用 archiver 将多个文件打包为 ZIP。
 * @param {Array<{name: string, buffer: ArrayBuffer}>} files - 文件列表
 * @param {string} zipPath - ZIP 输出路径
 * @returns {Promise<{success: boolean, count: number, errors: string[]}>} 打包结果
 */
function createZipArchive(files, zipPath) {
  const archiver = require('archiver');

  return new Promise((resolve) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    let successCount = 0;
    const errors = [];

    output.on('close', () => {
      console.log('[ZIP] 打包完成，共', successCount, '个文件');
      resolve({ success: true, count: successCount, errors });
    });

    output.on('error', (err) => {
      console.error('[ZIP] 输出流错误:', err);
      errors.push(`输出错误: ${err.message}`);
      resolve({ success: false, count: successCount, errors });
    });

    archive.on('error', (err) => {
      console.error('[ZIP] 打包错误:', err);
      errors.push(err.message);
      resolve({ success: false, count: successCount, errors });
    });

    archive.on('warning', (err) => {
      console.warn('[ZIP] 警告:', err.message);
    });

    archive.pipe(output);

    // 添加所有文件到 zip
    for (const { name, buffer } of files) {
      try {
        if (!buffer) {
          console.warn('[ZIP] 跳过空文件:', name);
          errors.push(`${name}: 空文件`);
          continue;
        }
        const buf = Buffer.from(buffer);
        console.log('[ZIP] 添加文件:', name, '大小:', buf.length);
        archive.append(buf, { name });
        successCount++;
      } catch (e) {
        console.error('[ZIP] 添加文件失败:', name, e);
        errors.push(`${name}: ${e.message}`);
      }
    }

    console.log('[ZIP] 开始 finalize...');
    archive.finalize();
  });
}

/**
 * IPC handler: 打包并保存所有转码文件为 zip。
 * Channel: `file:saveBatch`
 * @param {{files: Array<{name: string, buffer: ArrayBuffer}>}} data - 文件列表
 * @returns {Promise<{success: boolean, count: number, path: string|null, errors: string[]}>}
 */
ipcMain.handle('file:saveBatch', async (_, { files }) => {
  console.log('[ZIP] 开始打包，文件数量:', files?.length);

  if (!files || files.length === 0) {
    return { success: false, count: 0, path: null, errors: ['没有文件可打包'] };
  }

  // 选择保存位置
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存转码文件包',
    defaultPath: 'converted_music.zip',
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
  });
  if (result.canceled) return { success: false, count: 0, path: null };

  const zipPath = result.filePath;
  console.log('[ZIP] 保存路径:', zipPath);

  const archiveResult = await createZipArchive(files, zipPath);
  return { ...archiveResult, path: archiveResult.success ? zipPath : null };
});

// ============================================================
// Windows：第二个实例（文件关联打开）
// ============================================================
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const files = extractFilesFromArgs(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (files.length > 0) sendOpenFiles(files);
    }
  });
}

// ============================================================
// 应用生命周期
// ============================================================
app.whenReady().then(() => {
  createWindow();
  buildMenu();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 处理文件关联协议（macOS open-file 事件）
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    sendOpenFiles([filePath]);
  } else {
    pendingFiles.push(filePath);
  }
});
