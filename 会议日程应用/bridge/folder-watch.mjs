/**
 * 会议通知文件夹监听（全本地，不联网）
 *
 * 作用：盯着用户指定的一个文件夹，一旦里面出现 .docx/.doc/.pdf/图片 等会议通知，
 *      就用本地 Python 提取文字，放进「待确认队列」，等网页右下角弹提醒问用户要不要导入。
 *
 * 为什么用轮询而不是 fs.watch：
 *   Windows 下 fs.watch 对中文路径、网络盘、Office「先写临时文件再改名」的行为并不可靠，
 *   轮询实现简单、行为可预期，3 秒一次的开销可以忽略。
 *
 * 防抖设计（关键）：
 *   文件刚被拖进文件夹时可能还在复制，此时读到的是半个文件，解析必然失败。
 *   所以同一签名（大小+mtime）要连续两次扫描都一致，才认定「文件已落定」并解析。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DEFAULT_EXTS = ['.docx', '.doc', '.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.webp'];
const MAX_PENDING = 30;      // 队列上限，超出的丢掉最老的（用户长期不处理时不至于无限堆积）
const MAX_SEEN = 4000;       // 已处理签名记录上限，超出按时间淘汰
const MAX_TEXT = 20000;      // 单个文件提取文本上限（字符）
const MAX_FILES_PER_SCAN = 200;
const MAX_DEPTH = 4;

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 落盘失败不影响运行 */ }
}

