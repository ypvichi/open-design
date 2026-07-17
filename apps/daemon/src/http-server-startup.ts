import { execSync } from 'node:child_process';
import { networkInterfaces, platform } from 'node:os';
import { resolve, extname, join } from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

/**
 * http-server-startup.ts
 *
 * 内联实现静态文件 HTTP 服务，不依赖外部 http-server 包。
 * 同时内联实现 WebSocket 服务（默认端口 9528），使用 ws 包。
 */

// ==================== WebSocket 服务 ====================

const WS_DEFAULT_PORT = 9528;
const HEARTBEAT_INTERVAL_MS = 30000;

function formatRemoteIp(addr: string | undefined): string {
  if (!addr) return 'unknown';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

function logListen(port: number) {
  console.log(`[ws-server] listening on ws://0.0.0.0:${port}`);
}

function broadcastHeartbeat(wss: WebSocketServer) {
  const payload = JSON.stringify({ type: 'heartbeat', t: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function bindHandlers(wss: WebSocketServer) {
  wss.on('connection', (ws, req) => {
    const ip = formatRemoteIp(req.socket.remoteAddress);
    console.log(`[ws-server] client connected: ${ip} (total: ${wss.clients.size})`);

    ws.on('message', (data, isBinary) => {
      const payload = isBinary ? data : data.toString();
      for (const client of wss.clients) {
        if (client.readyState === 1) {
          client.send(payload, { binary: isBinary });
        }
      }
    });

    ws.on('close', () => {
      console.log(`[ws-server] client disconnected: ${ip} (total: ${wss.clients.size})`);
    });
  });
}

class InlineWsServer {
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private port: number;

  constructor(port: number = WS_DEFAULT_PORT) {
    this.port = port;
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.port, host: '0.0.0.0' });
    bindHandlers(this.wss);
    this.wss.on('listening', () => {
      logListen(this.port);
      if (HEARTBEAT_INTERVAL_MS > 0) {
        broadcastHeartbeat(this.wss!);
        this.heartbeatTimer = setInterval(() => broadcastHeartbeat(this.wss!), HEARTBEAT_INTERVAL_MS);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// ==================== HTTP 静态文件服务 ====================

type StartedServer = {
  url: string;
  stop(): Promise<void>;
};

// MIME 类型映射
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.webp': 'image/webp',
};

/** 根据文件扩展名获取 MIME 类型 */
function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/** 安全地解析请求路径，防止目录遍历 */
function safeResolvePath(rootDir: string, urlPath: string): string {
  const decoded = decodeURIComponent(urlPath);
  const normalized = decoded.replace(/^\/+/, '').replace(/\\/g, '/');
  const safe = join(rootDir, normalized);

  const resolvedRoot = resolve(rootDir);
  const resolvedSafe = resolve(safe);

  if (!resolvedSafe.startsWith(resolvedRoot)) {
    return join(rootDir, 'index.html');
  }

  return safe;
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

/** 创建静态文件 HTTP 服务器 */
function createStaticFileServer(rootDir: string): http.Server {
  return http.createServer((req, res) => {
    const urlPath = req.url || '/';

    let filePath: string;
    try {
      filePath = safeResolvePath(rootDir, urlPath);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found：'+filePath);
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Internal Server Error');
        }
        return;
      }

      if (stats.isDirectory()) {
        // 目录：尝试返回 index.html
        const indexPath = join(filePath, 'index.html');
        fs.readFile(indexPath, (err, data) => {
          if (err) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><head><title>Index</title></head><body><h1>Index of ${urlPath}</h1></body></html>`);
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
          }
        });
      } else {
        // 文件：流式读取并返回
        const mimeType = getMimeType(filePath);
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Length': stats.size.toString(),
        });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        });
      }
    });
  });
}

/** 优雅地停止 http-server */
export async function stopHttpServer(server: http.Server, wsServer?: InlineWsServer, { closeTimeoutMs = 5_000 } = {}): Promise<void> {
  return new Promise<void>((resolveClose) => {
    const timer = setTimeout(() => {
      resolveClose();
    }, closeTimeoutMs);

    server.close(() => {
      clearTimeout(timer);
      resolveClose();
    });
  }).finally(async () => {
    if (wsServer) {
      try {
        await wsServer.stop();
      } catch {
        // ignore
      }
    }
  });
}

/**
 * 启动内联 HTTP 静态文件服务，同时启动内联 WebSocket 服务（默认端口 9528）。
 * 启动前会先清理占用目标端口的进程。
 */
export async function startHttpServerRuntime(options: { host: string; port: number; directory: string }): Promise<StartedHttpServerRuntime> {
  const { host, port, directory } = options;
  const absoluteDir = resolve(directory);

  // 启动前：先尝试清理占用该端口的进程
  if (port !== 0) {
    killProcessByPort(port);
    // 短暂等待，确保端口释放
    await new Promise(r => setTimeout(r, 300));
  }

  const server = createStaticFileServer(absoluteDir);

  // 启动内联 WebSocket 服务器
  const wsServer = new InlineWsServer();
  wsServer.start();

  return new Promise((resolve, reject) => {
    let resolved = false;

    const httpServer = server.listen(port, host, () => {
      if (resolved) return;

      const address = httpServer.address();
      const actualPort = typeof address === 'string' ? port : (address?.port ?? port);
      const url = `http://${host === '0.0.0.0' ? getLocalIPv4Address() : host}:${actualPort}`;

      console.log(`[http-server] serving ${absoluteDir} at ${url}`);

      resolved = true;
      resolve({
        url,
        stop: () => stopHttpServer(server, wsServer),
      });
    });

    httpServer.on('error', (error) => {
      if (resolved) return;
      resolved = true;
      reject(new Error(`Failed to start http-server: ${error.message}`));
    });

    // Fallback: 如果 5 秒内没有启动成功，使用预期 URL
    setTimeout(() => {
      if (!resolved) {
        const fallbackUrl = `http://${host === '0.0.0.0' ? getLocalIPv4Address() : host}:${port}`;
        resolved = true;
        resolve({
          url: fallbackUrl,
          stop: () => stopHttpServer(server, wsServer),
        });
      }
    }, 5_000);
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
