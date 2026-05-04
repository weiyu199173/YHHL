/**
 * 业火红莲 Web 版 - Electron Bridge 模拟层
 * 在浏览器中模拟 window.electron API，使前端打包代码无需修改即可运行
 * 
 * 原理：将所有 electron IPC 调用转换为 HTTP 请求到本地 Node.js 服务器
 */

(function () {
  'use strict';

  const API_BASE = window.location.origin;

  // SSE 连接（用于主进程推送事件）
  let sseSource = null;
  const eventListeners = new Map();

  function connectSSE() {
    try {
      sseSource = new EventSource(API_BASE + '/sse');
      sseSource.addEventListener('reminder-fired', (e) => {
        const msg = e.data ? JSON.parse(e.data) : e.data;
        (eventListeners.get('reminder-fired') || []).forEach(cb => cb(msg));
      });
      sseSource.onerror = () => {
        sseSource.close();
        setTimeout(connectSSE, 5000);
      };
    } catch (e) {
      console.warn('[Bridge] SSE 连接失败:', e.message);
    }
  }
  connectSSE();

  // 通用 HTTP 请求
  async function apiGet(path) {
    const res = await fetch(API_BASE + path);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // TTS 返回音频二进制
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('audio')) {
      const buffer = await res.arrayBuffer();
      return Buffer.from(buffer);
    }
    return res.json();
  }

  // 模拟 window.electron
  window.electron = {
    // ========== 模型相关 ==========
    getVRMPath: () => apiGet('/api/models').then(models => models[0]?.path || ''),
    getModels: () => apiGet('/api/models'),
    loadVRM: async (filePath) => {
      // 直接通过 URL 加载 VRM 文件
      const res = await fetch(filePath);
      const buffer = await res.arrayBuffer();
      return new Uint8Array(buffer);
    },
    getAnimations: () => apiGet('/api/animations'),
    loadAnimation: async (filePath) => {
      const res = await fetch(filePath);
      const buffer = await res.arrayBuffer();
      return new Uint8Array(buffer);
    },

    // ========== 窗口管理（Web 版空操作） ==========
    dragStart: () => {},
    dragMove: () => {},
    dragEnd: () => {},
    closeWindow: () => { console.log('[Bridge] closeWindow - Web 版不支持'); },
    resizeWindow: () => {},
    setIgnoreMouse: () => {},
    setWindowBounds: () => {},
    openSettingsWindow: () => {
      // Web 版：打开设置面板（用简单 alert 替代）
      alert('Web 版暂不支持独立设置窗口。\n请直接编辑配置文件：~/.yehuo-config.json');
    },

    // ========== 配置 ==========
    getApiKey: () => apiGet('/api/config').then(c => c.deepseekKey || ''),
    setApiKey: (key) => apiPost('/api/config', { deepseekKey: key }),
    getConfig: () => apiGet('/api/config'),
    saveConfig: (patch) => apiPost('/api/config', patch),

    // ========== 对话 ==========
    chat: (messages, visionImage) => apiPost('/api/chat', { messages, visionImage }),
    proactiveChat: () => apiGet('/api/proactive-chat'),

    // ========== 记忆 ==========
    summarizeMemory: async (evictedMessages) => {
      // Web 版简化：不做向量化，直接存储
      console.log('[Bridge] summarizeMemory - Web 版简化处理');
      return;
    },
    getMemoryList: () => apiGet('/api/memory'),
    clearMemory: () => { return fetch(API_BASE + '/api/memory', { method: 'DELETE' }).then(r => r.json()); },
    addMemory: (text) => apiPost('/api/memory', { text, action: 'add' }),
    deleteMemory: (id) => apiPost('/api/memory', { id, action: 'delete' }),

    // ========== TTS ==========
    ttsSynthesize: async (text, emotion) => {
      const result = await apiPost('/api/tts', { text, emotion });
      if (result instanceof Buffer || result instanceof Uint8Array) return result;
      if (result?.error) { console.error('[Bridge] TTS 失败:', result.error); return null; }
      return null;
    },

    // ========== STT ==========
    sttTranscribe: async (audioBuffer) => {
      const base64 = typeof audioBuffer === 'string' ? audioBuffer : btoa(String.fromCharCode(...new Uint8Array(audioBuffer)));
      return apiPost('/api/stt', { audio: base64 }).then(r => r.text || '');
    },

    // ========== 事件监听 ==========
    onToggleStt: (cb) => {
      console.log('[Bridge] onToggleStt - Web 版请使用页面内按钮');
    },
    onOpenChat: (cb) => {
      console.log('[Bridge] onOpenChat - Web 版请使用页面内按钮');
    },
    onReminderFired: (cb) => {
      if (!eventListeners.has('reminder-fired')) eventListeners.set('reminder-fired', []);
      eventListeners.get('reminder-fired').push(cb);
    },
    onResetIdleTimer: () => {},
    onFocusEnd: (cb) => {
      if (!eventListeners.has('focus-end')) eventListeners.set('focus-end', []);
      eventListeners.get('focus-end').push(cb);
    },

    // ========== 鼠标追踪（Web 版用页面内鼠标） ==========
    onGlobalCursor: (cb) => {
      document.addEventListener('mousemove', (e) => {
        cb({ x: e.clientX, y: e.clientY, width: window.innerWidth, height: window.innerHeight });
      });
    },

    // ========== 其他 ==========
    openUrl: (url) => { window.open(url, '_blank'); },
    executeAction: (action) => apiPost('/api/action', action),
    saveCompressedInputs: async (buffers) => {
      console.log('[Bridge] saveCompressedInputs - Web 版暂不支持');
      return { ok: false };
    },
    takeScreenshot: async () => {
      console.log('[Bridge] takeScreenshot - Web 版暂不支持');
      return null;
    },
    pickFolder: async () => {
      console.log('[Bridge] pickFolder - Web 版暂不支持');
      return null;
    },
    pickFile: async () => {
      console.log('[Bridge] pickFile - Web 版暂不支持');
      return null;
    },
    loadToolAudio: async (filename) => {
      try {
        const res = await fetch(API_BASE + '/api/tool-audio/' + encodeURIComponent(filename));
        if (!res.ok) return null;
        const buffer = await res.arrayBuffer();
        return new Uint8Array(buffer);
      } catch { return null; }
    },

    // ========== CLI ==========
    executeCLI: (command, options) => apiPost('/api/cli/execute', { command, options }),
    getCLIRegistry: () => apiGet('/api/cli/registry'),
    getCLISystemPrompt: () => apiGet('/api/cli/registry').then(registry => {
      if (!registry || registry.length === 0) return 'CLI 功能未启用';
      let prompt = '\n## CLI 工具箱（业火红莲已装备）\n\n';
      for (const cmd of registry) {
        prompt += `### ${cmd.icon || '🔧'} ${cmd.name}\n**用途：** ${cmd.description}\n**可用命令：** ${cmd.commands?.join(', ')}\n**示例：**\n`;
        for (const ex of (cmd.examples || [])) prompt += `  \`${ex}\`\n`;
        prompt += '\n';
      }
      return prompt;
    }),
  };

  console.log('[Bridge] ✅ 业火红莲 Web Bridge 已加载');
  console.log('[Bridge] 所有 electron IPC 调用已重定向到 HTTP API');
})();
