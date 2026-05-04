# macOS 适配说明

本版本已针对 macOS 进行以下适配：

## 1. 路径处理
- 使用 `path.join()` 确保跨平台兼容
- macOS 下自动使用正斜杠 `/`
- 自动检测系统类型并适配

## 2. 媒体控制
- macOS 使用 AppleScript 发送媒体播放键
- Windows 使用 PowerShell 脚本

## 3. 应用路径
- macOS 打包后自动定位资源目录
- 开发模式下从项目根目录查找资源

## 4. 快捷键注册
- 支持全局快捷键（F2 语音、F3 打开对话）
- macOS 和 Windows 统一处理
