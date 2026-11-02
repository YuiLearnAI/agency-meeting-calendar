/**
 * 会议日程 · 本地同步桥接服务
 *
 * 作用：把网页和金山文档直接连起来——网页上点一下就把会议写进云文档，也能把云文档读回日历。
 * 为什么不直接在网页里连：浏览器不允许网页持有云端凭证，必须有个本机小程序代跑。
 *
 * 启动：双击上一级目录的「启动同步服务.bat」，会自动打开 http://127.0.0.1:7788/
 * 依赖：Node 18+，零第三方包。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Kdocs, KdocsError } from './kdocs.mjs';
import { canParseLocally, parseLocalFile, isImageExt, unsupportedHint } from './extract_local.mjs';
import { createEngine } from './sheet-engine.mjs';
import { createAppState } from './app-state.mjs';
import { createFolderWatch } from './folder-watch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.KDOCS_BRIDGE_PORT || 7788);
// 局域网共享：监听所有网卡。本机访问 127.0.0.1:7788，局域网其它电脑访问 <本机IP>:7788。
// 外部互联网仍不可达（受单位路由器/防火墙 NAT 隔离），与「暴露公网」是两回事。
const HOST = '0.0.0.0';

/* ---------- 访问口令（局域网共享的安全门） ---------- */
// 口令存 bridge/.access-key.txt，纯文本，改它即改口令（改完重启服务生效）。
// 若文件不存在或为空，则本次不启用口令（等价纯本机模式，仅局域网共享时才需要）。
const KEY_FILE = path.join(__dirname, '.access-key.txt');
let ACCESS_KEY = '';
try { ACCESS_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { /* 无口令文件 */ }
const ACCESS_ON = ACCESS_KEY.length > 0;
// 已发放的会话 token。
// 以前只放内存，服务一重启（改代码、开机自启、点「重启服务」）全部作废，
// 浏览器 cash 里的 cookie 还在却对不上 → 页面弹回口令页，看着像「服务挂了」。
// 现在落盘到 bridge/.sessions.json（带过期时间，默认 30 天），重启后照样认。
const SESSION_FILE = path.join(__dirname, '.sessions.json');
const SESSION_TTL = 30 * 864e5;
const SESSIONS = new Map();   // token -> 过期时间戳
(function loadSessions() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const now = Date.now();
    Object.keys(j || {}).forEach((t) => {
      const exp = Number(j[t]) || 0;
      if (exp > now) SESSIONS.set(t, exp);
    });
  } catch { /* 首次运行或文件损坏，从空开始 */ }
})();
function saveSessions() {
  try {
    const now = Date.now();
    const o = {};
    for (const [t, exp] of SESSIONS) { if (exp > now) o[t] = exp; else SESSIONS.delete(t); }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(o, null, 0), 'utf8');
  } catch { /* 落盘失败不影响本次会话 */ }
}
function newSession() {
  const t = crypto.randomBytes(24).toString('hex');
  SESSIONS.set(t, Date.now() + SESSION_TTL);
  saveSessions();
  return t;
}
function cookieGet(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function hasAccess(req) {
  if (!ACCESS_ON) return true;                       // 未启用口令，直接放行
  const t = cookieGet(req, 'meeting_access');
  if (!t) return false;
  const exp = SESSIONS.get(t);
  if (!exp) return false;
  if (exp <= Date.now()) { SESSIONS.delete(t); return false; }
  return true;
}

const SHEET = {
  fileId: 'nK7paBFZD1Mw9b9GPHrrBxqVyiwKXpFSr',
  url: 'https://www.kdocs.cn/l/ctI49zhGV2pd',
  name: '会议安排.xlsx',
};

const kd = new Kdocs(process.env.KDOCS_AUTH_FILE || path.join(__dirname, '.auth.json'));
const engine = createEngine({
  kd,
  sheet: SHEET,
  snapshotPath: process.env.KDOCS_SNAPSHOT_FILE || path.join(APP_ROOT, 'doc-snapshot.js'),
});
// 跨设备共用的应用状态（冲突裁决 / 外出培训），存在云文档另开的「应用状态」表里
const appState = createAppState({
  kd,
  sheet: SHEET,
  idCachePath: path.join(__dirname, '.state-sheet.json'),
});

// 版本与能力清单：网页会核对 features，缺哪个就提示「服务是旧版本，请重启」，
// 而不是让用户在看不懂的「未知接口」里打转。
const BUILD_VERSION = '1.5.0';
const FEATURES = ['snapshot', 'push', 'remove', 'report', 'extract', 'watch', 'state'];

/* ============================ 静态文件 ============================ */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const target = path.resolve(APP_ROOT, '.' + rel);
  if (!target.startsWith(APP_ROOT) || /[\\/]bridge[\\/]\.auth\.json$/.test(target)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

/* ============================ HTTP ============================ */

function json(res, code, obj, req) {
  const body = JSON.stringify(obj);
  // CORS：文件上传（/api/extract）用 credentials:'include' 带 cookie，必须反射 Origin 且带 Credentials，
  // 否则跨域（如从 64504 预览端口调 7788）会被浏览器拦截。
  const origin = req && req.headers && req.headers.origin;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  };
  res.writeHead(code, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// 读取原始二进制请求体（用于文件上传），上限 20MB
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) { req.destroy(); reject(new Error('文件过大（>20MB）')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 定位 Python 可执行文件（同步）。
// 关键：守护进程由 Windows 计划任务启动，其 PATH 不含 WorkBuddy 自带 Python，
// 但解析库（docx/pypdf/rapidocr）都装在 WorkBuddy Python 里，裸 'python' 会找到没库的解释器。
// 因此按优先级同步探测：环境变量 PYTHON → WorkBuddy 常见绝对路径（判断文件存在）→ python / python3。
function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push(process.env.PYTHON);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    // 显式版本
    const verDir = path.join(home, '.workbuddy', 'binaries', 'python', 'versions');
    const tryVer = (v) => {
      const p = path.join(verDir, v, 'python.exe');
      try { if (fs.existsSync(p)) candidates.push(p); } catch { /* ignore */ }
    };
    tryVer('3.13.12');
    tryVer('3.13.14');
    // 通过 current 符号链接的 .version 得知真实版本
    try {
      const cur = fs.readFileSync(path.join(verDir, 'current', '.version'), 'utf8').trim();
      if (cur) tryVer(cur);
    } catch { /* ignore */ }
  }
  candidates.push('python', 'python3');
  // 返回第一个「绝对路径存在」或「命令名」；绝对路径不存在则跳过
  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    } else {
      return c; // 命令名，交给 spawn 尝试（找不到会走 error 事件）
    }
  }
  return 'python';
}

