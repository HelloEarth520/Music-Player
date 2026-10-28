# 许可证全文目录

本目录存放 MusicPlayer 分发包中所含第三方组件的许可证原文。
组件清单、版本与对应关系见仓库根目录的 [`NOTICE`](../NOTICE)。

| 文件 | 许可 | 适用组件 |
|---|---|---|
| `GPL-2.0.txt` | GNU General Public License v2.0 | `@ffmpeg/core` 0.12.10（GPL-2.0-or-later） |
| `GPL-3.0.txt` | GNU General Public License v3.0 | LGPL-3.0 的补充条款基础；GPL-2.0-or-later 亦可升级适用 |
| `LGPL-3.0.txt` | GNU Lesser General Public License v3.0 | FFmpegKit / FFmpeg 6.0 原生库（LGPL-3.0） |
| `Apache-2.0.txt` | Apache License 2.0 | Capacitor、AndroidX、Gradle Wrapper、libc++ |

MIT 许可的组件（`@ffmpeg/ffmpeg`、`@ffmpeg/util`、archiver、Electron、
electron-builder）无需单独附全文：其许可要求仅为保留版权与许可声明，
已在本目录上一级的 `NOTICE` 中列明。

## 说明

- `LGPL-3.0.txt` 是「附加许可」文档，本身援引 GPL-3.0 条款，
  因此必须与 `GPL-3.0.txt` 一同提供，缺一不可。
- 以上文本均取自官方发布源（gnu.org / apache.org），未作任何修改。