export function createFolderWatch({ dataDir, extractPathText, log }) {
  const CFG_FILE = path.join(dataDir, '.watch-config.json');
  const SEEN_FILE = path.join(dataDir, '.watch-seen.json');
  const PEND_FILE = path.join(dataDir, '.watch-pending.json');
  const say = log || (() => {});

  const cfg = Object.assign({
    enabled: false,
    folder: '',
    interval: 3000,
    recursive: false,
    exts: DEFAULT_EXTS.slice(),
  }, readJSON(CFG_FILE, {}));
  if (!Array.isArray(cfg.exts) || !cfg.exts.length) cfg.exts = DEFAULT_EXTS.slice();

  // seen: { [sig]: 时间戳 }  已处理过的文件签名，避免重复提醒
  // 签名规则改过就升 SEEN_VERSION：旧记录对不上新签名，整体作废并重建基线，
  // 否则用户升级后会被文件夹里的存量通知一次性轰炸。
  const SEEN_VERSION = 2;
  const seenRaw = readJSON(SEEN_FILE, null);
  let seen = {};
  if (seenRaw && seenRaw.__v === SEEN_VERSION && seenRaw.items && typeof seenRaw.items === 'object') {
    seen = seenRaw.items;
  }
  // pending: [{ id, name, path, at, ok, text, error }]
  let pending = readJSON(PEND_FILE, []);
  if (!Array.isArray(pending)) pending = [];

  let rev = 1;                 // 队列版本号：前端靠它判断「有没有新东西」，没变化就不传全文
  let baselineReady = false;   // 是否已建立基线（首次开启时把已有文件都记成「见过」，不轰炸用户）
  let scanning = false;
  let timer = null;
  let kickoff = null;
  const probe = new Map();     // sig -> 已连续观察次数（防止读到复制中的半个文件）
  let lastScanAt = 0;
  let lastErr = '';

  function bump() { rev++; }

  function saveSeen() {
    // 超出上限时按时间淘汰最老的
    const keys = Object.keys(seen);
    if (keys.length > MAX_SEEN) {
      keys.sort((a, b) => (seen[a] || 0) - (seen[b] || 0));
      for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete seen[k];
    }
    writeJSON(SEEN_FILE, { __v: SEEN_VERSION, items: seen });
  }
  function savePending() { writeJSON(PEND_FILE, pending); }
  function saveCfg() { writeJSON(CFG_FILE, cfg); }

  function sigOf(f) {
    // 名字 + 大小 + 修改时间：三个都一致才算「同一个文件」
    // 只用 size+mtime 会让两个不同通知恰好同大小同秒复制时互相顶掉；
    // 只用名字又会让「同名文件被覆盖成新通知」漏提醒。
    return `${f.name.toLowerCase()}|${f.size}|${Math.round(f.mtime)}`;
  }

  function collect(dir, out, depth) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { lastErr = '读取文件夹失败：' + e.message; return out; }
    for (const e of ents) {
      if (out.length >= MAX_FILES_PER_SCAN) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (cfg.recursive && depth < MAX_DEPTH && !e.name.startsWith('.')) collect(full, out, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name.startsWith('~$')) continue;                       // Office 临时锁文件
      if (e.name.startsWith('.')) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (cfg.exts.indexOf(ext) < 0) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || st.size <= 0) continue;
      out.push({ full, name: e.name, size: st.size, mtime: st.mtimeMs, ext });
    }
    return out;
  }

  function pushPending(item) {
    pending.push(item);
    // 超出上限：丢掉最老的、且还没被处理的
    while (pending.length > MAX_PENDING) pending.shift();
    bump();
    savePending();
    say(`发现会议通知：${item.name}${item.ok ? '' : '（解析失败）'}`);
  }

  async function processFile(f) {
    const id = crypto.createHash('sha1').update(sigOf(f) + '|' + f.name).digest('hex').slice(0, 12);
    const base = { id, name: f.name, path: f.full, at: Date.now() };
    let out;
    try {
      out = await extractPathText(f.full, f.name);
    } catch (e) {
      out = { ok: false, error: 'EXTRACT_FAIL', message: e.message || String(e) };
    }
    if (out && out.ok && out.text && out.text.trim()) {
      pushPending(Object.assign(base, { ok: true, text: String(out.text).slice(0, MAX_TEXT) }));
    } else {
      pushPending(Object.assign(base, {
        ok: false,
        error: (out && (out.message || out.error)) || '未提取到文字内容',
      }));
    }
  }

  async function scan() {
    if (scanning || !cfg.enabled || !cfg.folder) return;
    scanning = true;
    lastErr = '';
    try {
      let st;
      try { st = fs.statSync(cfg.folder); } catch (e) {
        lastErr = '文件夹不存在或无法访问：' + cfg.folder;
        return;
      }
      if (!st.isDirectory()) { lastErr = '路径不是文件夹：' + cfg.folder; return; }

      const files = collect(cfg.folder, [], 0);
      lastScanAt = Date.now();

      // ① 首次开启 / 换了文件夹：把现有文件全记成「见过」，只提醒之后新增的
      if (!baselineReady) {
        for (const f of files) seen[sigOf(f)] = Date.now();
        saveSeen();
        baselineReady = true;
        probe.clear();
        say(`已开始监听 ${cfg.folder}（现有 ${files.length} 个文件作为基线，不再提醒）`);
        return;
      }

      for (const f of files) {
        const sig = sigOf(f);
        if (seen[sig]) { probe.delete(sig); continue; }
        // ② 稳定性确认：连续两次扫描签名一致，才认为文件已复制完成
        const n = (probe.get(sig) || 0) + 1;
        if (n < 2) { probe.set(sig, n); continue; }
        probe.delete(sig);
        seen[sig] = Date.now();
        saveSeen();
        await processFile(f);
      }
    } catch (e) {
      lastErr = '扫描出错：' + (e.message || String(e));
    } finally {
      scanning = false;
    }
  }

  function startTimer() {
    stopTimer();
    if (!cfg.enabled || !cfg.folder) return;
    const iv = Math.max(1500, Number(cfg.interval) || 3000);
    timer = setInterval(scan, iv);
    if (timer.unref) timer.unref();     // 别因为定时器把进程拖住不让退出
    kickoff = setTimeout(scan, 300);    // 开启后立刻扫一次
    if (kickoff.unref) kickoff.unref();
  }
  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    if (kickoff) { clearTimeout(kickoff); kickoff = null; }
  }

  // 公开：读状态。changed=false 时前端不用更新（省流量）
  function snapshot(clientRev) {
    const n = Number(clientRev) || 0;
    const changed = n !== rev;
    return {
      ok: true,
      rev,
      changed,
      enabled: !!cfg.enabled,
      folder: cfg.folder,
      interval: cfg.interval,
      recursive: !!cfg.recursive,
      exts: cfg.exts,
      baselineReady,
      lastScanAt,
      lastErr,
      pendingCount: pending.length,
      pending: changed ? pending.map((p) => ({
        id: p.id, name: p.name, path: p.path, at: p.at,
        ok: !!p.ok, error: p.error || '', text: p.ok ? (p.text || '') : '',
      })) : [],
    };
  }

  // 公开：改配置。enabled/folder 变化会重建基线，避免把历史文件当新通知
  function setConfig(patch) {
    const before = { enabled: cfg.enabled, folder: cfg.folder, recursive: cfg.recursive, exts: cfg.exts.join(',') };
    if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled;
    if (typeof patch.folder === 'string') cfg.folder = patch.folder.trim();
    if (patch.interval) cfg.interval = Math.max(1500, Number(patch.interval) || 3000);
    if (typeof patch.recursive === 'boolean') cfg.recursive = patch.recursive;
    if (Array.isArray(patch.exts) && patch.exts.length) {
      cfg.exts = patch.exts.map((x) => String(x).toLowerCase()).filter((x) => /^\.[a-z0-9]+$/.test(x));
      if (!cfg.exts.length) cfg.exts = DEFAULT_EXTS.slice();
    }
    saveCfg();
    bump();

    const folderChanged = before.folder !== cfg.folder || before.recursive !== cfg.recursive || before.exts !== cfg.exts.join(',');
    const justEnabled = !before.enabled && cfg.enabled;
    if (folderChanged) {
      // 换目录/换格式：旧队列作废，重新建基线
      pending = [];
      savePending();
      probe.clear();
      baselineReady = false;
    } else if (justEnabled) {
      baselineReady = false;     // 刚打开：现有文件当基线，不提醒
      probe.clear();
    }
    if (cfg.enabled && cfg.folder) startTimer(); else stopTimer();
    return snapshot(0);
  }

  // 公开：重新解析一条失败/过时的待办（解析器升级后不用让用户重新放一遍文件）
  async function retry(id) {
    const item = pending.find((p) => p.id === id);
    if (!item) return { ok: false, error: 'NOT_FOUND' };
    let out;
    try {
      out = await extractPathText(item.path, item.name);
    } catch (e) {
      out = { ok: false, message: e.message || String(e) };
    }
    if (out && out.ok && out.text && out.text.trim()) {
      item.ok = true;
      item.text = String(out.text).slice(0, MAX_TEXT);
      item.error = '';
    } else {
      item.ok = false;
      item.text = '';
      item.error = (out && (out.message || out.error)) || '未提取到文字内容';
    }
    item.at = Date.now();
    bump();
    savePending();
    say(`重新解析：${item.name}${item.ok ? '（成功）' : '（仍失败）'}`);
    return { ok: true, rev, item: { id: item.id, ok: item.ok, error: item.error } };
  }

  // 公开：处理一条（导入 / 忽略）
  function act(id, action) {
    if (action === 'retry') return retry(id);
    const i = pending.findIndex((p) => p.id === id);
    if (i < 0) return { ok: false, error: 'NOT_FOUND' };
    pending.splice(i, 1);
    bump();
    savePending();
    if (action) say(`待办已${action === 'imported' ? '导入' : '忽略'}：${id}`);
    return { ok: true, rev };
  }

  function clearPending() {
    pending = [];
    bump();
    savePending();
    return { ok: true, rev };
  }

  // 校验一个路径是不是可用文件夹（给前端「浏览」用，也便于用户确认路径没写错）
  function checkFolder(p) {
    const target = String(p || '').trim();
    if (!target) return { ok: false, error: 'EMPTY', message: '请填写文件夹路径' };
    try {
      const st = fs.statSync(target);
      if (!st.isDirectory()) return { ok: false, error: 'NOT_DIR', message: '这不是一个文件夹' };
      const files = collect(target, [], 0);
      return { ok: true, path: target, count: files.length, files: files.slice(0, 10).map((f) => f.name) };
    } catch (e) {
      return { ok: false, error: 'NOT_FOUND', message: '路径不存在或无法访问：' + target };
    }
  }

  // 列出某个目录下的子文件夹，供前端「点选」下一级目录。传空则从用户主目录开始。
  function listDirs(p) {
    const target = String(p || '').trim() || os.homedir();
    try {
      const st = fs.statSync(target || '.');
      if (!st.isDirectory()) return { ok: false, error: 'NOT_DIR', message: '不是文件夹' };
      const ents = fs.readdirSync(target, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
        .slice(0, 200)
        .map((e) => e.name);
      return { ok: true, path: path.resolve(target), dirs: ents };
    } catch (e) {
      return { ok: false, error: 'NOT_FOUND', message: '无法读取：' + (e.message || '') };
    }
  }

  // 常用位置（桌面/下载/文档）：中文系统目录名可能是「桌面」，都探测一遍，只回存在的
  function listRoots() {
    const home = os.homedir();
    const picks = [
      { label: '用户目录', path: home },
      { label: '桌面', path: path.join(home, 'Desktop') },
      { label: '桌面', path: path.join(home, '桌面') },
      { label: '下载', path: path.join(home, 'Downloads') },
      { label: '下载', path: path.join(home, '下载') },
      { label: '文档', path: path.join(home, 'Documents') },
      { label: '文档', path: path.join(home, '文档') },
    ];
    const out = [], used = new Set();
    for (const c of picks) {
      try {
        if (!fs.existsSync(c.path) || used.has(c.path)) continue;
        if (!fs.statSync(c.path).isDirectory()) continue;
        used.add(c.path);
        out.push(c);
      } catch { /* ignore */ }
    }
    // 盘符（Windows）：D:\ E:\ 等，方便用户直接点进别的盘
    if (process.platform === 'win32') {
      for (const d of 'CDEFG'.split('')) {
        const root = d + ':\\';
        try { if (fs.existsSync(root) && !used.has(root)) { used.add(root); out.push({ label: d + ' 盘', path: root }); } } catch { /* ignore */ }
      }
    }
    return { ok: true, roots: out };
  }

  if (cfg.enabled && cfg.folder) startTimer();

  return {
    snapshot, setConfig, act, clearPending, checkFolder, listDirs, listRoots,
    scanNow: () => scan(),
    stop: stopTimer,
    getConfig: () => Object.assign({}, cfg),
  };
}
