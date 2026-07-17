/**
 * 本地 WebSocket 回显服务：连接后收到的文本会广播给所有已连接客户端。
 *
 * 端口：环境变量 PORT，默认 9528。协议为明文 ws://。
 * 心跳：按 HEARTBEAT_INTERVAL_MS（默认 30000）向全员广播 JSON：`{"type":"heartbeat","t":<毫秒时间戳>}`；设为 0 关闭。
 * 启动时会列出本机非回环的局域网 IPv4，便于按 `ws://<IPv4>:<PORT>` 连接；客户端日志中的 IPv4 会去掉 ::ffff: 前缀。
 *
 * CLI：
 * - 无参数：仅启动服务。
 * - 必传一段字符串（可多词拼接）：若本机 WS 已在 `WS_SEND_HOST`:`PORT` 监听则直接发消息并退出；
 *   若未监听则后台拉起本脚本（无参实例），待端口就绪后再发消息并退出。
 * - `-html` / `-html` 后接路径，或 `-html=<路径>`：读取 UTF-8 HTML 文件内容后发送。
 * - 首参以 `@` 开头时视为 UTF-8 文件路径（可跟多段拼成含空格的路径），读取文件内容后发送（用于超长 HTML）。
 * - `-command close` / `-command=close`（不区分大小写）：先向本机 `WS_SEND_HOST`:`PORT` 上已在监听的 WS 服务发送关闭指令；服务端收到后断开所有客户端并退出。若端口无监听则直接退出并提示；若优雅关服失败但端口仍被占用，则尝试按端口结束监听进程（本机 dev 场景）。
 */
import { readFileSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const scriptPath = fileURLToPath(import.meta.url);
const port = Number(process.env.PORT) || 9528;
const heartbeatMs = Number(process.env.HEARTBEAT_INTERVAL_MS ?? "30000");
const sendHost = (process.env.WS_SEND_HOST || "127.0.0.1").trim() || "127.0.0.1";
const connectTimeoutMs = Number(process.env.WS_SEND_TIMEOUT_MS) || 8000;
const waitServerMs = Number(process.env.WS_SPAWN_WAIT_MS) || 20000;

/** 与 sendMessageOnce 配合：服务端识别后优雅退出（不向其它客户端广播该帧）。 */
const CONTROL_CLOSE_PAYLOAD = JSON.stringify({ type: "control", command: "close" });

/** 本机非回环的局域网 IPv4（与 AGENTS 预览约定一致，便于拼连接串）。 */
function getLanIPv4s() {
  const out = [];
  const seen = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    if (!list) continue;
    for (const net of list) {
      const v4 = net.family === "IPv4" || net.family === 4;
      if (v4 && !net.internal && net.address) {
        if (!seen.has(net.address)) {
          seen.add(net.address);
          out.push(net.address);
        }
      }
    }
  }
  return out;
}

