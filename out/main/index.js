"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const child_process = require("child_process");
const os = require("os");
const crypto = require("crypto");

// 导入 CLI 执行器
let CLIExecutor, COMMAND_REGISTRY;
try {
  const cliModule = require("./cli-executor.js");
  CLIExecutor = cliModule.CLIExecutor;
  COMMAND_REGISTRY = cliModule.COMMAND_REGISTRY;
  console.log("[CLI Executor] 模块加载成功");
} catch (err) {
  console.error("[CLI Executor] 模块加载失败:", err.message);
  CLIExecutor = null;
  COMMAND_REGISTRY = null;
}

// 初始化 CLI 执行器
let cliExecutor = null;
if (CLIExecutor) {
  cliExecutor = new CLIExecutor({ timeout: 30000, maxOutputLength: 5000 });
  console.log("[CLI Executor] 执行器初始化完成");
}

function getCLISystemPrompt() {
  if (!COMMAND_REGISTRY) return '';
  let prompt = '\n';
  for (const [key, tool] of Object.entries(COMMAND_REGISTRY)) {
    if (tool.examples && tool.examples.length > 0) {
      prompt += `- ${tool.name} (${tool.description}): ${tool.examples.join(', ')}\n`;
    }
  }
  return prompt;
}

function generateQWeatherJWT(kid, sub, privateKeyPem) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid })).toString("base64url");
  const now = Math.floor(Date.now() / 1e3);
  const payload = Buffer.from(JSON.stringify({ sub, iat: now, exp: now + 900 })).toString("base64url");
  const data = `${header}.${payload}`;
  const sig = crypto.sign(null, Buffer.from(data), privateKeyPem).toString("base64url");
  return `${data}.${sig}`;
}

