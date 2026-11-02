/**
 * 会议日程 · 同步服务守护进程（watchdog）
 *
 * 职责：把 server.mjs 拉起来，一旦它退出就立刻重启，永不放弃。
 * 为什么需要它：server.mjs 直接跑在会话里，会话结束就被回收；
 *              而且单个异常崩溃后没人负责拉起来。
 *
 * 被谁启动：run-daemon.cmd → 由 Windows 计划任务「MeetingSyncBridge」托管
 *            （登录时启动 + 每分钟检查一次 + 失败自动重启）
 *
 * 退出条件只有三个：
 *   1. logs/.stopped 标记存在（用户主动点了「停止同步服务」）
 *   2. 端口上已有一个健康实例（退出码 78，说明不需要我）
 *   3. 收到 SIGTERM / SIGINT（用户主动停止）
 *
 * 日志：logs/bridge.log（超过 2MB 自动滚动到 bridge.1.log）
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(APP_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bridge.log');
const PID_FILE = path.join(LOG_DIR, 'daemon.pid');
const STOP_FLAG = path.join(LOG_DIR, '.stopped');
const SERVER = path.join(__dirname, 'server.mjs');
const PORT = Number(process.env.KDOCS_BRIDGE_PORT || 7788);
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** 同一次进程内最多连续重启次数（超过后放慢到 1 分钟一次，仍然会重试） */
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000, 60000];

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= MAX_LOG_BYTES) return;
    const old = path.join(LOG_DIR, 'bridge.1.log');
    try { fs.unlinkSync(old); } catch { /* 不存在就算了 */ }
    try { fs.renameSync(LOG_FILE, old); } catch { /* 被占用就跳过，下次再滚 */ }
  } catch { /* 文件还不存在 */ }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch { /* ignore */ }
}

function writePid() {
  try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch { /* ignore */ }
}

function clearPid() {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

/* ---------------- 启动前检查 ---------------- */

ensureDir(LOG_DIR);

if (fs.existsSync(STOP_FLAG)) {
  log('检测到停止标记 logs/.stopped，守护进程不启动。');
  log('要恢复：双击「恢复自启动.bat」，或删除 logs/.stopped 后重启计划任务。');
  process.exit(0);
}

/* ---------------- 子进程管理 ---------------- */

let child = null;
let stopping = false;
let restartIndex = 0;
let startedAt = 0;
let outStream = null;
let standbyTimer = null;
const STANDBY_PROBE_MS = 10_000;   // 待机模式下的探活间隔
const STANDBY_MAX_FAILS = 3;       // 连续 3 次探不到才认为对方真的死了

/** 探一次端口上是不是我们的服务在跑 */
function pingOnce() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 2500 },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { buf += d; });
        res.on('end', () => {
          try {
            const j = JSON.parse(buf);
            finish(!!(j && j.ok === true && j.app === 'meeting-sync-bridge'));
          } catch { finish(false); }
        });
      }
    );
    req.on('error', () => finish(false));
    req.on('timeout', () => { req.destroy(); finish(false); });
  });
}

/**
 * 待机监控：端口上已有别人（或自己上一轮的孤儿进程）在服务。
 * 不要一走了之——它一挂我就接管，这样「守护链」永远不会断。
 * 场景：daemon 被杀、但 server 还活着 → 新 daemon 靠这个模式接上。
 */
function enterStandby() {
  if (standbyTimer || stopping) return;
  let fails = 0;
  log(`进入待机监控（每 ${STANDBY_PROBE_MS / 1000}s 探一次，对方挂了我立刻接管）`);
  standbyTimer = setInterval(async () => {
    if (stopping) return;
    const alive = await pingOnce();
    if (alive) { fails = 0; return; }
    fails++;
    log(`待机监控：第 ${fails} 次探不到服务`);
    if (fails >= STANDBY_MAX_FAILS) {
      log('待机监控：确认端口已空，接管并启动自己的服务。');
      clearInterval(standbyTimer);
      standbyTimer = null;
      startServer();
    }
  }, STANDBY_PROBE_MS);
}

function startServer() {
  if (stopping) return;
  rotateIfNeeded();

  startedAt = Date.now();
  try {
    outStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  } catch {
    outStream = null;
  }

  log(`--- 拉起同步服务（pid 由系统分配，端口 ${PORT}）---`);

  child = spawn(process.execPath, [SERVER], {
    cwd: APP_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      KDOCS_NO_OPEN: '1',   // 守护模式下不弹浏览器
      KDOCS_DAEMON: '1',    // 告诉 server：出问题时用退出码 78 沟通
    },
  });

  log(`子进程已启动 pid=${child.pid}`);

  if (outStream) {
    child.stdout.pipe(outStream, { end: false });
    child.stderr.pipe(outStream, { end: false });
  }

  child.on('error', (e) => {
    log(`子进程启动失败：${e && e.message}`);
  });

  child.on('exit', (code, signal) => {
    if (outStream) { try { outStream.end(); } catch { /* ignore */ } outStream = null; }
    const lived = Date.now() - startedAt;
    log(`子进程退出 code=${code} signal=${signal} 存活=${Math.round(lived / 1000)}s`);

    if (stopping) {
      log('守护进程收到停止指令，不再重启。');
      clearPid();
      process.exit(0);
    }

    // 78 = 端口上已有健康实例。不退出，转入待机监控，它一挂就接管。
    if (code === 78) {
      enterStandby();
      return;
    }

    // 活得够久说明是正常运行后崩的，重置退避
    if (lived > 60_000) restartIndex = 0;

    const delay = RESTART_BACKOFF_MS[Math.min(restartIndex, RESTART_BACKOFF_MS.length - 1)];
    restartIndex++;
    log(`${delay}ms 后重启（连续第 ${restartIndex} 次）`);
    setTimeout(startServer, delay);
  });
}

/* ---------------- 自身健壮性 ---------------- */

process.on('uncaughtException', (e) => {
  log(`守护进程未捕获异常（继续运行）：${(e && e.stack) || e}`);
});

process.on('unhandledRejection', (e) => {
  log(`守护进程未处理拒绝（继续运行）：${(e && e.stack) || e}`);
});

function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${sig}，正在停止子进程…`);
  if (standbyTimer) { clearInterval(standbyTimer); standbyTimer = null; }
  if (child && !child.killed) {
    try { child.kill(); } catch { /* ignore */ }
  }
  setTimeout(() => {
    clearPid();
    process.exit(0);
  }, 1200).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ---------------- 开工 ---------------- */

writePid();
log(`========== 守护进程启动 pid=${process.pid} node=${process.version} ==========`);
startServer();
