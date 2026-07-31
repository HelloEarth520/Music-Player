@echo off
chcp 65001 > nul
echo ===========================================
echo  MusicPlayer - 设置默认文件关联
echo ===========================================
echo.
echo 正在将 MusicPlayer 关联到常见音频格式...
echo.

set "PLAYER_PATH=D:\MusicPlayer\index.html"
set "CHROME_PATH="

:: 查找 Chrome
for %%G in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if exist %%G set "CHROME_PATH=%%~G"
)

if "%CHROME_PATH%"=="" (
  echo [!] 未找到 Chrome，尝试 Edge...
  for %%G in (
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  ) do (
    if exist %%G set "CHROME_PATH=%%~G"
  )
)

if "%CHROME_PATH%"=="" (
  echo [X] 未找到 Chrome 或 Edge，请手动关联。
  pause & exit /b 1
)

echo [OK] 浏览器路径: %CHROME_PATH%
echo.

:: 注册应用
reg add "HKCU\Software\Classes\MusicPlayerHTML" /ve /d "MusicPlayer" /f > nul
reg add "HKCU\Software\Classes\MusicPlayerHTML\shell\open\command" /ve /d "\"%CHROME_PATH%\" --app=\"file:///%PLAYER_PATH:\=/%\"" /f > nul
reg add "HKCU\Software\Classes\MusicPlayerHTML\DefaultIcon" /ve /d "%CHROME_PATH%,0" /f > nul

:: 关联扩展名
for %%E in (mp3 flac wav ogg aac m4a opus wma) do (
  reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.%%E\UserChoice" /v "ProgId" /d "MusicPlayerHTML" /f > nul 2>&1
  echo [>>] .%%E 已尝试关联
)

echo.
echo [提示] Windows 10/11 对文件关联有保护，如未生效请：
echo   1. 右键任意 MP3 文件 → 打开方式 → 选择其他应用
echo   2. 选择 Chrome/Edge，勾选"始终使用此应用"
echo   3. 地址栏输入: D:\MusicPlayer\index.html
echo.
echo 完成！
pause