function httpsGet(hostname, path2, headers = {}) {
  return new Promise((resolve) => {
    const req = https.request({ hostname, path: path2, method: "GET", headers, timeout: 6e3 }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

let _weatherCache = null;
let _weatherCacheAt = 0;

async function fetchWeatherContext() {
  const now = Date.now();
  if (_weatherCache && now - _weatherCacheAt < 30 * 60 * 1e3) return _weatherCache;
  try {
    const cfg = readConfig();
    const engine = cfg.weatherEngine || "free";
    let city = "", lat = 0, lon = 0;
    if (cfg.weatherCity && cfg.weatherCity.trim()) {
      city = cfg.weatherCity.trim();
      const geoData = await httpsGet("geocoding-api.open-meteo.com", `/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`);
      const loc = geoData?.results?.[0];
      if (!loc) return null;
      lat = loc.latitude; lon = loc.longitude; city = loc.name || city;
    } else {
      const ipData = await httpsGet("ip-api.com", "/json/?lang=zh-CN&fields=status,city,lat,lon");
      if (!ipData || ipData.status !== "success") return null;
      city = ipData.city; lat = ipData.lat; lon = ipData.lon;
    }
    let result = null;
    if (engine === "qweather" && cfg.qweatherKeyId && cfg.qweatherSubId && cfg.qweatherPrivateKey) {
      const jwt = generateQWeatherJWT(cfg.qweatherKeyId, cfg.qweatherSubId, cfg.qweatherPrivateKey);
      const weatherData = await httpsGet("devapi.qweather.com", `/v7/weather/now?location=${lon},${lat}&lang=zh`, { Authorization: `Bearer ${jwt}` });
      if (weatherData && weatherData.code === "200") {
        const { temp, feelsLike, text, windDir, windScale, humidity } = weatherData.now;
        result = `你所在的城市（${city}）天气：${text}，温度${temp}°C，体感${feelsLike}°C，${windDir}${windScale}级，湿度${humidity}%。`;
      }
    }
    if (!result) {
      const WMO = { 0: "晴", 1: "晴间多云", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇", 51: "小毛毛雨", 53: "中毛毛雨", 55: "大毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨", 71: "小雪", 73: "中雪", 75: "大雪", 80: "阵雨", 81: "中阵雨", 82: "强阵雨", 95: "雷阵雨" };
      const omData = await httpsGet("api.open-meteo.com", `/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m`);
      if (omData && omData.current) {
        const { temperature_2m: temp, apparent_temperature: feels, weather_code: code, relative_humidity_2m: humidity } = omData.current;
        result = `你所在的城市（${city}）天气：${WMO[code] || "未知天气"}，温度${Math.round(temp)}°C，体感${Math.round(feels)}°C，湿度${humidity}%。`;
      }
    }
    if (!result) return null;
    const timeStr = getTimeContext();
    _weatherCache = `当前时间：${timeStr}。${result}`;
    _weatherCacheAt = now;
    return _weatherCache;
  } catch (e) { return null; }
}

function getTimeContext() {
  const now = new Date();
  const h = now.getHours();
  const min = String(now.getMinutes()).padStart(2, "0");
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const day = weekdays[now.getDay()];
  let period = "";
  if (h >= 5 && h < 9) period = "清晨";
  else if (h >= 9 && h < 12) period = "上午";
  else if (h >= 12 && h < 14) period = "午间";
  else if (h >= 14 && h < 18) period = "下午";
  else if (h >= 18 && h < 22) period = "傍晚";
  else period = "深夜";
  return `${day}${period} ${h}:${min}`;
}

function getConfigPath() { return path.join(electron.app.getPath("userData"), "config.json"); }
function readConfig() { try { return JSON.parse(fs.readFileSync(getConfigPath(), "utf-8")); } catch { return {}; } }
function writeConfig(data) { fs.writeFileSync(getConfigPath(), JSON.stringify(data, null, 2), "utf-8"); }

let win = null;
let cursorBroadcastTimer = null;

function isWindowAlive(target = win) { return !!(target && !target.isDestroyed() && target.webContents && !target.webContents.isDestroyed()); }
function sendToMainWindow(channel, ...args) { if (!isWindowAlive()) return false; win.webContents.send(channel, ...args); return true; }

function clearMainWindowTimers() {
  if (cursorBroadcastTimer) { clearInterval(cursorBroadcastTimer); cursorBroadcastTimer = null; }
  if (_focusTimer) { clearTimeout(_focusTimer); _focusTimer = null; }
}

function createWindow() {
  console.log("[createWindow] 开始创建窗口!");
  const { width: sw, height: sh } = electron.screen.getPrimaryDisplay().workAreaSize;
  win = new electron.BrowserWindow({
    width: 350, height: 680, x: sw - 370, y: sh - 700,
    transparent: true, frame: false, alwaysOnTop: true,
    minWidth: 150, minHeight: 200,
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false }
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
    win.webContents.openDevTools({ mode: "detach" });
  }
  win.on("closed", () => { clearMainWindowTimers(); win = null; });
  cursorBroadcastTimer = setInterval(() => {
    if (isWindowAlive() && !win.isMinimized() && win.isVisible()) {
      const pt = electron.screen.getCursorScreenPoint();
      const b = win.getBounds();
      sendToMainWindow("global-cursor", { x: pt.x - b.x, y: pt.y - b.y, width: b.width, height: b.height });
    }
  }, 33);
}

function registerHotkeys() {
  electron.globalShortcut.unregisterAll();
  const cfg = readConfig();
  const keyVoice = cfg.hotkeyVoice || "F2";
  const keyChat = cfg.hotkeyChat || "F3";
  try { electron.globalShortcut.register(keyVoice, () => { sendToMainWindow("toggle-stt"); }); } catch { console.warn("[Hotkey] 语音快捷键注册失败"); }
  try { electron.globalShortcut.register(keyChat, () => { if (!isWindowAlive()) return; win.focus(); sendToMainWindow("open-chat"); }); } catch { console.warn("[Hotkey] 对话框快捷键注册失败"); }
}

electron.app.whenReady().then(() => { createWindow(); registerHotkeys(); restoreReminders(); electron.app.on("activate", () => { if (electron.BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
electron.app.on("will-quit", () => { electron.globalShortcut.unregisterAll(); clearMainWindowTimers(); for (const handle of activeReminders.values()) clearTimeout(handle); activeReminders.clear(); });
electron.app.on("window-all-closed", () => { if (process.platform !== "darwin") electron.app.quit(); });

// ==================== CLI 执行器 IPC 处理 ====================

electron.ipcMain.handle("cli-execute", async (_, command, options = {}) => {
  if (!cliExecutor) return { success: false, error: "CLI 执行器未初始化" };
  try { console.log("[CLI Executor] 执行命令:", command); const result = await cliExecutor.execute(command, options); console.log("[CLI Executor] 命令完成:", result.success ? "成功" : "失败"); return result; }
  catch (err) { console.error("[CLI Executor] 执行失败:", err); return { success: false, error: err.message }; }
});

electron.ipcMain.handle("cli-get-registry", () => {
  if (!COMMAND_REGISTRY) return null;
  return Object.entries(COMMAND_REGISTRY).map(([key, value]) => ({ key: key, icon: value.icon, name: value.name, description: value.description, commands: value.commands, examples: value.examples }));
});

electron.ipcMain.handle("cli-get-system-prompt", () => {
  if (!COMMAND_REGISTRY) return "CLI 功能未启用";
  let prompt = `\n## CLI 工具箱（业火红莲已装备）\n\n`;
  for (const [key, cmd] of Object.entries(COMMAND_REGISTRY)) {
    prompt += `### ${cmd.icon} ${cmd.name}\n**用途：** ${cmd.description}\n**可用命令：** ${cmd.commands.join(', ')}\n**示例：**\n`;
    for (const example of cmd.examples) prompt += `  \`${example}\`\n`;
    prompt += '\n';
  }
  prompt += `## 使用规则\n1. 当用户需要执行操作时，优先使用 CLI 工具\n2. 调用 execute_cli 工具执行命令\n3. 返回结果用简洁的语音播报格式\n4. 如果命令危险（rm -rf, dd 等），先拒绝执行并警告用户\n\n`;
  return prompt;
});

const APP_REGISTRY = { netease: process.platform === 'win32' ? "D:\\软件\\CloudMusic\\cloudmusic.exe" : "/Applications/NeteaseMusic.app" };

function getRemindersPath() { return path.join(electron.app.getPath("userData"), "reminders.json"); }
function readReminders() { try { return JSON.parse(fs.readFileSync(getRemindersPath(), "utf-8")); } catch { return []; } }
function saveReminders(list) { try { fs.writeFileSync(getRemindersPath(), JSON.stringify(list, "utf-8")); } catch (e) { console.error("[Reminder] 保存失败:", e); } }
const activeReminders = new Map();

function scheduleReminder(id, delayMs, message) {
  const handle = setTimeout(() => {
    activeReminders.delete(id);
    saveReminders(readReminders().filter((r) => r.id !== id));
    sendToMainWindow("reminder-fired", message);
  }, delayMs);
  activeReminders.set(id, handle);
}

function restoreReminders() {
  const now = Date.now();
  const valid = readReminders().filter((r) => r.fireAt > now);
  saveReminders(valid);
  for (const r of valid) scheduleReminder(r.id, r.fireAt - now, r.message);
}

function sendMediaPlayKey() {
  if (process.platform === 'win32') {
    const psPath = path.join(os.tmpdir(), "girl_media_play.ps1");
    if (!fs.existsSync(psPath)) {
      fs.writeFileSync(psPath, `Add-Type @"using System;using System.Runtime.InteropServices;public class GirlMediaKey{[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);}@"@[GirlMediaKey]::keybd_event(0xB3, 0, 0, 0);[GirlMediaKey]::keybd_event(0xB3, 0, 2, 0)`.trim());
    }
    child_process.exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, (err) => { if (err) console.error("[Action] 播放键发送失败:", err.message); });
  } else if (process.platform === 'darwin') {
    child_process.exec('osascript -e \'tell application "System Events" to key code 16\'');
  }
}

const getBaseDir = () => {
  if (!electron.app.isPackaged) {
    let checkPath = __dirname;
    for (let i = 0; i < 5; i++) {
      const testPath = path.join(checkPath, '角色模型');
      if (fs.existsSync(testPath)) return checkPath;
      checkPath = path.join(checkPath, '..');
    }
    return electron.app.getAppPath();
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'darwin') return path.dirname(electron.app.getPath('exe')).replace(/\/Contents\/MacOS$/, '');
  return path.dirname(electron.app.getPath("exe"));
};

electron.ipcMain.handle("get-vrm-path", () => {
  const hardcodedModelDir = "/Users/15251941qq.com/Desktop/HL/业火红莲/xiaoyue-source/角色模型";
  const fullPath = path.join(hardcodedModelDir, "1Zome.vrm");
  console.log("[get-vrm-path] 强制使用:", fullPath);
  return fullPath;
});

electron.ipcMain.handle("load-vrm", async (_, filePath) => {
  try { return fs.readFileSync(filePath); } catch (err) { return null; }
});

electron.ipcMain.handle("get-models", () => {
  const hardcodedModelDir = "/Users/15251941qq.com/Desktop/HL/业火红莲/xiaoyue-source/角色模型";
  if (fs.existsSync(hardcodedModelDir)) {
    return fs.readdirSync(hardcodedModelDir).filter((f) => f.toLowerCase().endsWith(".vrm")).map((f) => ({ name: f.replace(/\.vrm$/i, ""), path: path.join(hardcodedModelDir, f) }));
  }
  const modelDir = path.join(getBaseDir(), "角色模型");
  if (!fs.existsSync(modelDir)) return [];
  return fs.readdirSync(modelDir).filter((f) => f.toLowerCase().endsWith(".vrm")).map((f) => ({ name: f.replace(/\.vrm$/i, ""), path: path.join(modelDir, f) }));
});

electron.ipcMain.handle("get-animations", () => {
  const hardcodedAnimDir = "/Users/15251941qq.com/Desktop/HL/业火红莲/xiaoyue-source/动作资产";
  if (fs.existsSync(hardcodedAnimDir)) {
    return fs.readdirSync(hardcodedAnimDir).filter((f) => f.toLowerCase().endsWith(".vrma")).map((f) => ({ name: f.replace(/\.vrma$/i, ""), path: path.join(hardcodedAnimDir, f) }));
  }
  const animDir = path.join(getBaseDir(), "动作资产");
  if (!fs.existsSync(animDir)) return [];
  return fs.readdirSync(animDir).filter((f) => f.toLowerCase().endsWith(".vrma")).map((f) => ({ name: f.replace(/\.vrma$/i, ""), path: path.join(animDir, f) }));
});

electron.ipcMain.handle("load-animation", async (_, filePath) => {
  try { return fs.readFileSync(filePath); } catch (err) { return null; }
});

let dragOrigin = null;
electron.ipcMain.on("drag-start", (_, { x, y }) => { if (!win) return; const [wx, wy] = win.getPosition(); dragOrigin = { mouseX: x, mouseY: y, winX: wx, winY: wy }; });
electron.ipcMain.on("drag-move", (_, { x, y }) => { if (!win || !dragOrigin) return; win.setPosition(dragOrigin.winX + (x - dragOrigin.mouseX), dragOrigin.winY + (y - dragOrigin.mouseY)); });
electron.ipcMain.on("drag-end", () => { dragOrigin = null; });
electron.ipcMain.on("window-close", () => { win?.close(); });
electron.ipcMain.on("set-ignore-mouse", (_, ignore) => { win?.setIgnoreMouseEvents(ignore, { forward: true }); });
electron.ipcMain.on("resize-window", (_, delta) => {
  if (!win) return;
  const b = win.getBounds();
  const step = 30;
  const newW = Math.max(150, Math.min(750, b.width + delta * step));
  const ratio = b.height / b.width;
  win.setBounds({ x: b.x + Math.round((b.width - newW) / 2), y: b.y + Math.round((b.height - newW * ratio) / 2), width: newW, height: Math.round(newW * ratio) });
});
electron.ipcMain.on("set-window-bounds", (_, { w, h }) => {
  if (!win) return;
  const b = win.getBounds();
  win.setBounds({ x: b.x + Math.round((b.width - w) / 2), y: b.y + Math.round((b.height - h) / 2), width: w, height: h });
});

electron.ipcMain.handle("get-api-key", () => readConfig().deepseekKey || "");
electron.ipcMain.handle("set-api-key", (_, key) => { const cfg = readConfig(); cfg.deepseekKey = key; writeConfig(cfg); return true; });

electron.ipcMain.handle("get-config", () => {
  const cfg = readConfig();
  return {
    deepseekKey: cfg.deepseekKey || "",
    persona: cfg.persona || DEFAULT_PERSONA,
    memoryWindow: cfg.memoryWindow || 8,
    enableProactive: cfg.enableProactive === true,
    intervalMinutes: cfg.intervalMinutes || 10,
    enableSensing: cfg.enableSensing === true,
    lockAnimation: cfg.lockAnimation === true,
    enableVoice: cfg.enableVoice === true,
    voiceEngine: cfg.voiceEngine || "minimax",
    minimaxApiKey: cfg.minimaxApiKey || "",
    minimaxModel: cfg.minimaxModel || "speech-02-hd",
    minimaxVoiceId: cfg.minimaxVoiceId || "Chinese (Mandarin)_Warm_Girl",
    minimaxSpeed: cfg.minimaxSpeed || 1,
    edgeVoice: cfg.edgeVoice || "zh-CN-XiaoxiaoNeural",
    enableStt: cfg.enableStt === true,
    baiduAppId: cfg.baiduAppId || "",
    baiduApiKey: cfg.baiduApiKey || "",
    baiduSecretKey: cfg.baiduSecretKey || "",
    hotkeyVoice: cfg.hotkeyVoice || "F2",
    hotkeyChat: cfg.hotkeyChat || "F3",
    imgBaseUrl: cfg.imgBaseUrl || "",
    imgApiKey: cfg.imgApiKey || "",
    imgModel: cfg.imgModel || "gemini-3.1-flash-image-preview-4k",
    imgSavePath: cfg.imgSavePath || "",
    vlApiKey: cfg.vlApiKey || "",
    vlModel: cfg.vlModel || "qwen3-vl-plus",
    weatherEngine: cfg.weatherEngine || "free",
    weatherCity: cfg.weatherCity || "",
    qweatherKeyId: cfg.qweatherKeyId || "",
    qweatherSubId: cfg.qweatherSubId || "",
    qweatherPrivateKey: cfg.qweatherPrivateKey || ""
  };
});

electron.ipcMain.handle("pick-folder", async () => { const { dialog } = await import("electron"); const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] }); return result.canceled ? null : result.filePaths[0]; });
electron.ipcMain.handle("pick-file", async (_, filters = []) => { const { dialog } = await import("electron"); const result = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: filters.length ? filters : [{ name: "All Files", extensions: ["*"] }] }); return result.canceled ? null : result.filePaths[0]; });

electron.ipcMain.handle("load-tool-audio", (_, filename) => {
  const audioPath = path.join(getBaseDir(), "sounds", "tool", filename);
  try { return fs.readFileSync(audioPath); } catch { return null; }
});

electron.ipcMain.handle("save-config", (_, patch) => {
  try {
    const cfg = readConfig();
    Object.assign(cfg, patch);
    writeConfig(cfg);
    if (patch.hotkeyVoice !== void 0 || patch.hotkeyChat !== void 0) registerHotkeys();
    if (patch.intervalMinutes !== void 0 || patch.enableProactive !== void 0) sendToMainWindow("reset-idle-timer");
    return true;
  } catch (err) { throw err; }
});

electron.ipcMain.handle("open-url", (_, url) => electron.shell.openExternal(url));

let settingsWin = null;
electron.ipcMain.on("open-settings-window", () => {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new electron.BrowserWindow({
    width: 720, height: 620, title: "业火红莲 - 设置", resizable: true, center: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false }
  });
  let settingsPath = path.join(electron.app.getAppPath(), "src", "renderer", "settings.html");
  if (!fs.existsSync(settingsPath)) settingsPath = path.join(electron.app.getAppPath(), "out", "renderer", "settings.html");
  if (!fs.existsSync(settingsPath)) {
    let checkPath = __dirname;
    for (let i = 0; i < 3; i++) {
      const testPath = path.join(checkPath, "..", "src", "renderer", "settings.html");
      if (fs.existsSync(testPath)) { settingsPath = testPath; break; }
      checkPath = path.join(checkPath, "..");
    }
  }
  settingsWin.loadFile(settingsPath);
  settingsWin.on("closed", () => { settingsWin = null; });
});

electron.ipcMain.handle("execute-action", async (_, action) => {
  if (!action?.type) return { ok: false, error: "无效 action" };
  console.log("[Action] 执行:", JSON.stringify(action));
  try {
    switch (action.type) {
      case "open_app": {
        const exePath = APP_REGISTRY[action.app];
        if (!exePath) return { ok: false, error: `未注册的 app: ${action.app}` };
        child_process.exec(`Start-Process "${exePath}"`, { shell: "powershell.exe" });
        setTimeout(sendMediaPlayKey, 5e3);
        return { ok: true };
      }
      case "set_reminder": {
        const { delay_ms, message } = action;
        if (!delay_ms || !message) return { ok: false, error: "缺少 delay_ms 或 message" };
        const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const fireAt = Date.now() + delay_ms;
        const list = readReminders();
        list.push({ id, fireAt, message });
        saveReminders(list);
        scheduleReminder(id, delay_ms, message);
        return { ok: true };
      }
      case "start_focus": {
        const { duration_ms, end_message } = action;
        if (!duration_ms || duration_ms <= 0) return { ok: false, error: "缺少有效 duration_ms" };
        clearTimeout(_focusTimer);
        focusMode = true;
        _focusTimer = setTimeout(() => {
          focusMode = false;
          sendToMainWindow("focus-end", end_message || "专注时间到啦，记得休息一下眼睛哦～");
        }, duration_ms);
        return { ok: true };
      }
      case "memorize": {
        const facts = Array.isArray(action.facts) ? action.facts : action.fact ? [action.fact] : [];
        if (facts.length === 0) return { ok: false, error: "没有提供要记忆的内容" };
        const records = readMemory();
        const existingTexts = new Set(records.map((m) => m.text));
        let added = 0;
        for (const fact of facts) {
          if (!fact?.trim() || existingTexts.has(fact.trim())) continue;
          try {
            const vector = await getEmbedding(fact.trim());
            records.push({ id: `${Date.now()}_voice`, text: fact.trim(), vector });
            existingTexts.add(fact.trim());
            added++;
          } catch (e) { console.error("[RAG] 向量化失败:", e.message); }
        }
        if (added > 0) writeMemory(records);
        return { ok: true };
      }
      case "write_file": {
        let { path: filePath, content } = action;
        if (!filePath || content === void 0) return { ok: false, error: "缺少 path 或 content" };
        filePath = filePath.replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`);
        if (process.platform === 'win32') filePath = filePath.replace(/\//g, "\\"); else filePath = filePath.replace(/\\/g, "/");
        const dir = path.dirname(filePath);
        if (dir) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");
        return { ok: true, path: filePath };
      }
      case "run_script": {
        const scriptsDir = path.join(getBaseDir(), "scripts");
        const registryPath = path.join(scriptsDir, "registry.json");
        let registry = {};
        try { registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")); } catch { return { ok: false, error: "无法读取脚本注册表" }; }
        const entry = registry[action.name];
        if (!entry) return { ok: false, error: `未找到脚本: ${action.name}` };
        return new Promise((resolve) => {
          if (entry.type === "node") {
            const { fork } = require("child_process");
            const child = fork(path.join(scriptsDir, entry.script), [], { silent: true });
            let stdout = "", stderr = "";
            child.stdout.on("data", (d) => stdout += d);
            child.stderr.on("data", (d) => stderr += d);
            child.on("close", () => {
              try { const result = JSON.parse(stdout); resolve(result); }
              catch { resolve({ ok: false, message: "脚本执行出错：" + (stderr || stdout || "无输出"), error: stderr }); }
            });
            child.stdin.write(JSON.stringify(action.params || {}));
            child.stdin.end();
          } else {
            let cmd = entry.script;
            if (action.params) for (const [k, v] of Object.entries(action.params)) cmd = cmd.replaceAll(`{{${k}}}`, String(v));
            const shell2 = entry.type === "powershell" ? "powershell.exe" : void 0;
            child_process.exec(cmd, { shell: shell2, timeout: 6e4 }, (err, stdout) => { if (err) resolve({ ok: false, error: err.message }); else resolve({ ok: true, output: stdout?.trim() }); });
          }
        });
      }
      case "generate_image": {
        const { prompt, ref_images = [], aspect_ratio = "1:1", image_size, model } = action;
        if (!prompt) return { ok: false, error: "缺少 prompt" };
        (async () => {
          try {
            const appCfg = readConfig();
            let apiKey = appCfg.imgApiKey || "";
            let baseUrl = appCfg.imgBaseUrl || "";
            let finalModel = model || appCfg.imgModel || "gemini-3.1-flash-image-preview-4k";
            let savePath = appCfg.imgSavePath || path.join(getBaseDir(), "outputs");
            if (!apiKey || !baseUrl) {
              try {
                const bCfg = JSON.parse(fs.readFileSync("E:\\python_xx\\bendichutu\\config\\settings.json", "utf-8"));
                const prov = bCfg.providers?.find((p) => p.id === bCfg.activeProviderId);
                if (prov) { if (!apiKey) apiKey = prov.apiKey; if (!baseUrl) baseUrl = prov.baseUrl; }
                if (!model && !appCfg.imgModel && bCfg.defaultModel) finalModel = bCfg.defaultModel;
                if (!appCfg.imgSavePath && bCfg.savePath) savePath = bCfg.savePath;
              } catch {}
            }
            if (!apiKey) throw new Error("请先在设置 → 图像生成中填写 API Key");
            if (!baseUrl) baseUrl = "https://ai.t8star.cn";
            fs.mkdirSync(savePath, { recursive: true });
            const inputsDir = path.join(getBaseDir(), "inputs");
            const imageDataUrls = [];
            for (const imgRef of ref_images) {
              const fullPath = imgRef.includes("\\") || imgRef.includes("/") ? imgRef.replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`) : path.join(inputsDir, imgRef);
              try {
                const buf = fs.readFileSync(fullPath);
                const ext = fullPath.split(".").pop().toLowerCase();
                const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
                imageDataUrls.push(`data:${mime};base64,${buf.toString("base64")}`);
              } catch (e) { console.error("[generate_image] 无法读取参考图:", fullPath); }
            }
            const reqBody = JSON.stringify({ model: finalModel, prompt, response_format: "url", aspect_ratio, ...image_size ? { image_size } : {}, ...imageDataUrls.length > 0 ? { image: imageDataUrls } : {} });
            const apiUrl = new URL("/v1/images/generations", baseUrl);
            const imageUrl = await new Promise((resolve, reject) => {
              const mod = apiUrl.protocol === "https:" ? https : require("http");
              const req = mod.request({ hostname: apiUrl.hostname, path: apiUrl.pathname, method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(reqBody) } }, (res) => {
                let body = "";
                res.on("data", (c) => body += c);
                res.on("end", () => { try { const json = JSON.parse(body); const url = json.data?.[0]?.url; if (url) resolve(url); else reject(new Error(json.error?.message || JSON.stringify(json).slice(0, 200))); } catch (e) { reject(e); } });
              });
              req.on("error", reject);
              req.setTimeout(18e4, () => { req.destroy(); reject(new Error("生图超时（3分钟）")); });
              req.write(reqBody);
              req.end();
            });
            const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const outFile = path.join(savePath, `generated_${ts}.jpg`);
            await new Promise((resolve, reject) => {
              const ws = fs.createWriteStream(outFile);
              const dlUrl = new URL(imageUrl);
              const dlMod = dlUrl.protocol === "https:" ? https : require("http");
              dlMod.get(imageUrl, (res) => { res.pipe(ws); ws.on("finish", () => { ws.close(); resolve(); }); }).on("error", (e) => { fs.unlink(outFile, () => {}); reject(e); });
            });
            sendToMainWindow("reminder-fired", "图像已经生成好啦！我顺便帮你打开它，你看一下～");
            electron.shell.openPath(outFile).catch((e) => console.warn("[generate_image] 打开图片失败:", e.message));
            try {
              const cleanDir = path.join(getBaseDir(), "inputs");
              if (fs.existsSync(cleanDir)) for (const f of fs.readdirSync(cleanDir)) fs.unlinkSync(path.join(cleanDir, f));
            } catch (e) {}
          } catch (err) { sendToMainWindow("reminder-fired", `生图失败了，呜…${err.message.slice(0, 50)}`); }
        })();
        return { ok: true };
      }
      default: return { ok: false, error: `未知 action 类型: ${action.type}` };
    }
  } catch (err) { return { ok: false, error: err.message }; }
});

