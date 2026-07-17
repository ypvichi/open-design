import { spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { platform, networkInterfaces } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * http-server-startup.ts
 *
 * 参考 daemon-startup.ts 的模式，用于启动 http-server 静态文件服务。
 * 典型用法：npx -y http-server <directory> -p 0
 *
 * 当 port 为 0 时，http-server 会自动分配一个随机端口，
 * 我们从 stdout 中解析实际的 URL。
 */

type StartedServer = {
  url: string;
  stop(): Promise<void>;
};

/** 启动 ws-server.mjs 子进程 */
function startWsServer(): ChildProcess {
  // 注意：编译后 __dirname 指向 dist/，所以到 bin/ 只需 ../
  const wsScriptPath = resolve(__dirname, '../bin/ws-server.mjs');
  console.log('[ws-server] starting...', wsScriptPath);
  const wsChild = spawn(process.execPath, [wsScriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true,
    cwd: process.cwd(),
  });

  wsChild.stdout?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) console.log(`[ws-server] ${text}`);
  });

  wsChild.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) console.error(`[ws-server] ${text}`);
  });

  wsChild.on('error', (error) => {
    console.error('[ws-server] spawn error:', error.message);
  });

  return wsChild;
}

/** 关闭 ws-server.mjs（通过 -command close） */
async function stopWsServer(): Promise<void> {
  // 注意：编译后 __dirname 指向 dist/，所以到 bin/ 只需 ../
  const wsScriptPath = resolve(__dirname, '../bin/ws-server.mjs');
  return new Promise((resolveClose) => {
    const closeChild = spawn(process.execPath, [wsScriptPath, '-command', 'close'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
      cwd: process.cwd(),
    });

    let stdout = '';
    closeChild.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    closeChild.on('close', () => {
      if (stdout.includes('graceful shutdown signal sent')) {
        // 等待 ws-server 进程退出
        setTimeout(() => resolveClose(), 500);
      } else {
        resolveClose();
      }
    });

    closeChild.on('error', () => resolveClose());

    // 兜底：5秒后强制 resolve
    setTimeout(() => resolveClose(), 5000);
  });
}

export type StartedHttpServerRuntime = StartedServer;

export type HttpServerCliStartupConfig = {
  host: string;
  port: number;
  directory: string;
};

export type HttpServerCliStartupParseResult =
  | { ok: true; config: HttpServerCliStartupConfig }
  | { ok: false; kind: 'help' }
  | { ok: false; kind: 'error'; message: string };

export const DEFAULT_HTTP_SERVER_PORT = 8080;
export const DEFAULT_HTTP_SERVER_BIND_HOST = '0.0.0.0';

/** 获取本机第一个非内部 IPv4 地址 */
export function getLocalIPv4Address(): string {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const entry of iface) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

function requiredOptionValue(flag: string, value: string | undefined, label: string): string | HttpServerCliStartupParseResult {
  if (value == null || value.startsWith('-')) {
    return { ok: false, kind: 'error', message: `${flag} requires ${label}` };
  }
  return value;
}

export function parseHttpServerCliStartupArgs(argv: string[]): HttpServerCliStartupParseResult {
  let port = DEFAULT_HTTP_SERVER_PORT;
  let host = DEFAULT_HTTP_SERVER_BIND_HOST;
  let directory = '.';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a == null) continue;
    if (a === '-p' || a === '--port') {
      const next = requiredOptionValue(a, argv[++i], 'a port');
      if (typeof next !== 'string') return next;
      const parsedPort = Number(next);
      if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
        return { ok: false, kind: 'error', message: `invalid port: ${next}` };
      }
      port = parsedPort;
    } else if (a === '--host') {
      const next = requiredOptionValue(a, argv[++i], 'an address');
      if (typeof next !== 'string') return next;
      host = next;
    } else if (a === '-d' || a === '--directory') {
      const next = requiredOptionValue(a, argv[++i], 'a directory');
      if (typeof next !== 'string') return next;
      directory = next;
    } else if (a === '-h' || a === '--help') {
      return { ok: false, kind: 'help' };
    } else if (a.startsWith('-')) {
      return { ok: false, kind: 'error', message: `unknown option: ${a}` };
    } else {
      directory = a;
    }
  }

  return { ok: true, config: { host, port, directory } };
}

