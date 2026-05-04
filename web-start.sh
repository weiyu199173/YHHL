#!/bin/bash

# 业火红莲 Web 版启动脚本
# 用法: bash web-start.sh
cd "$(dirname "$0")"

echo "正在启动业火红莲 Web 版..."
echo ""

# 启动 Node.js 服务器
node server.js

# 服务器启动后，终端会显示访问地址
# 用浏览器打开 http://localhost:3456 即可
