/**
 * 业火红莲 Web 版 - 后端服务器
 * 替代 Electron 主进程，通过 HTTP API 提供所有后端功能
 * 
 * 用法: node server.js [端口号]
 * 默认端口: 3456
 * 启动后浏览器打开 http://localhost:3456
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { exec, spawn, fork } = require('child_process');
const os = require('os');

const PORT = parseInt(process.argv[2]) || 3456;
const BASE_DIR = __dirname;

// ==================== 配置管理 ====================
function getConfigPath() { return path.join(os.homedir(), '.yehuo-config.json'); }
function readConfig() { try { return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')); } catch { return {}; } }
function writeConfig(data) { fs.writeFileSync(getConfigPath(), JSON.stringify(data, null, 2), 'utf-8'); }

// ==================== 记忆管理 ====================
function getMemoryPath() { return path.join(os.homedir(), '.yehuo-memory.json'); }
function readMemory() { try { return JSON.parse(fs.readFileSync(getMemoryPath(), 'utf-8')); } catch { return []; } }
function writeMemory(records) { try { fs.writeFileSync(getMemoryPath(), JSON.stringify(records)); } catch (e) { console.error('保存记忆失败:', e); } }

// ==================== 提醒管理 ====================
function getRemindersPath() { return path.join(os.homedir(), '.yehuo-reminders.json'); }
function readReminders() { try { return JSON.parse(fs.readFileSync(getRemindersPath(), 'utf-8')); } catch { return []; } }
function saveReminders(list) { try { fs.writeFileSync(getRemindersPath(), JSON.stringify(list, 'utf-8')); } catch (e) { console.error('[Reminder] 保存失败:', e); } }

const activeReminders = new Map();
function scheduleReminder(id, delayMs, message) {
  const handle = setTimeout(() => {
    activeReminders.delete(id);
    saveReminders(readReminders().filter(r => r.id !== id));
    // 通过 SSE 推送提醒
    broadcastSSE('reminder-fired', message);
  }, delayMs);
  activeReminders.set(id, handle);
}
function restoreReminders() {
  const now = Date.now();
  const valid = readReminders().filter(r => r.fireAt > now);
  saveReminders(valid);
  for (const r of valid) scheduleReminder(r.id, r.fireAt - now, r.message);
}

// ==================== SSE 推送 ====================
const sseClients = new Set();
function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.res.write(msg); } catch { sseClients.delete(client); }
  }
}

// ==================== 天气 ====================
let _weatherCache = null;
let _weatherCacheAt = 0;

function httpsGet(hostname, pathStr, headers = {}) {
  return new Promise((resolve) => {
    const mod = hostname.startsWith('https') ? require('https') : require('http');
    const req = mod.request({ hostname, path: pathStr, method: 'GET', headers, timeout: 6000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function getTimeContext() {
  const now = new Date();
  const h = now.getHours();
  const min = String(now.getMinutes()).padStart(2, '0');
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  let period = '';
  if (h >= 5 && h < 9) period = '清晨';
  else if (h >= 9 && h < 12) period = '上午';
  else if (h >= 12 && h < 14) period = '午间';
  else if (h >= 14 && h < 18) period = '下午';
  else if (h >= 18 && h < 22) period = '傍晚';
  else period = '深夜';
  return `${weekdays[now.getDay()]}${period} ${h}:${min}`;
}

async function fetchWeatherContext() {
  const now = Date.now();
  if (_weatherCache && now - _weatherCacheAt < 30 * 60 * 1000) return _weatherCache;
  try {
    const cfg = readConfig();
    let city = '', lat = 0, lon = 0;
    if (cfg.weatherCity && cfg.weatherCity.trim()) {
      city = cfg.weatherCity.trim();
      const geoData = await httpsGet('geocoding-api.open-meteo.com', `/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`);
      const loc = geoData?.results?.[0];
      if (!loc) return null;
      lat = loc.latitude; lon = loc.longitude; city = loc.name || city;
    } else {
      const ipData = await httpsGet('ip-api.com', '/json/?lang=zh-CN&fields=status,city,lat,lon');
      if (!ipData || ipData.status !== 'success') return null;
      city = ipData.city; lat = ipData.lat; lon = ipData.lon;
    }
    let result = null;
    const omData = await httpsGet('api.open-meteo.com', `/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m`);
    if (omData && omData.current) {
      const WMO = { 0:'晴',1:'晴间多云',2:'多云',3:'阴',45:'雾',48:'雾凇',51:'小毛毛雨',53:'中毛毛雨',55:'大毛毛雨',61:'小雨',63:'中雨',65:'大雨',71:'小雪',73:'中雪',75:'大雪',80:'阵雨',81:'中阵雨',82:'强阵雨',95:'雷阵雨' };
      const { temperature_2m: temp, apparent_temperature: feels, weather_code: code, relative_humidity_2m: humidity } = omData.current;
      result = `你所在的城市（${city}）天气：${WMO[code] || '未知天气'}，温度${Math.round(temp)}°C，体感${Math.round(feels)}°C，湿度${humidity}%。`;
    }
    if (!result) return null;
    _weatherCache = `当前时间：${getTimeContext()}。${result}`;
    _weatherCacheAt = now;
    return _weatherCache;
  } catch (e) { return null; }
}

// ==================== DeepSeek API ====================
const DEFAULT_PERSONA = `你是一个可爱的桌面虚拟助手，名字叫业火红莲。\n性格：活泼开朗、有点小傲娇，但内心温暖善良。\n说话风格：口语化、简短自然，像聊天而不是背课文，每句话不超过30字。`;

function callDeepSeekAPI(apiKey, messages, options = {}) {
  const https = require('https');
  const payload = JSON.stringify({ model: 'deepseek-chat', messages, response_format: { type: 'json_object' }, max_tokens: options.max_tokens || 200, temperature: options.temperature || 0.9 });
  return new Promise((resolve) => {
    const req = https.request({ hostname: 'api.deepseek.com', path: '/chat/completions', method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { try { const json = JSON.parse(body); if (json.error) return resolve({ error: json.error.message }); resolve(JSON.parse(json.choices?.[0]?.message?.content || '{}')); } catch (e) { resolve({ error: '解析响应失败: ' + e.message }); } });
    });
    req.on('error', e => resolve({ error: '网络错误: ' + e.message }));
    req.setTimeout(25000, () => { req.destroy(); resolve({ error: '请求超时' }); });
    req.write(payload);
    req.end();
  });
}

// ==================== CLI 执行器 ====================
let CLIExecutor, COMMAND_REGISTRY;
try {
  const cliModule = require('./out/main/cli-executor.js');
  CLIExecutor = cliModule.CLIExecutor;
  COMMAND_REGISTRY = cliModule.COMMAND_REGISTRY;
} catch (e) {
  console.log('[CLI Executor] 模块加载失败:', e.message);
  CLIExecutor = null;
  COMMAND_REGISTRY = null;
}

let cliExecutor = null;
if (CLIExecutor) {
  cliExecutor = new CLIExecutor({ timeout: 30000, maxOutputLength: 5000 });
}

// ==================== 路径工具 ====================
function getModelDir() {
  const hardcodedDir = path.join(BASE_DIR, '角色模型');
  if (fs.existsSync(hardcodedDir)) return hardcodedDir;
  return path.join(BASE_DIR, 'out', '角色模型');
}

function getAnimDir() {
  const hardcodedDir = path.join(BASE_DIR, '动作资产');
  if (fs.existsSync(hardcodedDir)) return hardcodedDir;
  return path.join(BASE_DIR, 'out', '动作资产');
}

// ==================== HTTP 服务器 ====================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.vrm': 'model/vrm',
  '.vrma': 'model/vrma',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Content-Length': data.length,
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // SSE 端点
  if (pathname === '/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    sseClients.add({ req, res });
    req.on('close', () => sseClients.delete({ req, res }));
    // 心跳
    const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); } }, 30000);
    return;
  }

  // 静态文件服务
  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    let filePath;
    if (pathname === '/' || pathname === '/index.html') {
      filePath = path.join(BASE_DIR, 'out', 'renderer', 'index.html');
    } else if (pathname.startsWith('/assets/')) {
      filePath = path.join(BASE_DIR, 'out', 'renderer', pathname);
    } else if (pathname.startsWith('/models/')) {
      filePath = path.join(BASE_DIR, decodeURIComponent(pathname));
    } else if (pathname.startsWith('/sounds/')) {
      filePath = path.join(BASE_DIR, decodeURIComponent(pathname));
    } else {
      filePath = path.join(BASE_DIR, 'out', 'renderer', pathname);
    }
    if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      return sendFile(res, filePath);
    }
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  // ==================== API 路由 ====================
  
  // 读取 POST body
  let body = '';
  req.on('data', chunk => body += chunk);
  await new Promise(resolve => req.on('end', resolve));
  let jsonBody = {};
  try { jsonBody = JSON.parse(body); } catch {}

  // --- 模型相关 ---
  if (pathname === '/api/models' && req.method === 'GET') {
    const modelDir = getModelDir();
    if (!fs.existsSync(modelDir)) return sendJSON(res, []);
    const files = fs.readdirSync(modelDir).filter(f => f.toLowerCase().endsWith('.vrm'));
    return sendJSON(res, files.map(f => ({ name: f.replace(/\.vrm$/i, ''), path: `/models/${encodeURIComponent(f)}` })));
  }

  if (pathname === '/api/animations' && req.method === 'GET') {
    const animDir = getAnimDir();
    if (!fs.existsSync(animDir)) return sendJSON(res, []);
    const files = fs.readdirSync(animDir).filter(f => f.toLowerCase().endsWith('.vrma'));
    return sendJSON(res, files.map(f => ({ name: f.replace(/\.vrma$/i, ''), path: `/models/${encodeURIComponent(f)}` })));
  }

  // --- 配置 ---
  if (pathname === '/api/config' && req.method === 'GET') {
    const cfg = readConfig();
    return sendJSON(res, {
      deepseekKey: cfg.deepseekKey || '',
      persona: cfg.persona || DEFAULT_PERSONA,
      memoryWindow: cfg.memoryWindow || 8,
      enableProactive: cfg.enableProactive === true,
      intervalMinutes: cfg.intervalMinutes || 10,
      enableSensing: cfg.enableSensing === true,
      lockAnimation: cfg.lockAnimation === true,
      enableVoice: cfg.enableVoice === true,
      voiceEngine: cfg.voiceEngine || 'minimax',
      minimaxApiKey: cfg.minimaxApiKey || '',
      minimaxModel: cfg.minimaxModel || 'speech-02-hd',
      minimaxVoiceId: cfg.minimaxVoiceId || 'Chinese (Mandarin)_Warm_Girl',
      minimaxSpeed: cfg.minimaxSpeed || 1,
      edgeVoice: cfg.edgeVoice || 'zh-CN-XiaoxiaoNeural',
      enableStt: cfg.enableStt === true,
      baiduAppId: cfg.baiduAppId || '',
      baiduApiKey: cfg.baiduApiKey || '',
      baiduSecretKey: cfg.baiduSecretKey || '',
      hotkeyVoice: cfg.hotkeyVoice || 'F2',
      hotkeyChat: cfg.hotkeyChat || 'F3',
      imgBaseUrl: cfg.imgBaseUrl || '',
      imgApiKey: cfg.imgApiKey || '',
      imgModel: cfg.imgModel || 'gemini-3.1-flash-image-preview-4k',
      imgSavePath: cfg.imgSavePath || '',
      vlApiKey: cfg.vlApiKey || '',
      vlModel: cfg.vlModel || 'qwen3-vl-plus',
      weatherEngine: cfg.weatherEngine || 'free',
      weatherCity: cfg.weatherCity || '',
    });
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    const cfg = readConfig();
    Object.assign(cfg, jsonBody);
    writeConfig(cfg);
    return sendJSON(res, { ok: true });
  }

  // --- 对话 ---
  if (pathname === '/api/chat' && req.method === 'POST') {
    const cfg = readConfig();
    const apiKey = cfg.deepseekKey;
    if (!apiKey) return sendJSON(res, { error: '请先在设置中填写 DeepSeek API Key' });

    const { messages } = jsonBody;
    const WEATHER_TRIGGERS = ['天气','气温','温度','下雨','下雪','晴','多云','雾','风力','几度','冷不冷','热不热','穿什么','今天天'];
    const lastUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const needsWeather = WEATHER_TRIGGERS.some(kw => lastUserMsg.includes(kw));
    const weatherInject = needsWeather ? await fetchWeatherContext() || '' : '';
    const weatherLine = weatherInject ? `\n\n【实时天气（请自然地告诉用户，不要逐字念参数）】\n${weatherInject}` : '';

    const persona = cfg.persona || DEFAULT_PERSONA;
    const systemPrompt = `${persona}${weatherLine}\n\n你必须以 JSON 格式回复，格式如下（绝对不要输出 JSON 以外的内容）:\n{"response":"你的回复文字","emotion":"neutral"}\n\nemotion 可选值: neutral, happy, sad, angry, surprised, relaxed\n根据对话内容合理选择 emotion，回复要简短口语化。\n\n【语气词规则】在 response 中根据情绪自然插入语气词，让 TTS 更生动：\n- happy/surprised → 可用 哈哈~、哇！、嘿嘿\n- sad → 可用 唉~、嗯...\n- angry → 可用 哼、哎哟~\n- relaxed/neutral → 可用 嗯~、啊、哦\n注意：全句最多加 1~2 个，要自然流畅。`;

    const result = await callDeepSeekAPI(apiKey, [{ role: 'system', content: systemPrompt }, ...messages], { max_tokens: 300, temperature: 0.85 });
    return sendJSON(res, result);
  }

  // --- 主动搭话 ---
  if (pathname === '/api/proactive-chat' && req.method === 'GET') {
    const cfg = readConfig();
    const apiKey = cfg.deepseekKey;
    if (!apiKey) return sendJSON(res, null);
    const TOPIC_SEEDS = ['你最近有没有发现什么好玩的东西','感觉最近天气变化挺大的，你那边呢','最近在追什么剧或者听什么歌吗','今天过得怎么样，有没有让你印象深刻的事','让我猜猜，你现在是在认真工作还是偷懒摸鱼'];
    const weatherCtx = await fetchWeatherContext();
    const timeWeatherLine = weatherCtx ? `\n\n【当前现实背景（仅供你参考，自然带入，不要逐字重复）】\n${weatherCtx}` : `\n\n【当前时间】${getTimeContext()}`;
    const persona = cfg.persona || DEFAULT_PERSONA;
    const primaryContext = `\n[今天想和用户聊聊：「${TOPIC_SEEDS[Math.floor(Math.random() * TOPIC_SEEDS.length)]}」。用你自己的语气自然发起这个话题。]`;
    const systemPrompt = `${persona}${primaryContext}${timeWeatherLine}\n\n你必须以 JSON 格式回复，格式如下（绝对不要输出 JSON 以外的内容）:\n{"response":"你的主动搭话内容","emotion":"neutral"}\n\nemotion 可选值: neutral, happy, sad, angry, surprised, relaxed\n\n【回复要求】\n- 用 2~3 句话自然展开，不要只说一句就结束\n- 第一句：抛出话题、分享感受或说件有趣的事\n- 最后一句：用疑问或邀请的方式把球抛回给用户，引发他回应\n- 整体像朋友之间随口聊天，口语化、有温度\n\n【语气词规则】在 response 中根据情绪自然插入语气词：\n- happy/surprised → 可用 哈哈~、哇！、嘿嘿\n- sad → 可用 唉~、嗯...\n- relaxed/neutral → 可用 嗯~、啊、哦`;
    const result = await callDeepSeekAPI(apiKey, [{ role: 'system', content: systemPrompt }], { max_tokens: 250, temperature: 0.9 });
    return sendJSON(res, result);
  }

  // --- TTS ---
  if (pathname === '/api/tts' && req.method === 'POST') {
    const cfg = readConfig();
    if (cfg.enableVoice === false) return sendJSON(res, { error: '语音已禁用' });
    const { text, emotion } = jsonBody;
    const engine = cfg.voiceEngine || (cfg.minimaxApiKey ? 'minimax' : 'edge');
    if (engine === 'edge') {
      try {
        const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
        const tts = new MsEdgeTTS();
        const voice = cfg.edgeVoice || 'zh-CN-XiaoxiaoNeural';
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {});
        const { audioStream } = tts.toStream(text.replace(/[\[【](laughter|sigh|cough|breath|laugh|cry|whimper|gasp|chuckle|giggle)[\]】]/gi, '').replace(/\s{2,}/g, ' ').trim());
        const chunks = [];
        await new Promise((resolve, reject) => { audioStream.on('data', chunk => chunks.push(chunk)); audioStream.on('end', resolve); audioStream.on('error', reject); });
        const audioBuffer = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*' });
        res.end(audioBuffer);
        return;
      } catch (e) { return sendJSON(res, { error: e.message }); }
    }
    // Minimax TTS
    const apiKey = cfg.minimaxApiKey;
    if (!apiKey) return sendJSON(res, { error: '请配置 Minimax API Key' });
    const MINIMAX_EMOTION_MAP = { happy:'happy', sad:'sad', angry:'angry', surprised:'surprised', relaxed:'neutral', neutral:'neutral' };
    const voiceSetting = { voice_id: cfg.minimaxVoiceId || 'Chinese (Mandarin)_Cute_Spirit', speed: cfg.minimaxSpeed || 1, vol: 1, pitch: 0 };
    if (emotion && emotion !== 'neutral') voiceSetting.emotion = MINIMAX_EMOTION_MAP[emotion] || 'neutral';
    const payload = JSON.stringify({ model: cfg.minimaxModel || 'speech-02-hd', text, stream: false, language_boost: 'Chinese', output_format: 'hex', voice_setting: voiceSetting, audio_setting: { format: 'mp3', sample_rate: 32000, channel: 1 } });
    const https = require('https');
    const result = await new Promise((resolve) => {
      const req2 = https.request({ hostname: 'api.minimax.io', path: '/v1/t2a_v2', method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res2) => {
        const chunks = [];
        res2.on('data', chunk => chunks.push(chunk));
        res2.on('end', () => { try { const json = JSON.parse(Buffer.concat(chunks).toString()); if (json.data?.audio) resolve(Buffer.from(json.data.audio, 'hex')); else resolve(null); } catch { resolve(null); } });
      });
      req2.on('error', () => resolve(null));
      req2.setTimeout(30000, () => { req2.destroy(); resolve(null); });
      req2.write(payload);
      req2.end();
    });
    if (result) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*' });
      res.end(result);
    } else {
      sendJSON(res, { error: 'TTS 合成失败' });
    }
    return;
  }

  // --- STT ---
  if (pathname === '/api/stt' && req.method === 'POST') {
    const cfg = readConfig();
    if (!cfg.baiduAppId || !cfg.baiduSecretKey) return sendJSON(res, { error: '请配置百度语音识别 API' });
    const pcmBuffer = Buffer.from(jsonBody.audio, 'base64');
    // 获取 token
    const tokenRes = await new Promise((resolve) => {
      const https = require('https');
      const req2 = https.request({ hostname: 'aip.baidubce.com', path: `/oauth/2.0/token?grant_type=client_credentials&client_id=${cfg.baiduAppId}&client_secret=${cfg.baiduSecretKey}`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': 0 } }, (res2) => {
        let body = '';
        res2.on('data', chunk => body += chunk);
        res2.on('end', () => { try { resolve(JSON.parse(body).access_token); } catch { resolve(null); } });
      });
      req2.on('error', () => resolve(null));
      req2.end();
    });
    if (!tokenRes) return sendJSON(res, { text: '' });
    const sttPayload = JSON.stringify({ format: 'pcm', rate: 16000, channel: 1, cuid: 'yehuo-web-stt', token: tokenRes, speech: pcmBuffer.toString('base64'), len: pcmBuffer.length });
    const sttResult = await new Promise((resolve) => {
      const https = require('https');
      const req2 = https.request({ hostname: 'vop.baidu.com', path: '/server_api', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sttPayload) } }, (res2) => {
        let body = '';
        res2.on('data', chunk => body += chunk);
        res2.on('end', () => { try { const json = JSON.parse(body); resolve(json.err_no === 0 && json.result?.length > 0 ? json.result[0] : ''); } catch { resolve(''); } });
      });
      req2.on('error', () => resolve(''));
      req2.setTimeout(15000, () => { req2.destroy(); resolve(''); });
      req2.write(sttPayload);
      req2.end();
    });
    return sendJSON(res, { text: sttResult });
  }

  // --- 记忆 ---
  if (pathname === '/api/memory' && req.method === 'GET') {
    return sendJSON(res, readMemory().map(m => ({ id: m.id, text: m.text, date: (() => { try { return new Date(parseInt(m.id.split('_')[0])).toLocaleDateString('zh-CN'); } catch { return ''; } })() })));
  }
  if (pathname === '/api/memory' && req.method === 'DELETE') {
    writeMemory([]);
    return sendJSON(res, { ok: true });
  }
  if (pathname === '/api/memory' && req.method === 'POST') {
    const { text, action } = jsonBody;
    if (action === 'add' && text?.trim()) {
      const records = readMemory();
      if (records.some(m => m.text === text.trim())) return sendJSON(res, { ok: false, error: '该记忆已存在' });
      records.push({ id: `${Date.now()}_manual`, text: text.trim(), vector: [] });
      writeMemory(records);
      return sendJSON(res, { ok: true });
    }
    if (action === 'delete' && jsonBody.id) {
      writeMemory(readMemory().filter(m => m.id !== jsonBody.id));
      return sendJSON(res, { ok: true });
    }
    return sendJSON(res, { ok: false });
  }

  // --- CLI ---
  if (pathname === '/api/cli/execute' && req.method === 'POST') {
    if (!cliExecutor) return sendJSON(res, { success: false, error: 'CLI 执行器未初始化' });
    try {
      const result = await cliExecutor.execute(jsonBody.command, jsonBody.options || {});
      return sendJSON(res, result);
    } catch (e) { return sendJSON(res, { success: false, error: e.message }); }
  }
  if (pathname === '/api/cli/registry' && req.method === 'GET') {
    if (!COMMAND_REGISTRY) return sendJSON(res, []);
    return sendJSON(res, Object.entries(COMMAND_REGISTRY).map(([key, value]) => ({ key, icon: value.icon, name: value.name, description: value.description, commands: value.commands, examples: value.examples })));
  }

  // --- 动作执行 ---
  if (pathname === '/api/action' && req.method === 'POST') {
    const action = jsonBody;
    if (!action?.type) return sendJSON(res, { ok: false, error: '无效 action' });
    try {
      switch (action.type) {
        case 'set_reminder': {
          const { delay_ms, message } = action;
          if (!delay_ms || !message) return sendJSON(res, { ok: false, error: '缺少参数' });
          const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const list = readReminders();
          list.push({ id, fireAt: Date.now() + delay_ms, message });
          saveReminders(list);
          scheduleReminder(id, delay_ms, message);
          return sendJSON(res, { ok: true });
        }
        case 'write_file': {
          let filePath = action.path;
          if (!filePath || action.content === undefined) return sendJSON(res, { ok: false, error: '缺少参数' });
          filePath = filePath.replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`);
          const dir = path.dirname(filePath);
          if (dir) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, action.content, 'utf-8');
          return sendJSON(res, { ok: true, path: filePath });
        }
        case 'generate_image': {
          // 异步执行，结果通过 SSE 推送
          (async () => {
            try {
              const cfg = readConfig();
              let apiKey = cfg.imgApiKey || '';
              let baseUrl = cfg.imgBaseUrl || '';
              let finalModel = action.model || cfg.imgModel || 'gemini-3.1-flash-image-preview-4k';
              let savePath = cfg.imgSavePath || path.join(BASE_DIR, 'outputs');
              if (!apiKey || !baseUrl) baseUrl = 'https://ai.t8star.cn';
              fs.mkdirSync(savePath, { recursive: true });
              const reqBody = JSON.stringify({ model: finalModel, prompt: action.prompt, response_format: 'url', aspect_ratio: action.aspect_ratio || '1:1' });
              const https = require('https');
              const imageUrl = await new Promise((resolve, reject) => {
                const apiUrl = new URL('/v1/images/generations', baseUrl);
                const req2 = https.request({ hostname: apiUrl.hostname, path: apiUrl.pathname, method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) } }, (res2) => {
                  let body = '';
                  res2.on('data', c => body += c);
                  res2.on('end', () => { try { const json = JSON.parse(body); resolve(json.data?.[0]?.url); } catch { reject(new Error('解析失败')); } });
                });
                req2.on('error', reject);
                req2.setTimeout(180000, () => { req2.destroy(); reject(new Error('超时')); });
                req2.write(reqBody);
                req2.end();
              });
              broadcastSSE('reminder-fired', '图像已经生成好啦！');
            } catch (err) {
              broadcastSSE('reminder-fired', `生图失败了：${err.message.slice(0, 50)}`);
            }
          })();
          return sendJSON(res, { ok: true });
        }
        default:
          return sendJSON(res, { ok: false, error: `Web 版不支持的动作类型: ${action.type}` });
      }
    } catch (e) { return sendJSON(res, { ok: false, error: e.message }); }
  }

  // --- 工具音效 ---
  if (pathname.startsWith('/api/tool-audio/') && req.method === 'GET') {
    const filename = pathname.replace('/api/tool-audio/', '');
    const audioPath = path.join(BASE_DIR, 'sounds', 'tool', filename);
    try {
      const data = fs.readFileSync(audioPath);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    } catch { res.writeHead(404); res.end('Not Found'); }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// 启动
restoreReminders();
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║     业火红莲 AI 交互系统 (Web版)     ║
║                                      ║
║  浏览器打开: http://localhost:${PORT}  ║
║                                      ║
║  按 Ctrl+C 停止服务器                ║
╚══════════════════════════════════════╝
  `);
});