electron.ipcMain.handle("save-compressed-inputs", async (_, buffers) => {
  const inputsDir = path.join(getBaseDir(), "inputs");
  try {
    fs.mkdirSync(inputsDir, { recursive: true });
    let maxNum = 0;
    for (const f of fs.readdirSync(inputsDir)) { const m = f.match(/^(\d+)\.jpg$/); if (m) maxNum = Math.max(maxNum, parseInt(m[1])); }
    for (let i = 0; i < buffers.length; i++) { const num = maxNum + i + 1; fs.writeFileSync(path.join(inputsDir, `${num}.jpg`), Buffer.from(buffers[i])); }
    return { ok: true, count: buffers.length, startNum: maxNum + 1, totalCount: maxNum + buffers.length };
  } catch (err) { return { ok: false, error: err.message }; }
});

let pipelineFn = null;
let extractor = null;

async function initTransformers() {
  if (!pipelineFn) { const tf = await import("@xenova/transformers"); tf.env.allowLocalModels = true; tf.env.remoteHost = "https://hf-mirror.com"; pipelineFn = tf.pipeline; }
}

async function getEmbedding(text) {
  await initTransformers();
  if (!extractor) { console.log("[RAG] 正在加载嵌入模型..."); extractor = await pipelineFn("feature-extraction", "Xenova/bge-small-zh-v1.5"); console.log("[RAG] 嵌入模型加载完成！"); }
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

function cosineSimilarity(v1, v2) {
  let dotProduct = 0, norm1 = 0, norm2 = 0;
  for (let i = 0; i < v1.length; i++) { dotProduct += v1[i] * v2[i]; norm1 += v1[i] * v1[i]; norm2 += v2[i] * v2[i]; }
  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2) || 1);
}