function formatRemoteIp(addr) {
  if (!addr) return addr;
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

function logListen(port) {
  console.log(`WebSocket listening on ws://0.0.0.0:${port}`);
  const ips = getLanIPv4s();
  if (ips.length) {
    for (const ip of ips) {
      console.log(`  connect: ws://${ip}:${port}`);
    }
  } else {
    console.log("  (no LAN IPv4 found; use your host IPv4 manually)");
  }
}

function broadcastHeartbeat(wss) {
  const payload = JSON.stringify({ type: "heartbeat", t: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

/**
 * 若为关闭控制帧则处理并返回 true（已触发关服，不再广播）。
 * @param {string} text
 * @param {import("ws").WebSocketServer} wss
 */
function tryHandleControlClose(text, wss) {
  try {
    const o = JSON.parse(text);
    if (o && o.type === 'initText') {
      if (currentText) {
        for (const client of wss.clients) {
          try {
            client.send(currentText);
            currentText = '';
          } catch {
            /* ignore */
            currentText = '';
          }
        }
      }
      return true;
    }
    if (o && o.type === "control" && o.command === "close") {
      console.log("control: close — shutting down server");
      for (const client of wss.clients) {
        try {
          client.close();
        } catch {
          /* ignore */
        }
      }
      wss.close(() => process.exit(0));
      return true;
    }
  } catch {
    /* not JSON control */
  }
  return false;
}

function bindHandlers(wss) {
  wss.on("connection", (ws, req) => {
    const ip = formatRemoteIp(req.socket.remoteAddress);
    console.log(`[+] client ${ip} (total ${wss.clients.size})`);

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString();
        if (tryHandleControlClose(text, wss)) return;
      }
      const payload = isBinary ? data : data.toString();
      for (const client of wss.clients) {
        if (client.readyState === 1) {
          client.send(payload, { binary: isBinary });
        }
      }
    });

    ws.on("close", () => {
      console.log(`[-] client ${ip} (total ${wss.clients.size})`);
    });
  });
}
/** 连接 → 发文本 → 正常关闭；成功 resolve，失败 reject。 */
function sendMessageOnce(text) {
  const url = `ws://${sendHost}:${port}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let openedOk = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error(`connect/send timeout (${connectTimeoutMs}ms)`));
    }, connectTimeoutMs);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    ws.on("open", () => {
      openedOk = true;
      try {
        ws.send(text);
        ws.close();
      } catch (e) {
        finish(reject, e);
      }
    });

    ws.on("close", () => {
      if (openedOk) finish(resolve);
      else if (!settled) finish(reject, new Error("closed before open"));
    });

    ws.on("error", (err) => {
      finish(reject, err);
    });
  });
}

function waitForTcpListen(host, tcpPort, totalMs) {
  const deadline = Date.now() + totalMs;
  return new Promise((resolve, reject) => {
    function tryOnce() {
      const s = net.createConnection({ host, port: tcpPort }, () => {
        s.end();
        resolve();
      });
      s.on("error", () => {
        s.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`port ${tcpPort} not ready within ${totalMs}ms`));
        } else {
          setTimeout(tryOnce, 120);
        }
      });
    }
    tryOnce();
  });
}

function spawnServerDetached() {
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();
}

/** 本机 TCP 端口是否可被连接（有进程在监听）。 */
function isTcpPortReachable(host, tcpPort, ms = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: tcpPort }, () => {
      socket.end();
      resolve(true);
    });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    socket.on("error", () => finish(false));
    socket.setTimeout(ms, () => finish(false));
  });
}

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", ...opts }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** 从 `netstat -ano` 风格输出中解析在 `tcpPort` 上 LISTENING 的 PID（Windows）。按「本地地址」列末段端口匹配，避免 `:80` 误匹配 `:8080`。 */
function parseNetstatListeningPids(netstatOut, tcpPort) {
  const pids = new Set();
  for (const line of netstatOut.split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1];
    const portMatch = local?.match(/:(\d+)$/);
    if (!portMatch || Number(portMatch[1]) !== tcpPort) continue;
    const pid = Number(parts[parts.length - 1]);
    if (Number.isFinite(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * 结束占用 `tcpPort` 的监听进程（优雅关服失败时的兜底）。
 * @returns {Promise<number>} 实际尝试结束的进程数
 */
async function killListenersOnPort(tcpPort) {
  const myPid = process.pid;
  if (process.platform === "win32") {
    let out = "";
    try {
      ({ stdout: out } = await execFileP("netstat", ["-ano"]));
    } catch {
      return 0;
    }
    const pids = parseNetstatListeningPids(out, tcpPort).filter((p) => p !== myPid);
    let killed = 0;
    for (const pid of pids) {
      try {
        await execFileP("taskkill", ["/PID", String(pid), "/F", "/T"]);
        killed += 1;
      } catch {
        /* ignore */
      }
    }
    return killed;
  }
  try {
    const { stdout } = await execFileP("lsof", [
      "-nP",
      `-iTCP:${tcpPort}`,
      "-sTCP:LISTEN",
      "-t",
    ]);
    const pids = stdout
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== myPid);
    let killed = 0;
    for (const pid of [...new Set(pids)]) {
      try {
        process.kill(pid, "SIGTERM");
        killed += 1;
      } catch {
        try {
          process.kill(pid, "SIGKILL");
          killed += 1;
        } catch {
          /* ignore */
        }
      }
    }
    return killed;
  } catch {
    return 0;
  }
}

/** 是否为用户请求的 `-command close`（支持 `-command=close`、大小写）。 */
function isCloseCommandArgv(argv) {
  if (argv.length < 1) return false;
  const a0 = argv[0];
  if (a0 === "-command" || a0 === "--command") {
    return argv.length >= 2 && String(argv[1]).toLowerCase() === "close";
  }
  const m = String(a0).match(/^--?command=(.+)$/i);
  return m && String(m[1]).toLowerCase() === "close";
}

async function runCloseCommand() {
  const reachable = await isTcpPortReachable(sendHost, port);
  if (!reachable) {
    console.error(
      `close: nothing listening on ${sendHost}:${port} (set PORT / WS_SEND_HOST if needed).`,
    );
    process.exit(1);
  }

  try {
    await sendMessageOnce(CONTROL_CLOSE_PAYLOAD);
    console.log("close: graceful shutdown signal sent (server should exit).");
    process.exit(0);
  } catch (e) {
    const msg = e?.message || String(e);
    console.warn("close: WebSocket shutdown failed:", msg);
    console.warn("close: attempting to kill process(es) listening on port", port, "…");
    const n = await killListenersOnPort(port);
    if (n > 0) {
      console.log(`close: stopped ${n} listener process(es) on port ${port}.`);
      process.exit(0);
    }
    console.error("close: could not stop the server (no listener PID found or kill failed).");
    process.exit(1);
  }
}

var currentText = "";
async function ensureServerAndSend(text) {
  try {
    currentText = '';
    await sendMessageOnce(text);
    console.log("sent.normal");
    process.exit(0);
  } catch {
    console.error("WS not listening; starting background server…");
    currentText = text;
    startServer();
    //spawnServerDetached();
    // try {
    //   await waitForTcpListen(sendHost, port, waitServerMs);
    // } catch (e) {
    //   console.error(e.message);
    //   process.exit(1);
    // }
    // try {
    //   await sendMessageOnce(text);
    //   console.log("sent.catch");
    //   process.exit(0);
    // } catch (e) {
    //   console.error("send failed after start:", e?.message || e);
    //   process.exit(1);
    // }
  }
}

export function startServer() {
  const wss = new WebSocketServer({ port, host: "0.0.0.0" });
  bindHandlers(wss);
  wss.on("listening", () => {
    logListen(port);
    // if (heartbeatMs > 0) {
    //   console.log(
    //     `  heartbeat: broadcast every ${heartbeatMs}ms (HEARTBEAT_INTERVAL_MS=0 to disable)`,
    //   );
    //   broadcastHeartbeat(wss);
    //   setInterval(() => broadcastHeartbeat(wss), heartbeatMs);
    // }
  });
}

function argvToSendPayload(argvSlice) {
  if (argvSlice.length === 0) return "";
  if (argvSlice[0] === "-html" || argvSlice[0] === "-html2") {
    const rawPath = argvSlice.slice(1).join(" ");
    if (!rawPath) {
      throw new Error("missing html path after -html or -html2");
    }
    const filePath = rawPath;
    let text = readFileSync(filePath, "utf8");
    if (argvSlice[0] === "-html2") {
      text = text.replace('<head>', `<head><script>window.__mcp__use__sub__pages=true</script>`)
    }
    return text;
  }
  return argvSlice.join(" ");
}

export function stopServer() {
  runCloseCommand().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

const cliArgs = process.argv.slice(2);
if (isCloseCommandArgv(cliArgs)) {
  stopServer();
} else if (cliArgs.length > 0) {
  if (cliArgs[0] === '-link-cover') {
    ensureServerAndSend('cover');
  } else if (cliArgs[0] === '-link-dsl') {
    ensureServerAndSend('dsl');
  } else if (cliArgs[0] === '-link-cover-dsl') {
    ensureServerAndSend('cover-dsl');
  } else {
    const text = argvToSendPayload(cliArgs);
    ensureServerAndSend(text).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
} else {
  startServer();
}