// 本地文件文本提取：docx / pdf 由 Node 自己解析（零依赖，不受 Python 环境变动影响），
// 只有图片才交给 Python 做离线 OCR。全程本机完成，不联网。
function extractFileText(buf, filename) {
  return new Promise((resolve) => {
    // ① Node 原生：docx / pdf / doc
    if (canParseLocally(filename)) {
      return parseLocalFile(buf, filename).then((text) => {
        if (text && text.trim()) return resolve({ ok: true, text });
        resolve({ ok: false, error: 'EXTRACT_FAIL', message: (filename || '文件') + ' 里没有可用文字' });
      }).catch((e) => resolve({ ok: false, error: 'EXTRACT_FAIL', message: e.message }));
    }
    // ② 图片：落临时文件，交给 Python（OCR）
    if (!isImageExt(filename)) {
      // 非图片、又不是 docx/pdf/doc 的格式（wps / ofd / rtf / xls / ppt …）直接给中文提示，绝不丢给 OCR
      return resolve({ ok: false, error: 'UNSUPPORTED', message: unsupportedHint(filename) });
    }
    const ext = (path.extname(filename || '') || '.bin').toLowerCase();
    const tmpDir = path.join(APP_ROOT, '.tmp', 'uploads');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    const tmp = path.join(tmpDir, Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ext);
    const py = findPython();
    fs.writeFile(tmp, buf, (werr) => {
      if (werr) return resolve({ ok: false, error: 'WRITE_FAIL', message: werr.message });
      const script = path.join(__dirname, 'extract_file.py');
      const child = spawn(py, [script, tmp], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 120000);
      child.on('close', (code) => {
        clearTimeout(timer);
        try { fs.unlink(tmp, () => {}); } catch {}
        if (code === 0 && out.trim()) {
          resolve({ ok: true, text: out });
        } else {
          resolve({ ok: false, error: 'EXTRACT_FAIL', code, message: pythonErrorHint(err || out, ext) });
        }
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        try { fs.unlink(tmp, () => {}); } catch {}
        resolve({ ok: false, error: 'PYTHON_MISSING', message: '无法调用本地解析器（python）：' + e.message });
      });
    });
  });
}