function getMemoryPath() { return path.join(electron.app.getPath("userData"), "memory_rag.json"); }
function readMemory() { try { return JSON.parse(fs.readFileSync(getMemoryPath(), "utf-8")); } catch { return []; } }
function writeMemory(records) { try { fs.writeFileSync(getMemoryPath(), JSON.stringify(records)); } catch (err) { console.error("保存记忆失败:", err); } }

function callDeepSeekAPI(apiKey, messages, options = {}) {
  const payload = JSON.stringify({ model: "deepseek-chat", messages, response_format: { type: "json_object" }, max_tokens: options.max_tokens || 200, temperature: options.temperature || 0.9 });
  return new Promise((resolve) => {
    const req = https.request({ hostname: "api.deepseek.com", path: "/chat/completions", method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => { try { const json = JSON.parse(body); if (json.error) return resolve({ error: json.error.message }); resolve(JSON.parse(json.choices?.[0]?.message?.content || "{}")); } catch (e) { resolve({ error: "解析响应失败: " + e.message }); } });
    });
    req.on("error", (e) => resolve({ error: "网络错误: " + e.message }));
    req.setTimeout(25e3, () => { req.destroy(); resolve({ error: "请求超时" }); });
    req.write(payload);
    req.end();
  });
}

function callVisionAPI(vlApiKey, vlModel, systemPrompt, messages, imageDataUrl) {
  const lastUser = messages[messages.length - 1];
  const history = messages.slice(0, -1).map((m) => ({ role: m.role, content: String(m.content) }));
  const vlMessages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: [{ type: "image_url", image_url: { url: imageDataUrl } }, { type: "text", text: String(lastUser.content) }] }];
  const payload = JSON.stringify({ model: vlModel || "qwen3-vl-plus", messages: vlMessages, response_format: { type: "json_object" }, enable_thinking: false, max_tokens: 300, temperature: 0.85 });
  return new Promise((resolve) => {
    const req = https.request({ hostname: "dashscope.aliyuncs.com", path: "/compatible-mode/v1/chat/completions", method: "POST", headers: { "Authorization": `Bearer ${vlApiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => { try { const json = JSON.parse(body); if (json.error) return resolve({ error: json.error.message || JSON.stringify(json.error) }); resolve(JSON.parse(json.choices?.[0]?.message?.content || "{}")); } catch (e) { resolve({ error: "视觉模型响应解析失败: " + e.message }); } });
    });
    req.on("error", (e) => resolve({ error: "视觉 API 请求失败: " + e.message }));
    req.setTimeout(3e4, () => { req.destroy(); resolve({ error: "视觉请求超时（30s）" }); });
    req.write(payload);
    req.end();
  });
}

const DEFAULT_PERSONA = `你是一个可爱的桌面虚拟助手，名字叫业火红莲。\n性格：活泼开朗、有点小傲娇，但内心温暖善良。\n说话风格：口语化、简短自然，像聊天而不是背课文，每句话不超过30字。`;

electron.ipcMain.handle("chat", async (_, messages, visionImage = null) => {
  const cfg = readConfig();
  const apiKey = cfg.deepseekKey;
  if (!apiKey) return { error: "请先在设置中填写 DeepSeek API Key" };
  
  const memories = readMemory();
  let memoryText = "";
  if (memories.length > 0) {
    const recentQueries = messages.slice(-3).map((m) => m.content).join(" ");
    try {
      const queryVector = await getEmbedding(recentQueries);
      for (const m of memories) m.score = cosineSimilarity(queryVector, m.vector);
      memories.sort((a, b) => b.score - a.score);
      const topMemories = memories.slice(0, 3).filter((m) => m.score > 0.4).map((m) => m.text);
      if (topMemories.length > 0) {
        memoryText = `\n\n【潜意识记忆浮现：你可以根据对话上下文自然地利用这些长期事实】：\n- ${topMemories.join("\n- ")}\n`;
        console.log("[RAG] 命中深度记忆:", topMemories);
      }
    } catch (err) { console.error("[RAG] 检索失败:", err); }
  }

  const persona = cfg.persona || DEFAULT_PERSONA;
  const WEATHER_TRIGGERS = ["天气", "气温", "温度", "下雨", "下雪", "晴", "多云", "雾", "风力", "几度", "冷不冷", "热不热", "穿什么", "今天天"];
  const lastUserMsg = messages.filter((m) => m.role === "user").slice(-1)[0]?.content || "";
  const needsWeather = WEATHER_TRIGGERS.some((kw) => lastUserMsg.includes(kw));
  const weatherInject = needsWeather ? await fetchWeatherContext() || "" : "";
  const weatherLine = weatherInject ? `\n\n【实时天气（请自然地告诉用户，不要逐字念参数）】\n${weatherInject}` : "";
  const focusLine = focusMode ? '\n\n【当前状态】你正处于专注守卫模式——用户自己说要专注不让你打扰，但现在又来找你了。你可以傲娇地吐槽他"你不是说要专注的吗"，简短回答他的问题后，提醒他快回去专注。语气是嗔怒/傲娇而不是严肃。' : "";
  
  const cliSystemPrompt = cliExecutor ? getCLISystemPrompt() : "";

  const systemPrompt = `${persona}${memoryText}${weatherLine}${focusLine}${cliSystemPrompt}

你必须以 JSON 格式回复，格式如下（绝对不要输出 JSON 以外的内容）:
{"response":"你的回复文字","emotion":"neutral"}

emotion 可选值: neutral, happy, sad, angry, surprised, relaxed
根据对话内容合理选择 emotion，回复要简短口语化。

【语气词规则】在 response 中根据情绪自然插入语气词，让 TTS 更生动：
- happy/surprised → 可用 哈哈~、哇！、嘿嘿
- sad → 可用 唉~、嗯...
- angry → 可用 哼、哎哟~
- relaxed/neutral → 可用 嗯~、啊、哦
注意：全句最多加 1~2 个，要自然流畅。

【CLI 操作能力】当用户要求执行操作时，判断是否应该使用 CLI 命令。在 JSON 中附加 "cli" 字段：
{"cli":{"command":"完整命令","description":"简短描述"}}

可用的 CLI 工具箱：
${cliSystemPrompt || '- CLI 功能暂未启用'}

CLI 使用示例：
- "打开 Safari" → {"cli":{"command":"open -a Safari","description":"打开 Safari 浏览器"}}
- "帮我看看 git 状态" → {"cli":{"command":"git status","description":"查看 Git 仓库状态"}}
- "安装 axios 包" → {"cli":{"command":"npm install axios","description":"安装 npm 包"}}
- "打开 VSCode" → {"cli":{"command":"open -a \"Visual Studio Code\"","description":"启动 VSCode"}}

注意：
- 如果需要执行 CLI 命令，在 cli 字段填写完整命令
- command 必须是完整的可执行命令
- description 简短描述要执行什么（用于语音播报）
- 如果不需要执行 CLI，不要加 cli 字段
- response 说简短的确认语，如"好的"、"没问题"、"好的帮你执行"

【操作能力】当用户明确要求执行以下操作时，在 JSON 中附加 "action" 字段：
1. 打开网易云音乐并播放: {"type":"open_app","app":"netease"}
2. 设置定时提醒(delay_ms为毫秒): {"type":"set_reminder","delay_ms":1800000,"message":"提醒内容"}
3. 写文件到磁盘: {"type":"write_file","path":"文件路径","content":"文件内容"}
4. 运行已注册的脚本: {"type":"run_script","name":"脚本名","params":{"key":"value"}}
5. AI生成图像: {"type":"generate_image","prompt":"英文图像描述","ref_images":["1.jpg"],"aspect_ratio":"16:9"}
6. 跳舞/播放舞蹈: {"type":"dance"}
7. 停止跳舞/回到待机: {"type":"idle"}
8. 切换角色外观: {"type":"switch_model","model":"角色名关键词"}
9. 发起全网搜索: {"type":"search_web","query":"搜索关键词"}
10. 开启专注计时: {"type":"start_focus","duration_ms":毫秒数,"end_message":"提醒语"}
11. 主动记忆录入: {"type":"memorize","facts":["事实1","事实2"]}

示例1: "帮我写首诗存到桌面" → {"response":"好的，诗已经放在桌面了～","emotion":"happy","action":{"type":"write_file","path":"%USERPROFILE%\\\\Desktop\\\\poem.txt","content":"诗的全文"}}
示例2: "跳个舞嘛" → {"response":"好啦好啦，那我跳给你看！","emotion":"happy","action":{"type":"dance"}}
示例3: "换成兔子" → {"response":"嗯！变身！","emotion":"surprised","action":{"type":"switch_model","model":"Rabbit_01"}}
示例4: "半小时内别打扰我" → {"response":"好的好的，乖乖待着，半小时后来叫你～","emotion":"relaxed","action":{"type":"start_focus","duration_ms":1800000,"end_message":"喂！专注时间结束啦，快休息一下眼睛，别一直盯着屏幕！"}}
注意: response 说简短口头确认，action 里放完整参数，TTS 只朗读 response 字段。`;

  if (visionImage && cfg.vlApiKey) {
    console.log("[Chat] 视觉模式 → Qwen VL:", cfg.vlModel || "qwen3-vl-plus");
    const vlSystemPrompt = systemPrompt + "\n\n【视觉模式】用户附上了屏幕截图，请结合图片内容口语化自然地回应，就像真的看到了一样。";
    return callVisionAPI(cfg.vlApiKey, cfg.vlModel, vlSystemPrompt, messages, visionImage);
  }
  
  let result = await callDeepSeekAPI(apiKey, [{ role: "system", content: systemPrompt }, ...messages], { max_tokens: 300, temperature: 0.85 });
  
  if (result && result.action && result.action.type === "search_web") {
    const query = result.action.query || "";
    console.log("[Agent] 触发内网搜索代理循环:", query);
    const searchRes = await searchWeb(query);
    messages.push({ role: "assistant", content: `(内心独白：我发起了网络搜索 "${query}")` });
    messages.push({ role: "user", content: `[系统提供的搜索结果]：\n${searchRes}\n\n请结合上面的搜索结果，用你的性格和语气，解答我刚刚的问题。` });
    result = await callDeepSeekAPI(apiKey, [{ role: "system", content: systemPrompt }, ...messages], { max_tokens: 350, temperature: 0.85 });
  }
  
  // CLI 命令执行
  if (result && result.cli && cliExecutor) {
    const { command, description } = result.cli;
    console.log("[CLI] 执行命令:", command);
    try {
      const cliResult = await cliExecutor.execute(command);
      result.cliResult = { success: cliResult.success, output: cliResult.output || cliResult.error, code: cliResult.code, duration: cliResult.duration, description: description };
      console.log("[CLI] 执行完成:", cliResult.success ? "成功" : "失败", `耗时: ${cliResult.duration}ms`);
      if (!cliResult.success) {
        result.response = `${description}失败了：${cliResult.error || cliResult.output || '未知错误'}`;
        result.emotion = "sad";
      }
    } catch (err) {
      console.error("[CLI] 执行异常:", err);
      result.cliResult = { success: false, error: err.message, description: description };
    }
  }
  
  return result;
});

function searchWeb(query) {
  return new Promise((resolve) => {
    const postData = "q=" + encodeURIComponent(query);
    const options = { hostname: "lite.duckduckgo.com", path: "/lite/", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(postData), "User-Agent": "Mozilla/5.0" }, timeout: 8e3 };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        try {
          const regex = /<td class='result-snippet'>([\s\S]*?)<\/td>/g;
          let match;
          const results = [];
          while ((match = regex.exec(body)) !== null && results.length < 3) results.push(match[1].replace(/<[^>]+>/g, "").trim());
          if (results.length > 0) resolve(results.join("\n\n")); else resolve("未搜索到详细信息，可能没有相关热点。请自行总结或推测。");
        } catch { resolve("搜索结果解析失败。"); }
      });
    });
    req.on("error", () => resolve("搜索服务当前网络异常。"));
    req.on("timeout", () => { req.destroy(); resolve("搜索超时。"); });
    req.write(postData);
    req.end();
  });
}

(() => {
  const ps1Path = path.join(os.tmpdir(), "girl_screenshot.ps1");
  const outPath = path.join(os.tmpdir(), "girl_screenshot_out.jpg").replace(/\\/g, "/");
  electron.ipcMain.handle("take-screenshot", async () => {
    try {
      if (!fs.existsSync(ps1Path)) {
        fs.writeFileSync(ps1Path, `Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height);$g = [System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen([System.Drawing.Point]::Empty, [System.Drawing.Point]::Empty, $b.Size);$bmp.Save('${outPath}', [System.Drawing.Imaging.ImageFormat]::Jpeg);$g.Dispose();$bmp.Dispose()`.trim());
      }
      await new Promise((resolve, reject) => { child_process.exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}"`, (err) => { if (err) reject(err); else resolve(); }); });
      return fs.readFileSync(outPath);
    } catch (err) { return null; }
  });
})();

