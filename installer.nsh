; installer.nsh - NSIS 自定义安装脚本
; electron-builder 会自动包含此文件

; 安装完成后注册文件关联
!macro customInstall
  ; 注册文件类型图标（可选，electron-builder 已通过 fileAssociations 处理）
!macroend

!macro customUnInstall
  ; 清理注册表（可选）
!macroend