/** 获取指定进程的所有直接子进程 PID */
function getChildPids(parentPid: number): number[] {
  if (platform() === 'win32') {
    try {
      const output = execSync(
        `wmic process where (ParentProcessId=${parentPid}) get ProcessId`,
        { encoding: 'utf-8' }
      );
      return output
        .split('\n')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && n !== 0);
    } catch {
      return [];
    }
  }

  try {
    const output = execSync(`ps -o pid= --ppid ${parentPid}`, { encoding: 'utf-8' });
    return output
      .trim()
      .split('\n')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
  } catch {
    return [];
  }
}

/** 递归收集进程树中所有后代 PID */
function collectProcessTree(pid: number): Set<number> {
  const all = new Set<number>();
  const collect = (p: number) => {
    for (const child of getChildPids(p)) {
      if (!all.has(child)) {
        all.add(child);
        collect(child);
      }
    }
  };
  collect(pid);
  return all;
}

/** 强制终止整个进程树 */
function killProcessTree(pid: number): void {
  if (platform() === 'win32') {
    try {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
    } catch {
      // ignore
    }
    return;
  }

  // Unix: 先杀子进程，再杀父进程
  const toKill = collectProcessTree(pid);
  toKill.add(pid);

  for (const p of toKill) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

/** 优雅地停止 http-server 子进程 */
export async function stopHttpServer(child: ChildProcess, wsChild?: ChildProcess, { closeTimeoutMs = 5_000 } = {}): Promise<void> {
  if (child.killed || child.exitCode !== null) {
    return;
  }

  return new Promise<void>((resolveClose, rejectClose) => {
    let resolved = false;

    const resolveOnce = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(hardTimer);
      resolveClose();
    };

    const rejectOnce = (error: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(hardTimer);
      rejectClose(error);
    };

    const hardTimer = setTimeout(() => {
      if (child.pid != null) {
        killProcessTree(child.pid);
      }
      resolveOnce();
    }, closeTimeoutMs);

    if (hardTimer.unref) {
      hardTimer.unref();
    }

    child.on('close', () => resolveOnce());
    child.on('error', (error) => rejectOnce(error));

    // 先尝试优雅关闭，超时后 killProcessTree 兜底
    child.kill('SIGTERM');
  }).finally(async () => {
    // 同时关闭 ws-server
    if (wsChild) {
      try {
        await stopWsServer();
      } catch {
        // ignore
      }
    }
  });
}

/**
 * 从 http-server 的 stdout 中解析 URL。
 * http-server 的典型输出格式：
 *   Available on:
 *     http://127.0.0.1:8080
 */
function parseHttpServerUrl(stdout: string): string | null {
  // 匹配 "Available on:" 后面的 URL
  const match = stdout.match(/Available on:[\s\S]*?(https?:\/\/[^\s]+)/);
  if (match?.[1]) {
    return match[1];
  }
  // 备选：直接匹配任何 http:// 或 https:// URL
  const fallbackMatch = stdout.match(/(https?:\/\/[^\s]+)/);
  if (fallbackMatch?.[1]) {
    return fallbackMatch[1];
  }
  return null;
}

/** 根据配置构建预期的 URL */
function buildExpectedUrl(host: string, port: number | string): string {
  return `http://${host}:${port}`;
}