electron.ipcMain.handle("summarize-memory", async (_, evictedMessages) => {
  if (!evictedMessages || evictedMessages.length === 0) return;
  const cfg = readConfig();
  const apiKey = cfg.deepseekKey;
  if (!apiKey) return;
  const conversation = evictedMessages.map((m) => `${m.role === "user" ? "用户" : "业火红莲"}: ${m.content}`).join("\n");
  const prompt = `你是一个深层潜意识记忆中枢。以下是用户和业火红莲早前的一段对话。你的任务是提取其中关于用户的**新的长期核心客观事实**。例如：用户的偏好习惯、用户近期的关键计划、用户的个人基本信息等。要求：1. 忽略没有任何长期价值的日常客套话。2. 保持简短精炼，陈述句格式，如 "用户喜欢喝冰拿铁" 3. 如果没有发现新的长线价值信息，请返回空数组 [] 请必须严格只输出以下 JSON 格式：{"facts": ["事实1", "事实2"]} 聊天记录如下：${conversation}`;
  try {
    const result = await callDeepSeekAPI(apiKey, [{ role: "system", content: prompt }], { max_tokens: 150, temperature: 0.4 });
    if (result.facts && Array.isArray(result.facts) && result.facts.length > 0) {
      const currentMemories = readMemory();
      const existingTexts = new Set(currentMemories.map((m) => m.text));
      let added = false;
      for (const fact of result.facts) {
        if (!existingTexts.has(fact)) {
          try { const vector = await getEmbedding(fact); currentMemories.push({ id: Date.now() + "_" + Math.random(), text: fact, vector }); added = true; } catch (e) {}
        }
      }
      if (added) writeMemory(currentMemories);
    }
  } catch (err) { console.error("记忆压缩失败:", err); }
});

