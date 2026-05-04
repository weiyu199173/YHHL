/**
 * 业火红莲 CLI 执行器
 * CLI Executor for Yehuo Honglian AI System
 * 
 * 功能：安全地执行 CLI 命令，让 AI 能够操作各种应用程序
 */

const { spawn } = require('child_process');
const path = require('path');

// ==================== 命令注册表 ====================

const COMMAND_REGISTRY = {
  // Git 版本控制
  git: {
    icon: '🔀',
    name: 'Git',
    description: '代码版本控制系统',
    color: '#f05032',
    commands: [
      'status', 'add', 'commit', 'push', 'pull', 'fetch', 'branch',
      'checkout', 'merge', 'rebase', 'log', 'diff', 'stash', 'clone',
      'init', 'remote', 'config', 'show', 'blame', 'tag'
    ],
    examples: [
      'git status',
      'git add . && git commit -m "message"',
      'git push origin main',
      'git pull',
      'git log --oneline -10'
    ]
  },

  // npm 包管理
  npm: {
    icon: '📦',
    name: 'NPM',
    description: 'Node.js 包管理器',
    color: '#cb3837',
    commands: [
      'install', 'uninstall', 'update', 'init', 'run', 'test', 'start',
      'stop', 'restart', 'build', 'dev', 'audit', ' outdated', 'ls', 'info'
    ],
    examples: [
      'npm install package-name',
      'npm run dev',
      'npm test',
      'npm audit',
      'npm outdated'
    ]
  },

  // Docker 容器
  docker: {
    icon: '🐳',
    name: 'Docker',
    description: '容器化应用平台',
    color: '#2496ed',
    commands: [
      'ps', 'images', 'run', 'stop', 'rm', 'start', 'restart', 'logs',
      'exec', 'build', 'pull', 'push', 'inspect', 'stats', 'network', 'volume'
    ],
    examples: [
      'docker ps -a',
      'docker images',
      'docker stop $(docker ps -q)',
      'docker logs -f container_name',
      'docker exec -it container_name /bin/bash'
    ]
  },

  // Homebrew
  brew: {
    icon: '🍺',
    name: 'Homebrew',
    description: 'macOS 包管理器',
    color: '#000000',
    commands: [
      'install', ' uninstall', 'update', 'upgrade', 'search', 'info',
      'list', 'doctor', 'cleanup', 'outdated', 'pin', 'unpin'
    ],
    examples: [
      'brew install package-name',
      'brew update && brew upgrade',
      'brew search keyword',
      'brew cleanup',
      'brew doctor'
    ]
  },

  // macOS open 命令
  open: {
    icon: '🚀',
    name: 'Open',
    description: '启动 macOS 应用程序和文件',
    color: '#007aff',
    commands: [
      '-a', '-e', '-f', '-t', '-u', '-g'
    ],
    examples: [
      'open -a "Safari"',
      'open -a "Visual Studio Code"',
      'open -a "Trae Solo"',
      'open /path/to/file',
      'open https://github.com'
    ]
  },

  // 系统命令
  system: {
    icon: '⚙️',
    name: 'System',
    description: 'macOS 系统操作',
    color: '#8e8e93',
    commands: [
      'say', 'pmset', 'caffeinate', 'networksetup', 'scutil', 'defaults',
      'diskutil', 'killall', 'launchctl'
    ],
    examples: [
      'say "Hello, world!"',
      'pmset displaysleepnow',
      'caffeinate -u -t 3600',
      'killall -9 Safari'
    ]
  },

  // Finder 文件操作
  finder: {
    icon: '📁',
    name: 'Finder',
    description: '文件系统和 Finder 操作',
    color: '#5ac8fa',
    commands: [
      'mkdir', 'ls', 'cd', 'pwd', 'cp', 'mv', 'rm', 'cat', 'touch',
      'chmod', 'chown', 'find', 'grep', 'head', 'tail', 'wc'
    ],
    examples: [
      'mkdir -p new_folder',
      'ls -la',
      'cp file.txt backup.txt',
      'rm -rf folder_name',
      'find . -name "*.js"'
    ]
  },

  // Python pip
  pip: {
    icon: '🐍',
    name: 'Pip',
    description: 'Python 包安装器',
    color: '#3776ab',
    commands: [
      'install', ' uninstall', 'list', 'show', 'freeze', 'search',
      'install -r requirements.txt', 'upgrade', 'download'
    ],
    examples: [
      'pip install package-name',
      'pip install -r requirements.txt',
      'pip list',
      'pip freeze > requirements.txt',
      'pip uninstall package-name'
    ]
  },

  // GitHub CLI
  gh: {
    icon: '🐙',
    name: 'GitHub CLI',
    description: 'GitHub 命令行工具',
    color: '#24292e',
    commands: [
      'repo', 'issue', 'pr', 'gist', 'secret', 'ssh-key', 'alias',
      'auth', 'completion', 'extension'
    ],
    examples: [
      'gh repo list',
      'gh issue list',
      'gh pr create',
      'gh repo clone owner/repo'
    ]
  },

  // curl 网络请求
  curl: {
    icon: '🌐',
    name: 'Curl',
    description: '网络请求工具',
    color: '#073545',
    commands: [
      '-X', '-H', '-d', '-s', '-o', '-O', '-L', '-I', '-u', '-k'
    ],
    examples: [
      'curl https://api.github.com',
      'curl -X POST -d "data" url',
      'curl -H "Authorization: token" url',
      'curl -s https://api.example.com | jq'
    ]
  },

  // macOSascript
  osascript: {
    icon: '🍎',
    name: 'AppleScript',
    description: 'macOS 自动化脚本',
    color: '#a2aaad',
    commands: ['-e', '-l', '-s'],
    examples: [
      'osascript -e \'tell application "Finder" to activate\'',
      'osascript -e \'display dialog "Hello"\'',
      'osascript script.scpt'
    ]
  }
};