/** 查找占用指定端口的进程 PID（返回第一个匹配的 PID，找不到返回 null） */
function findProcessByPort(port: number): number | null {
  if (platform() === 'win32') {
    try {
      const output = execSync(
        `netstat -ano | findstr :${port}`,
        { encoding: 'utf-8', shell: 'cmd.exe' }
      );
      // 典型行:  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       12345
      for (const line of output.split('\n')) {
        const parts = line.trim().split(/\s+/);
        const last = parts[parts.length - 1];
        if (last == null) continue;
        const pid = parseInt(last, 10);
        if (!isNaN(pid) && pid > 0) {
          return pid;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  // Unix (Linux/macOS)
  try {
    // lsof -t 只输出 PID
    const output = execSync(`lsof -t -i :${port}`, { encoding: 'utf-8' });
    const firstLine = output.trim().split('\n')[0];
    if (firstLine == null) return null;
    const pid = parseInt(firstLine, 10);
    if (!isNaN(pid) && pid > 0) {
      return pid;
    }
  } catch {
    // ignore
  }

  return null;
}

/** 终止占用指定端口的进程 */
function killProcessByPort(port: number): void {
  const pid = findProcessByPort(port);
  if (pid == null) {
    return;
  }

  console.log(`[http-server] port ${port} is occupied by PID ${pid}, terminating...`);

  if (platform() === 'win32') {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    } catch {
      // ignore
    }
    return;
  }

  // Unix: 先尝试优雅终止，再强制终止
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

/**
 * 启动 http-server 静态文件服务，同时启动 ws-server.mjs WebSocket 服务。
 * 子进程使用 detached: false 绑定到父进程，确保父进程退出时子进程也被清理。
 */
export async function startHttpServerRuntime(options: { host: string; port: number; directory: string }): Promise<StartedHttpServerRuntime> {
  const { host, port, directory } = options;
  const absoluteDir = resolve(directory);

  // 启动前：若端口非 0，先尝试清理占用该端口的进程
  if (port !== 0) {
    killProcessByPort(port);
    // 短暂等待，确保端口释放
    await new Promise(r => setTimeout(r, 300));
  }

  // 构建 http-server 参数
  const args = ['-y', 'http-server', absoluteDir, '-p', String(port), '-a', host];

  // 在 Windows 上使用 npx.cmd，其他平台用 npx
  const isWindows = platform() === 'win32';
  const command = isWindows ? 'npx.cmd' : 'npx';

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,        // 绑定到父进程，随父进程退出
      shell: isWindows,       // Windows 上需要 shell 来执行 .cmd 文件
      windowsHide: true,     // Windows 下隐藏控制台窗口
      cwd: process.cwd(),
    });

    // 同时启动 ws-server
    const wsChild = startWsServer();

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let urlResolved = false;

    const resolveOnce = (url: string) => {
      if (resolved) return;
      resolved = true;
      urlResolved = true;
      resolve({
        url,
        stop: () => stopHttpServer(child, wsChild),
      });
    };

    const rejectOnce = (error: Error) => {
      if (resolved) return;
      resolved = true;
      reject(error);
    };

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;

      if (!urlResolved) {
        const url = parseHttpServerUrl(stdout);
        if (url) {
          resolveOnce(url);
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      rejectOnce(new Error(`Failed to start http-server: ${error.message}`));
    });

    child.on('close', (code) => {
      if (!resolved) {
        rejectOnce(new Error(`http-server exited with code ${code}: ${stderr || stdout}`));
      }
    });

    // Fallback: 如果 5 秒内没有从 stdout 解析到 URL，使用预期 URL
    const fallbackTimer = setTimeout(() => {
      if (!resolved) {
        const expectedUrl = port === 0 ? buildExpectedUrl(host, '<random>') : buildExpectedUrl(host, port);
        resolveOnce(expectedUrl);
      }
    }, 5_000);

    if (fallbackTimer.unref) {
      fallbackTimer.unref();
    }
  });
}

/** 设置进程信号处理，确保父进程退出时子进程也被清理 */
function setupShutdownHandlers(runtime: StartedHttpServerRuntime): void {
  let shuttingDown = false;

  const stop = () => {
    if (shuttingDown) {
      process.exit(0);
    }
    shuttingDown = true;
    void runtime.stop().finally(() => process.exit(0));
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Windows 上没有 SIGINT/SIGTERM，监听 beforeExit 作为兜底
  process.on('beforeExit', () => {
    if (!shuttingDown) {
      stop();
    }
  });

  // 处理未捕获的异常，确保子进程被清理
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    stop();
  });
}