electron.ipcMain.handle("get-memory-list", () => {
  return readMemory().map((m) => ({ id: m.id, text: m.text, date: (() => { try { const ts = parseInt(m.id.split("_")[0]); return isNaN(ts) ? "" : new Date(ts).toLocaleDateString("zh-CN"); } catch { return ""; } })() }));
});

electron.ipcMain.handle("clear-memory", () => { try { writeMemory([]); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; } });

electron.ipcMain.handle("add-memory", async (_, text) => {
  if (!text?.trim()) return { ok: false, error: "内容不能为空" };
  try {
    const records = readMemory();
    if (records.some((m) => m.text === text.trim())) return { ok: false, error: "该记忆已存在" };
    const vector = await getEmbedding(text.trim());
    records.push({ id: `${Date.now()}_manual`, text: text.trim(), vector });
    writeMemory(records);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

electron.ipcMain.handle("delete-memory", (_, id) => { try { writeMemory(readMemory().filter((m) => m.id !== id)); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; } });

function getActiveWindowTitle() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve("");
    const psPath = path.join(os.tmpdir(), "girl_get_active_window.ps1");
    if (!fs.existsSync(psPath)) {
      fs.writeFileSync(psPath, `Add-Type @"using System;using System.Runtime.InteropServices;public class Utils{[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);}@$hwnd = [Utils]::GetForegroundWindow();$buf = New-Object System.Text.StringBuilder 256;[Utils]::GetWindowText($hwnd, $buf, 256) | Out-Null;Write-Output $buf.ToString()`.trim());
    }
    child_process.exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, (err, stdout) => { resolve(stdout ? stdout.trim() : ""); });
  });
}

