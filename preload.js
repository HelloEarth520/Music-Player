/**
 * preload.js - Electron 预加载脚本
 *
 * 职责：通过 contextBridge 安全暴露 Node.js / Electron API 给渲染进程，
 *       作为主进程（main.js）与渲染进程（player.js / transcoder.js）之间
 *       的唯一 IPC 通信桥梁。
 *
 * 关键依赖：
 *   - electron.contextBridge：在隔离的上下文中注入安全 API
 *   - electron.ipcRenderer：与主进程双向通信
 *
 * 契约铁律：以下所有 API 名称、参数签名、IPC channel 名不得变更
 * （详见 REFACTOR_PLAN.md 第 5 节）。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ==================== 对话框 ====================

  /**
   * 标识当前是否运行在 Electron 环境中（渲染进程据此切换行为分支）。
   * @type {boolean}
   */
  isElectron: true,

  /**
   * 打开文件选择对话框，返回用户选择的音频文件路径数组。
   * IPC channel: `dialog:openFile`
   * @returns {Promise<string[]>} 选中文件的绝对路径数组；取消时返回空数组
   */
  openFile: () => ipcRenderer.invoke('dialog:openFile'),

  /**
   * 打开文件夹选择对话框，返回该文件夹内所有音频文件的路径数组。
   * IPC channel: `dialog:openFolder`
   * @returns {Promise<string[]>} 文件夹内音频文件的绝对路径数组；取消时返回空数组
   */
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),

  // ==================== 文件读写 ====================

  /**
   * 将本地文件读取为 ArrayBuffer（用于转码等场景，绕过 file:// 限制）。
   * IPC channel: `file:read`
   * @param {string} filePath - 文件绝对路径
   * @returns {Promise<ArrayBuffer|null>} 文件内容 ArrayBuffer；读取失败返回 null
   */
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),

  /**
   * 弹出保存对话框并将 Buffer 写入磁盘（单个转码文件导出）。
   * IPC channel: `file:save`
   * @param {string} defaultName - 默认文件名（含扩展名）
   * @param {ArrayBuffer} buffer - 文件二进制内容
   * @returns {Promise<string|false>} 保存成功返回文件路径，取消保存返回 false
   */
  saveFile: (defaultName, buffer) => ipcRenderer.invoke('file:save', { defaultName, buffer }),

  /**
   * 将多个转码文件打包为 ZIP 后保存到磁盘（批量导出）。
   * IPC channel: `file:saveBatch`
   * @param {Array<{name: string, buffer: ArrayBuffer}>} files - 文件列表
   * @returns {Promise<{success: boolean, count: number, path: string|null, errors: string[]}>}
   *          打包结果
   */
  saveFilesAsZip: (files) => ipcRenderer.invoke('file:saveBatch', { files }),

  /**
   * 读取指定文件夹内所有音频文件的路径列表（按扩展名过滤）。
   * IPC channel: `file:readDir`
   * @param {string} folderPath - 文件夹绝对路径
   * @returns {Promise<string[]>} 音频文件绝对路径数组；读取失败返回空数组
   */
  readDir: (folderPath) => ipcRenderer.invoke('file:readDir', folderPath),

  // ==================== 事件监听 ====================

  /**
   * 监听主进程推送的"打开文件"事件（文件关联启动 / 菜单打开文件 / 二次实例传入）。
   * IPC channel: `open-files`
   * @param {(filePaths: string[]) => void} callback - 收到文件路径数组时的回调
   * @returns {void}
   */
  onOpenFiles: (callback) => ipcRenderer.on('open-files', (_, filePaths) => callback(filePaths)),

  /**
   * 监听主进程推送的"打开文件夹"事件（菜单打开文件夹）。
   * IPC channel: `open-folder`
   * @param {(folderPath: string) => void} callback - 收到文件夹路径时的回调
   * @returns {void}
   */
  onOpenFolder: (callback) => ipcRenderer.on('open-folder', (_, folderPath) => callback(folderPath)),

  /**
   * 监听主进程推送的菜单命令（播放/暂停、上下首、音量±、打开转码面板等）。
   * IPC channel: `cmd`
   * @param {(cmd: string) => void} callback - 收到命令字符串时的回调
   *   命令取值：'togglePlay' | 'prev' | 'next' | 'volUp' | 'volDown' | 'openTranscode'
   * @returns {void}
   */
  onCommand: (callback) => ipcRenderer.on('cmd', (_, cmd) => callback(cmd)),

  // ==================== 工具 ====================

  /**
   * 将本地文件路径转换为 file:// URL（Electron 中可直接作为 audio.src）。
   * 格式：`file:///` + 反斜杠转正斜杠后的路径。
   * @param {string} filePath - 本地文件绝对路径（Windows 含反斜杠）
   * @returns {string} 形如 `file:///C:/Music/song.mp3` 的 URL
   */
  getFileURL: (filePath) => {
    // 将 Windows 路径中的反斜杠转换为正斜杠
    const normalized = filePath.replace(/\\/g, '/');
    return `file:///${normalized}`;
  },
});
