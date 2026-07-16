import { spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { resolve } from 'node:path';

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
export async function stopHttpServer(child: ChildProcess, { closeTimeoutMs = 5_000 } = {}): Promise<void> {
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

/**
 * 启动 http-server 静态文件服务。
 * 子进程使用 detached: false 绑定到父进程，确保父进程退出时子进程也被清理。
 */
export async function startHttpServerRuntime(options: { host: string; port: number; directory: string }): Promise<StartedHttpServerRuntime> {
  const { host, port, directory } = options;
  const absoluteDir = resolve(directory);

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
        stop: () => stopHttpServer(child),
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

export async function runHttpServerCliStartup(argv: string[], options: { printHelp?: () => void } = {}): Promise<void> {
  const parsed = parseHttpServerCliStartupArgs(argv);
  if (!parsed.ok) {
    if (parsed.kind === 'error') {
      console.error(parsed.message);
      options.printHelp?.();
      process.exit(2);
    }
    options.printHelp?.();
    return;
  }
  const { host, port, directory } = parsed.config;

  const runtime = await startHttpServerRuntime({
    host,
    port,
    directory,
  });

  console.log(`[http-server] serving ${directory} at ${runtime.url}`);

  setupShutdownHandlers(runtime);
}
