# 业火红莲AI交互系统

> 一个基于 VRM / Three.js / Electron 构建的 AI 桌面数字助手，支持语音交互和CLI操作。

## 功能特性

- 🧠 LLM 对话（基于 DeepSeek 标准 API）
- 💾 RAG 长期记忆（本地向量检索，越聊越懂你）
- 🌐 全网搜索 Agent（遇到不知道的实时新闻，自动后台搜索再回答）
- 👀 视觉感知（截屏 + Qwen-VL 多模态分析）
- 🎙️ 情感语音（Minimax / Edge-TTS 双引擎）
- 💬 主动搭话（闲置时主动找你聊天）
- ⚙️ CLI 执行器（通过对话让AI操作各种应用程序）
- 👗 多角色切换（放入 .vrm 文件即可）

## 技术栈

- Electron ^28.3.3
- Three.js ^0.164.1
- @pixiv/three-vrm ^2.1.3
- DeepSeek API

## 快速开始

```bash
# 安装依赖
npm install

# 启动应用
npm start
```

## License

MIT