// 把 Python 的原始报错翻译成用户能看懂、并且知道下一步做什么的一句话。
// 注意：现在只有图片会走到 Python（OCR），docx / pdf 一律由 Node 本地解析。
function pythonErrorHint(raw, ext) {
  const msg = String(raw || '').trim();
  if (/No module named '?(rapidocr|onnx)/i.test(msg) || /\.(png|jpe?g|bmp|webp|gif)$/i.test(ext || '')) {
    return '本机缺少离线 OCR 组件（rapidocr），图片暂时无法识别。可以改用截图后直接粘贴，或把通知存成 .docx / .pdf 再拖进来';
  }
  return (msg || '未提取到内容').slice(0, 500);
}

// 监听文件夹里「已经在磁盘上的文件」：直接读盘解析，不必先落临时文件。
// docx / pdf 走 Node 原生，图片才走 Python OCR。仍是本机解析，不联网。
function extractPathText(filePath, displayName) {
  return new Promise((resolve) => {
    const ext = path.extname(filePath || '').toLowerCase();
    if (canParseLocally(filePath)) {
      fs.readFile(filePath, (rerr, buf) => {
        if (rerr) {
          return resolve({ ok: false, error: 'READ_FAIL', message: '读不到文件：' + rerr.message });
        }
        parseLocalFile(buf, filePath).then((text) => {
          if (text && text.trim()) return resolve({ ok: true, text });
          resolve({ ok: false, error: 'EXTRACT_FAIL', message: (displayName || '文件') + ' 里没有可用文字' });
        }).catch((e) => resolve({ ok: false, error: 'EXTRACT_FAIL', message: e.message }));
      });
      return;
    }
    if (!isImageExt(filePath)) {
      // 非图片、又不是 docx/pdf/doc 的格式（wps / ofd / rtf / xls / ppt …）直接给中文提示，绝不丢给 OCR
      return resolve({ ok: false, error: 'UNSUPPORTED', message: unsupportedHint(filePath) });
    }
    const py = findPython();
    const script = path.join(__dirname, 'extract_file.py');
    const child = spawn(py, [script, filePath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 120000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) {
        resolve({ ok: true, text: out });
      } else {
        resolve({ ok: false, error: 'EXTRACT_FAIL', code, message: pythonErrorHint(err || out, ext) });
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'PYTHON_MISSING', message: '无法调用本地解析器（python）：' + e.message });
    });
  });
}

// 会议通知文件夹监听：盯着指定文件夹，发现新通知就排队，等网页右下角弹提醒问用户要不要导入。
const watcher = createFolderWatch({
  dataDir: __dirname,
  extractPathText,
  log: (m) => console.log('[watch] ' + m),
});