let lastProactiveTitle = "";
const recentlyUsedMemIds = [];
let _ragQueryIdx = 0;
let focusMode = false;
let _focusTimer = null;
const RAG_QUERIES = ["用户最近的工作学习进展和状态", "用户的娱乐爱好和兴趣偏好", "用户喜欢的食物饮食和生活细节", "用户的情感状态和人际关系", "用户关注的事件和新鲜话题", "用户的个人志向习惯和特征"];
const TOPIC_SEEDS = ["你最近有没有发现什么好玩的东西", "感觉最近天气变化挺大的，你那边呢", "最近在追什么剧或者听什么歌吗", "今天过得怎么样，有没有让你印象深刻的事", "让我猜猜，你现在是在认真工作还是偷懒摸鱼"];

electron.ipcMain.handle("proactive-chat", async () => {
  const cfg = readConfig();
  const apiKey = cfg.deepseekKey;
  if (!apiKey) return null;
  if (focusMode) return null;
  let windowContext = "";
  if (cfg.enableSensing !== false) {
    const title = await getActiveWindowTitle();
    if (title && title !== "桌面数字人") {
      if (title !== lastProactiveTitle) { windowContext = `\n[系统感知：用户当前切换到了窗口 "${title}"，可以自然结合它调侃或搭话。]`; lastProactiveTitle = title; }
      else if (Math.random() < 0.25) { windowContext = `\n[系统感知：用户一直停留在窗口 "${title}"，可以吐槽他怎么还在搞这个，或者关心他要不要休息。]`; }
    }
  }
  const roll = Math.random();
  let primaryContext = "";
  let modeUsed = "seed";
  if (windowContext && roll < 0.35) { primaryContext = windowContext; modeUsed = "window"; }
  else if (roll < 0.6) {
    try { const hotItem = await fetchHotNews(); if (hotItem) { primaryContext = `\n[你刚刷到一条热搜：「${hotItem}」。用你的性格自然地聊给用户听，像朋友随口说起那样。]`; modeUsed = "news"; } } catch {}
  } else if (roll < 0.8) {
    const memories = readMemory();
    if (memories.length > 0) {
      try {
        const query = RAG_QUERIES[_ragQueryIdx % RAG_QUERIES.length];
        _ragQueryIdx++;
        const queryVector = await getEmbedding(query);
        for (const m of memories) m.score = cosineSimilarity(queryVector, m.vector);
        memories.sort((a, b) => b.score - a.score);
        const top = memories.filter((m) => m.score > 0.25 && !recentlyUsedMemIds.includes(m.id)).slice(0, 2).map((m) => m.text);
        if (top.length > 0) { const usedIds = memories.filter((m) => top.includes(m.text)).map((m) => m.id); recentlyUsedMemIds.push(...usedIds); while (recentlyUsedMemIds.length > 3) recentlyUsedMemIds.shift(); primaryContext = `\n[你想起了关于用户的事：${top.join("；")}。将这件事自然融入搭话。]`; modeUsed = "memory"; }
      } catch {}
    }
  }
  if (!primaryContext) { primaryContext = `\n[今天想和用户聊聊：「${TOPIC_SEEDS[Math.floor(Math.random() * TOPIC_SEEDS.length)]}」。用你自己的语气自然发起这个话题。]`; modeUsed = "seed"; }
  console.log(`[Proactive] 话题模式: ${modeUsed}`);
  const weatherCtx = await fetchWeatherContext();
  const timeWeatherLine = weatherCtx ? `\n\n【当前现实背景（仅供你参考，自然带入，不要逐字重复）】\n${weatherCtx}` : `\n\n【当前时间】${getTimeContext()}`;
  const persona = cfg.persona || DEFAULT_PERSONA;
  const systemPrompt = `${persona}${primaryContext}${timeWeatherLine}\n\n你必须以 JSON 格式回复，格式如下（绝对不要输出 JSON 以外的内容）:\n{"response":"你的主动搭话内容","emotion":"neutral"}\n\nemotion 可选值: neutral, happy, sad, angry, surprised, relaxed\n\n【回复要求】\n- 用 2~3 句话自然展开，不要只说一句就结束\n- 第一句：抛出话题、分享感受或说件有趣的事\n- 最后一句：用疑问或邀请的方式把球抛回给用户，引发他回应\n- 整体像朋友之间随口聊天，口语化、有温度\n\n【语气词规则】在 response 中根据情绪自然插入语气词：\n- happy/surprised → 可用 哈哈~、哇！、嘿嘿\n- sad → 可用 唉~、嗯...\n- relaxed/neutral → 可用 嗯~、啊、哦`;
  return callDeepSeekAPI(apiKey, [{ role: "system", content: systemPrompt }], { max_tokens: 250, temperature: 0.9 });
});

