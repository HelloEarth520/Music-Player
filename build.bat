@echo off
chcp 65001 > nul
echo ============================================
echo  MusicPlayer - Electron 打包工具
echo ============================================
echo.

cd /d D:\MusicPlayer

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set npm_config_registry=https://registry.npmmirror.com

echo [1] 绿色版（win-unpacked，直接运行，推荐）
echo [2] NSIS 安装包（带安装向导，需网络下载 NSIS 工具）
echo [3] 便携单文件 EXE（需网络下载工具）
echo [4] 全部打包
echo.

set /p choice=请选择 [1-4]:

if "%choice%"=="1" (
  echo 正在打包绿色版...
  call npx electron-builder --win dir --x64
  echo.
  echo 完成！输出目录: D:\MusicPlayer\dist\win-unpacked\
  echo 双击 MusicPlayer.exe 即可运行
)

if "%choice%"=="2" (
  echo 正在打包 NSIS 安装包...
  call npx electron-builder --win nsis --x64
  echo 完成！查看 dist\ 目录
)

if "%choice%"=="3" (
  echo 正在打包便携版...
  call npx electron-builder --win portable --x64
  echo 完成！查看 dist\ 目录
)

if "%choice%"=="4" (
  echo 正在全部打包...
  call npx electron-builder --win --x64
  echo 完成！查看 dist\ 目录
)

echo.
start explorer "D:\MusicPlayer\dist"
pause