// ==================== 危险命令黑名单 ====================

const DANGEROUS_COMMANDS = [
  {
    pattern: /rm\s+-rf\s+\//,
    name: '删除根目录',
    severity: 'critical',
    message: '这个命令会删除整个系统！绝对禁止执行！'
  },
  {
    pattern: /dd\s+/,
    name: '磁盘直接写入',
    severity: 'critical',
    message: 'dd 命令会直接写入磁盘，可能导致数据丢失！'
  },
  {
    pattern: /mkfs\./,
    name: '格式化磁盘',
    severity: 'critical',
    message: '格式化命令会清空整个磁盘！'
  },
  {
    pattern: /:\(\)\{:\|:&\};:/,
    name: 'Fork 炸弹',
    severity: 'critical',
    message: 'Fork 炸弹会耗尽系统资源！'
  },
  {
    pattern: /chmod\s+-R\s+777\s+\/(?!Applications|U\/)/,
    name: '危险权限修改',
    severity: 'high',
    message: '将系统根目录设为 777 权限非常危险！'
  },
  {
    pattern: /curl\s+.*\|\s*sh/,
    name: '管道执行脚本',
    severity: 'medium',
    message: '直接从网络下载并执行脚本存在安全风险，建议先下载检查内容。'
  }
];

// ==================== CLI 执行器类 ====================

class CLIExecutor {
  constructor(options = {}) {
    this.timeout = options.timeout || 30000;
    this.maxOutputLength = options.maxOutputLength || 5000;
    this.workingDir = options.workingDir || process.cwd();
    this.commandHistory = [];
    this.onOutput = options.onOutput || null;
  }

  async execute(command, options = {}) {
    const startTime = Date.now();
    const validation = this.validateCommand(command);
    if (!validation.valid) {
      return { success: false, error: validation.error, command: command, duration: 0 };
    }

    const parsed = this.parseCommand(command);
    if (!parsed) {
      return { success: false, error: '无法解析命令', command: command, duration: 0 };
    }

    return new Promise((resolve) => {
      let output = '';
      let errorOutput = '';
      let killed = false;

      const child = spawn(parsed.command, parsed.args, {
        cwd: options.cwd || this.workingDir,
        env: { ...process.env, ...options.env },
        shell: true,
        windowsHide: true
      });

      const timeoutId = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 2000);
      }, options.timeout || this.timeout);

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        if (output.length > this.maxOutputLength) {
          output = output.substring(0, this.maxOutputLength) + '\n... (输出截断)';
          child.kill();
        }
        if (this.onOutput && typeof this.onOutput === 'function') {
          this.onOutput(chunk);
        }
      });

      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;
        const success = code === 0 && !killed;

        const result = {
          success: success,
          code: code,
          output: output.trim(),
          error: errorOutput.trim(),
          command: command,
          duration: duration,
          killed: killed
        };

        this.commandHistory.push({
          command: command,
          success: success,
          duration: duration,
          timestamp: new Date().toISOString()
        });

        resolve(result);
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          error: err.message,
          command: command,
          duration: Date.now() - startTime
        });
      });
    });
  }

  validateCommand(command) {
    if (!command || typeof command !== 'string') {
      return { valid: false, error: '命令不能为空' };
    }

    for (const dangerous of DANGEROUS_COMMANDS) {
      if (dangerous.pattern.test(command)) {
        return { valid: false, error: dangerous.message, severity: dangerous.severity };
      }
    }

    if (command.length > 2000) {
      return { valid: false, error: '命令过长，可能存在安全风险' };
    }

    return { valid: true };
  }

  parseCommand(command) {
    try {
      const parts = [];
      let current = '';
      let inQuote = false;
      let quoteChar = '';

      for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if ((char === '"' || char === "'") && !inQuote) {
          inQuote = true;
          quoteChar = char;
        } else if (char === quoteChar && inQuote) {
          inQuote = false;
          quoteChar = '';
        } else if (char === ' ' && !inQuote) {
          if (current) {
            parts.push(current);
            current = '';
          }
        } else {
          current += char;
        }
      }

      if (current) parts.push(current);
      if (parts.length === 0) return null;

      return { command: parts[0], args: parts.slice(1) };
    } catch (err) {
      console.error('[CLI Executor] 解析命令失败:', err);
      return null;
    }
  }

  getRegistry(category = null) {
    if (category && COMMAND_REGISTRY[category]) {
      return COMMAND_REGISTRY[category];
    }
    return COMMAND_REGISTRY;
  }

  getHistory(limit = 50) {
    return this.commandHistory.slice(-limit);
  }

  clearHistory() {
    this.commandHistory = [];
  }

  formatResult(result) {
    if (result.success) {
      let text = '✅ 命令执行成功';
      if (result.output) text += `：\n${result.output}`;
      text += `\n⏱️ 耗时：${result.duration}ms`;
      return text;
    } else {
      let text = '❌ 命令执行失败';
      if (result.error) text += `：${result.error}`;
      if (result.output) text += `\n输出：${result.output}`;
      text += `\n⏱️ 耗时：${result.duration}ms`;
      return text;
    }
  }
}

module.exports = { CLIExecutor, COMMAND_REGISTRY, DANGEROUS_COMMANDS };