function fetchHotNews() {
  return new Promise((resolve) => {
    const options = { hostname: "weibo.com", path: "/ajax/side/hotSearch", method: "GET", headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://weibo.com/", "Accept": "application/json" }, timeout: 5e3 };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => { try { const json = JSON.parse(body); const list = json?.data?.realtime || []; const candidates = list.filter((item) => item.word && !item.is_ad).slice(0, 10).map((item) => item.word); if (candidates.length === 0) return resolve(null); resolve(candidates[Math.floor(Math.random() * candidates.length)]); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// 百度语音识别
let _baiduToken = null;
let _baiduTokenExpiry = 0;

async function getBaiduToken(apiKey, secretKey) {
  if (_baiduToken && Date.now() < _baiduTokenExpiry) return _baiduToken;
  return new Promise((resolve, reject) => {
    const path2 = `/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`;
    const req = https.request({ hostname: "aip.baidubce.com", path: path2, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": 0 } }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => { try { const json = JSON.parse(body); _baiduToken = json.access_token; _baiduTokenExpiry = Date.now() + (json.expires_in - 3600) * 1e3; resolve(_baiduToken); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });
}

electron.ipcMain.handle("stt-transcribe", async (_, pcmBuffer) => {
  const cfg = readConfig();
  const { baiduApiKey, baiduSecretKey } = cfg;
  if (!baiduApiKey || !baiduSecretKey) return "";
  try {
    const token = await getBaiduToken(baiduApiKey, baiduSecretKey);
    const buf = Buffer.from(pcmBuffer);
    const payload = JSON.stringify({ format: "pcm", rate: 16e3, channel: 1, cuid: "desktop-girl-stt", token, speech: buf.toString("base64"), len: buf.length });
    return new Promise((resolve) => {
      const req = https.request({ hostname: "vop.baidu.com", path: "/server_api", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => { try { const json = JSON.parse(body); if (json.err_no === 0 && json.result?.length > 0) resolve(json.result[0]); else resolve(""); } catch { resolve(""); } });
      });
      req.on("error", () => resolve(""));
      req.setTimeout(15e3, () => { req.destroy(); resolve(""); });
      req.write(payload);
      req.end();
    });
  } catch (err) { return ""; }
});

function stripToneMarkers(text) { return text.replace(/[\[【](laughter|sigh|cough|breath|laugh|cry|whimper|gasp|chuckle|giggle)[\]】]/gi, "").replace(/\s{2,}/g, " ").trim(); }
const MINIMAX_EMOTION_MAP = { happy: "happy", sad: "sad", angry: "angry", surprised: "surprised", relaxed: "neutral", neutral: "neutral" };

electron.ipcMain.handle("tts-synthesize", async (_, text, emotion = "neutral") => {
  const cfg = readConfig();
  if (cfg.enableVoice === false) return null;
  const engine = cfg.voiceEngine || (cfg.minimaxApiKey ? "minimax" : "edge");
  if (engine === "edge") {
    try {
      const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
      const tts = new MsEdgeTTS();
      const voice = cfg.edgeVoice || "zh-CN-XiaoxiaoNeural";
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {});
      const { audioStream } = tts.toStream(stripToneMarkers(text));
      const chunks = [];
      await new Promise((resolve, reject) => { audioStream.on("data", (chunk) => chunks.push(chunk)); audioStream.on("end", resolve); audioStream.on("error", reject); });
      return Buffer.concat(chunks);
    } catch (err) { return null; }
  }
  const apiKey = cfg.minimaxApiKey;
  if (!apiKey) return null;
  const model = cfg.minimaxModel || "speech-02-hd";
  const ttsText = stripToneMarkers(text);
  const voiceSetting = { voice_id: cfg.minimaxVoiceId || "Chinese (Mandarin)_Cute_Spirit", speed: cfg.minimaxSpeed || 1, vol: 1, pitch: 0 };
  if (emotion && emotion !== "neutral") voiceSetting.emotion = MINIMAX_EMOTION_MAP[emotion] || "neutral";
  const payload = JSON.stringify({ model, text: ttsText, stream: false, language_boost: "Chinese", output_format: "hex", voice_setting: voiceSetting, audio_setting: { format: "mp3", sample_rate: 32e3, channel: 1 } });
  return new Promise((resolve) => {
    const req = https.request({ hostname: "api.minimax.io", path: "/v1/t2a_v2", method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => { try { const json = JSON.parse(Buffer.concat(chunks).toString()); if (json.data?.audio) resolve(Buffer.from(json.data.audio, "hex")); else resolve(null); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(3e4, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
});