async function handleApi(req, res, url) {
  const p = url.pathname;
  // 局部 json：自动带上 req，让响应正确回填 CORS Origin（支持跨端口调用，如预览面板 64504 → 7788）
  const json2 = (res, code, obj) => json(res, code, obj, req);

  // 口令验证接口：任何人可调，校验 ACCESS_KEY，通过后种 cookie
  if (p === '/api/auth') {
    const body = await readBody(req);
    const key = String(body.key || '');
    if (!ACCESS_ON) return json2(res, 200, { ok: true, needAuth: false });
    if (key === ACCESS_KEY) {
      const token = newSession();
      const ck = `meeting_access=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
      res.setHeader('Set-Cookie', ck);
      return json2(res, 200, { ok: true, needAuth: true });
    }
    return json2(res, 401, { ok: false, error: 'BAD_KEY', needAuth: true });
  }

  if (p === '/api/ping') {
    return json2(res, 200, {
      ok: true, app: 'meeting-sync-bridge', version: BUILD_VERSION, features: FEATURES,
      authed: kd.authed(), tokenExpiresAt: kd.expiresLabel(),
      doc: SHEET, loginState: kd.pending ? kd.pending.state : 'idle',
      needAuth: ACCESS_ON,
    });
  }

  // 除 auth / ping 外，其余接口都要求已通过口令
  if (!hasAccess(req)) {
    return json2(res, 401, { ok: false, error: 'NO_ACCESS', needAuth: ACCESS_ON });
  }

  // 本地文件文本提取：body 为原始二进制（docx/pdf/图片），filename 由 query 或 header 提供
  if (p === '/api/extract') {
    const q = url.searchParams.get('name') || req.headers['x-filename'] || 'upload.bin';
    try {
      const buf = await readRawBody(req);
      const out = await extractFileText(buf, q);
      return json2(res, out.ok ? 200 : 422, out);
    } catch (e) {
      return json2(res, 400, { ok: false, error: 'BAD_BODY', message: e.message });
    }
  }

  if (p === '/api/login/start') {
    const r = kd.startLogin();
    return json2(res, 200, { ok: true, url: r.url });
  }

  if (p === '/api/login/status') {
    const st = await kd.pollLogin();
    return json2(res, 200, { ok: true, state: st, authed: kd.authed(), tokenExpiresAt: kd.expiresLabel() });
  }

  if (p === '/api/logout') {
    kd.token = ''; kd.expiresAt = 0; kd.sessionId = ''; kd.pending = null; kd._save();
    return json2(res, 200, { ok: true });
  }

  if (p === '/api/snapshot') {
    const out = await engine.pull();
    return json2(res, 200, { ok: true, ...out });
  }

  // 重启自己：只退出，由守护进程用磁盘上的新代码重新拉起。
  // 为什么需要：服务进程里是启动那一刻的代码，改了 server.mjs 不重启就不生效；
  // 而服务跑在高权限下，网页/普通窗口杀不掉它，只能让它自己走。
  if (p === '/api/restart') {
    json2(res, 200, { ok: true, restarting: true });
    console.log('[api] 收到重启请求，退出后由守护进程拉起新代码');
    setTimeout(() => process.exit(0), 400);
    return;
  }

  /* ---------- 应用状态（冲突裁决 / 外出培训），跨设备共用 ---------- */
  if (p === '/api/state') {
    const force = url.searchParams.get('force') === '1';
    const out = await appState.read({ force });
    return json2(res, 200, { ok: true, entries: out.entries, cached: !!out.cached, at: new Date().toISOString() });
  }
  if (p === '/api/state/push') {
    const body = await readBody(req);
    const out = await appState.write(body.entries || [], {});
    return json2(res, 200, { ok: true, entries: out.entries, written: out.written });
  }

  if (p === '/api/push') {
    const body = await readBody(req);
    const out = await engine.push(body.items, body);
    return json2(res, 200, { ok: true, ...out });
  }

  // 从云文档撤掉指定登记（网页上删除/修改过的会议）
  if (p === '/api/remove') {
    const body = await readBody(req);
    const out = await engine.remove(body.items);
    return json2(res, 200, { ok: true, ...out });
  }

  // 同步结果回传（供 /_autosync.html 等页面把执行明细落盘，便于事后核查）
  if (p === '/api/report') {
    const body = await readBody(req);
    const dir = path.join(APP_ROOT, '.tmp');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'sync-log.jsonl'),
        JSON.stringify({ receivedAt: new Date().toISOString(), ...body }) + '\n', 'utf8');
    } catch (e) {
      return json2(res, 500, { ok: false, error: 'REPORT_WRITE', message: e.message });
    }
    return json2(res, 200, { ok: true });
  }

  /* ---------- 会议通知文件夹监听 ---------- */
  // 状态 + 待办队列（带 ?rev=N 时，没变化就只回 changed:false + 空数组，省得每几秒传一遍全文）
  if (p === '/api/watch/state') {
    return json2(res, 200, watcher.snapshot(url.searchParams.get('rev')));
  }

  // 改配置：开关 / 文件夹 / 频率 / 是否含子目录
  if (p === '/api/watch/config') {
    const body = await readBody(req);
    return json2(res, 200, watcher.setConfig(body || {}));
  }

  // 校验路径是否是可读文件夹（前端填完路径点「检查」用）
  if (p === '/api/watch/check') {
    const body = await readBody(req);
    return json2(res, 200, watcher.checkFolder(body && body.folder));
  }

  // 点选子目录：列出某目录下的一级子文件夹，供前端逐级点进去
  if (p === '/api/watch/dirs') {
    const body = await readBody(req);
    return json2(res, 200, watcher.listDirs(body && body.dir));
  }

  // 常用位置（用户目录 / 桌面 / 下载 / 文档 / 盘符），供前端一键填入
  if (p === '/api/watch/roots') {
    return json2(res, 200, watcher.listRoots());
  }

  // 立即扫一次（用户刚丢进文件，不想等轮询周期）
  if (p === '/api/watch/scan') {
    await watcher.scanNow();
    return json2(res, 200, watcher.snapshot(0));
  }

  // 处理一条待办：action = imported（已导入日历）/ ignored（忽略）
  if (p === '/api/watch/act') {
    const body = await readBody(req);
    // retry 是异步的（要重新读盘解析），统一 await 一下，免得把 Promise 序列化成 {}
    return json2(res, 200, await watcher.act(body && body.id, body && body.action));
  }

  if (p === '/api/watch/clear') {
    return json2(res, 200, watcher.clearPending());
  }

  return json2(res, 404, { ok: false, error: '未知接口' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST + ':' + PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (e) {
      const code = e instanceof KdocsError ? e.code : 'ERROR';
      const status = code === 'NO_AUTH' ? 401 : 500;
      console.error(`[api] ${url.pathname} 失败:`, code, e.message);
      json(res, status, { ok: false, error: code, message: e.message || String(e) });
    }
    return;
  }
  // 口令门：启用口令时，访问页面/静态资源需先通过口令（否则只给口令输入页）
  if (ACCESS_ON && !hasAccess(req) && !isPublicAsset(url.pathname)) {
    return serveGate(res);
  }
  serveStatic(req, res, url.pathname);
});

// 无需口令即可访问的资源（口令输入页本身 + 其样式）
function isPublicAsset(p) {
  return p === '/gate' || p === '/gate.html';
}

// 口令输入页（内联，不依赖 index.html）
function serveGate(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>访问验证 · 领导会议日程</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#ffffff;color:#222222;font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}
.card{width:min(380px,92vw);background:#ffffff;border:1px solid #dddddd;border-radius:16px;
  padding:34px 30px;box-shadow:0 6px 16px rgba(0,0,0,.12),0 0 0 1px rgba(0,0,0,.04)}
h1{font-size:20px;font-weight:700;margin:0 0 6px;letter-spacing:0}
.sub{font-size:14px;color:#6a6a6a;margin:0 0 22px;line-height:1.6}
input{width:100%;font-size:15px;padding:12px 13px;background:#f7f7f7;color:#222222;
  border:1px solid #dddddd;border-radius:8px;outline:none;font-family:inherit}
input:focus{border-color:#222222;box-shadow:inset 0 0 0 1px #222222}
button{width:100%;margin-top:14px;font-size:15px;font-weight:600;padding:12px;
  background:#e00b41;border:none;color:#fff;border-radius:8px;cursor:pointer;font-family:inherit}
button:hover{background:#c00039}
.err{display:none;margin-top:12px;font-size:13px;color:#c13515}
.err.on{display:block}
</style>
</head>
<body>
<div class="card">
  <h1>访问验证</h1>
  <p class="sub">本应用已启用局域网访问口令。<br>请输入口令后继续。</p>
  <input id="k" type="password" placeholder="请输入访问口令" autocomplete="off">
  <button id="go">进入</button>
  <div class="err" id="err">口令不正确，请重试。</div>
</div>
<script>
var k=document.getElementById('k'), go=document.getElementById('go'), err=document.getElementById('err');
function send(){
  err.classList.remove('on');
  fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:k.value})})
  .then(function(r){return r.json().then(function(j){return {r:r,j:j};});})
  .then(function(o){ if(o.j.ok){ location.href='/'; } else { err.classList.add('on'); k.select(); } })
  .catch(function(){ err.classList.add('on'); });
}
go.addEventListener('click', send);
k.addEventListener('keydown', function(e){ if(e.key==='Enter') send(); });
k.focus();
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function openBrowser(target) {
  if (process.env.KDOCS_NO_OPEN === '1') return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${target}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打不开就手动访问 */ }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    if (process.env.KDOCS_DAEMON === '1') {
      // 守护模式：多半是已有实例在跑。用退出码 78 告诉守护进程「别再拉我了」，
      // 否则会陷入「起不来→重启→还起不来」的死循环，还会反复弹浏览器。
      console.log(`端口 ${PORT} 已被占用，已有实例在运行，本进程退出（78）。`);
      setTimeout(() => process.exit(78), 200);
      return;
    }
    console.log(`端口 ${PORT} 已被占用——服务可能已经在运行，直接打开页面。`);
    openBrowser(`http://${HOST}:${PORT}/`);
    setTimeout(() => process.exit(0), 800);
    return;
  }
  console.error('启动失败：', e.message);
  process.exit(1);
});

/* 守护模式下「不许停」：单个请求出错不该把整个服务带走，记日志继续跑 */
process.on('uncaughtException', (e) => {
  console.error('[未捕获异常] 服务继续运行：', (e && e.stack) || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[未处理的 Promise 拒绝] 服务继续运行：', (e && e.stack) || e);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  会议日程 · 本地同步服务已启动');
  console.log(`  本机访问： http://127.0.0.1:${PORT}/`);
  if (ACCESS_ON) {
    console.log(`  局域网共享： http://<本机IP>:${PORT}/  （已启用访问口令）`);
  } else {
    console.log('  局域网共享：未启用（未配置 bridge/.access-key.txt）');
  }
  console.log(`  云文档：${SHEET.name}  ${SHEET.url}`);
  console.log(`  登录状态：${kd.authed() ? '已登录' : '未登录（网页里点「登录金山文档」即可）'}`);
  console.log('  关闭此窗口即停止服务（网页其余功能不受影响）。');
  console.log('');
  openBrowser(`http://127.0.0.1:${PORT}/`);
});
