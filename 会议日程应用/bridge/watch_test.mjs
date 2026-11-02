// 文件夹监听回归测试：基线、稳定性确认、待办队列、导入/忽略、路径校验
// 说明：解析器用假的（不依赖本机 Python），只验证监听与队列逻辑本身。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFolderWatch } from './folder-watch.mjs';

let pass = 0, fail = 0;
const T = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  →  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-test-'));
const dataDir = path.join(root, 'data');
const inbox = path.join(root, 'inbox');
const inbox2 = path.join(root, 'inbox2');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(inbox, { recursive: true });
fs.mkdirSync(inbox2, { recursive: true });
fs.mkdirSync(path.join(inbox, 'sub-a'), { recursive: true });
fs.mkdirSync(path.join(inbox, 'sub-b'), { recursive: true });

// 假解析器：默认成功；文件名带 bad 时模拟解析失败
const calls = [];
const extract = async (p, name) => {
  calls.push(name);
  if (/bad/i.test(name)) return { ok: false, error: 'EXTRACT_FAIL', message: '模拟解析失败' };
  return { ok: true, text: '10月28日（星期三）上午9:00，B027会议室，测试会议，请崔三参加。' };
};

const w = createFolderWatch({ dataDir, extractPathText: extract, log: () => {} });
const stop = () => { try { w.stop(); } catch { /* ignore */ } };
const write = (dir, name, body) => fs.writeFileSync(path.join(dir, name), body, 'utf8');
const scanTwice = async () => { await w.scanNow(); await w.scanNow(); };

/* ---------- 一、未开启时什么都不做 ---------- */
console.log('--- 未开启 ---');
write(inbox, 'old.docx', 'old');
{
  await w.scanNow();
  const s = w.snapshot(0);
  T('默认 enabled=false', s.enabled === false, String(s.enabled));
  T('未开启时不扫描、不提醒', s.pendingCount === 0 && s.pending.length === 0, JSON.stringify(s.pending));
}

/* ---------- 二、开启后建立基线：已有文件不提醒 ---------- */
console.log('\n--- 基线与新文件 ---');
{
  w.setConfig({ enabled: true, folder: inbox, interval: 3000 });
  stop();                                     // 测试里用 scanNow 手动推进，避免定时器干扰
  const s0 = w.snapshot(0);
  T('配置已保存', s0.enabled === true && s0.folder === inbox, JSON.stringify({ e: s0.enabled, f: s0.folder }));
  T('刚开启时基线未建立', s0.baselineReady === false, String(s0.baselineReady));

  await w.scanNow();                          // 第一次扫描：建基线
  const s1 = w.snapshot(0);
  T('扫描后基线已建立', s1.baselineReady === true);
  T('已有文件 old.docx 不提醒', s1.pendingCount === 0, String(s1.pendingCount));

  // 新文件：第一次扫描只记录签名，第二次才处理（防半个文件）
  write(inbox, 'new.docx', 'x');
  await w.scanNow();
  T('新文件首次扫描不立即处理（稳定性确认）', w.snapshot(0).pendingCount === 0, String(w.snapshot(0).pendingCount));
  await w.scanNow();
  const s2 = w.snapshot(0);
  T('连续两次扫描一致后进入待办', s2.pendingCount === 1, String(s2.pendingCount));
  T('待办项是 new.docx', s2.pending[0] && s2.pending[0].name === 'new.docx', JSON.stringify(s2.pending.map((p) => p.name)));
  T('待办项带提取文本', !!(s2.pending[0] && /测试会议/.test(s2.pending[0].text)), (s2.pending[0] || {}).text);
  T('已调解析器', calls.indexOf('new.docx') >= 0, JSON.stringify(calls));
}

/* ---------- 三、版本号与增量返回 ---------- */
console.log('\n--- 版本号 ---');
{
  const rev = w.snapshot(0).rev;
  const same = w.snapshot(rev);
  T('rev 相同 → changed=false', same.changed === false, String(same.changed));
  T('rev 相同 → 不回传全文（省流量）', Array.isArray(same.pending) && same.pending.length === 0, JSON.stringify(same.pending));
  const full = w.snapshot(rev - 1);
  T('rev 不同 → changed=true 并带全文', full.changed === true && full.pending.length === 1, JSON.stringify(full.pending.map((p) => p.name)));
}

/* ---------- 四、导入 / 忽略 ---------- */
console.log('\n--- 导入与忽略 ---');
{
  const id = w.snapshot(0).pending[0].id;
  const r = w.act(id, 'imported');
  T('act(imported) 成功', r.ok === true, JSON.stringify(r));
  T('导入后队列清空', w.snapshot(0).pendingCount === 0, String(w.snapshot(0).pendingCount));
  T('重复处理已不存在的项返回 NOT_FOUND', w.act(id, 'imported').ok === false);

  write(inbox, 'ignore-me.pdf', 'y');
  await scanTwice();
  const id2 = w.snapshot(0).pending[0] && w.snapshot(0).pending[0].id;
  T('新 PDF 进入待办', !!id2, JSON.stringify(w.snapshot(0).pending.map((p) => p.name)));
  w.act(id2, 'ignored');
  T('忽略后队列清空', w.snapshot(0).pendingCount === 0);
}

/* ---------- 五、解析失败也要提醒（带错误原因） ---------- */
console.log('\n--- 解析失败 ---');
{
  write(inbox, 'bad-one.docx', 'z');
  await scanTwice();
  const s = w.snapshot(0);
  T('解析失败的文件仍进队列', s.pendingCount === 1, String(s.pendingCount));
  T('待办项标记 ok=false', s.pending[0] && s.pending[0].ok === false);
  T('待办项带失败原因', !!(s.pending[0] && /模拟解析失败/.test(s.pending[0].error)), (s.pending[0] || {}).error);
  T('失败项不回传 text', (s.pending[0] || {}).text === '', (s.pending[0] || {}).text);
  w.act(s.pending[0].id, 'ignored');
}

/* ---------- 六、同一文件不重复提醒 ---------- */
console.log('\n--- 去重 ---');
{
  await scanTwice();
  const before = w.snapshot(0).pendingCount;
  const n = calls.length;
  write(inbox, 'dup.docx', 'same');
  await scanTwice();
  const mid = w.snapshot(0).pendingCount;
  await scanTwice();                                  // 再扫两轮，不应再加一条
  const after = w.snapshot(0).pendingCount;
  T('同一文件只提醒一次', mid === before + 1 && after === mid, `before=${before} mid=${mid} after=${after}`);
  T('不会重复调用解析器', calls.length === n + 1, `calls +${calls.length - n}`);
}

/* ---------- 六之二、签名规则：名字+大小+时间 ---------- */
console.log('\n--- 签名规则 ---');
{
  const base = w.snapshot(0).pendingCount;
  // 不同文件名、相同内容大小 → 两条独立的提醒，不能互相顶掉
  write(inbox, 'sig-a.docx', 'AAAA');
  await scanTwice();
  write(inbox, 'sig-b.docx', 'BBBB');            // 与 sig-a 同长度
  await scanTwice();
  const s = w.snapshot(0);
  T('不同名同大小的文件各自提醒', s.pendingCount === base + 2, `${s.pendingCount} vs ${base + 2}`);
  T('两条都在队列里', s.pending.some((p) => p.name === 'sig-a.docx') && s.pending.some((p) => p.name === 'sig-b.docx'),
    JSON.stringify(s.pending.map((p) => p.name)));

  // 同名文件内容变长（大小变化）→ 视为新通知，再提醒一次
  const n1 = w.snapshot(0).pendingCount;
  write(inbox, 'sig-a.docx', 'AAAA-改成了更长的内容');
  await scanTwice();
  T('同名文件内容变了会再提醒', w.snapshot(0).pendingCount === n1 + 1, `${w.snapshot(0).pendingCount} vs ${n1 + 1}`);
}

/* ---------- 七、不支持的格式 / Office 临时文件要忽略 ---------- */
console.log('\n--- 格式过滤 ---');
{
  const before = w.snapshot(0).pendingCount;
  write(inbox, 'note.txt', 'not a meeting');       // 不在扩展名白名单
  write(inbox, '~$temp.docx', 'lock file');        // Office 锁文件
  write(inbox, '.hidden.pdf', 'hidden');           // 隐藏文件
  await scanTwice();
  T('txt / ~$锁文件 / 隐藏文件都不提醒', w.snapshot(0).pendingCount === before, String(w.snapshot(0).pendingCount));
}

/* ---------- 八、换文件夹：重建基线，旧队列作废 ---------- */
console.log('\n--- 换文件夹 ---');
{
  write(inbox2, 'exists.pdf', 'already here');
  w.setConfig({ folder: inbox2 });
  stop();
  const s = w.snapshot(0);
  T('换文件夹后队列清空', s.pendingCount === 0, String(s.pendingCount));
  T('换文件夹后基线重置', s.baselineReady === false, String(s.baselineReady));
  await w.scanNow();
  T('新目录里的既有文件不提醒', w.snapshot(0).pendingCount === 0, String(w.snapshot(0).pendingCount));

  write(inbox2, 'fresh.pdf', 'ff');
  await scanTwice();
  T('新目录里的新文件会提醒', w.snapshot(0).pendingCount === 1, String(w.snapshot(0).pendingCount));
}

/* ---------- 九、路径校验与目录点选 ---------- */
console.log('\n--- 路径校验 ---');
{
  const ok = w.checkFolder(inbox);
  T('checkFolder 合法目录返回 ok', ok.ok === true, JSON.stringify(ok));
  T('checkFolder 返还可解析文件数', typeof ok.count === 'number' && ok.count > 0, String(ok.count));

  const bad = w.checkFolder(path.join(root, 'nope'));
  T('checkFolder 不存在的路径报错', bad.ok === false && bad.error === 'NOT_FOUND', JSON.stringify(bad));

  const file = path.join(inbox, 'old.docx');
  const notDir = w.checkFolder(file);
  T('checkFolder 传文件报 NOT_DIR', notDir.ok === false && notDir.error === 'NOT_DIR', JSON.stringify(notDir));

  const dirs = w.listDirs(inbox);
  T('listDirs 列出子目录', dirs.ok === true && dirs.dirs.indexOf('sub-a') >= 0 && dirs.dirs.indexOf('sub-b') >= 0, JSON.stringify(dirs.dirs));

  const roots = w.listRoots();
  T('listRoots 至少给出一个常用位置', roots.ok === true && roots.roots.length >= 1, JSON.stringify(roots.roots));
}

/* ---------- 十、关闭监听后不再扫描 ---------- */
console.log('\n--- 关闭监听 ---');
{
  w.setConfig({ enabled: false });
  stop();
  const before = w.snapshot(0).pendingCount;
  write(inbox2, 'while-off.pdf', 'off');
  await scanTwice();
  T('关闭后新文件不提醒', w.snapshot(0).pendingCount === before, String(w.snapshot(0).pendingCount));
  T('关闭状态已保存', w.snapshot(0).enabled === false);
}

/* ---------- 十一、重启后状态从磁盘恢复 ---------- */
console.log('\n--- 持久化 ---');
{
  w.setConfig({ enabled: true, folder: inbox2 });
  stop();
  write(inbox2, 'persist.pdf', 'p1');
  await scanTwice();
  const beforeCount = w.snapshot(0).pendingCount;
  T('重启前有待办', beforeCount >= 1, String(beforeCount));

  const w2 = createFolderWatch({ dataDir, extractPathText: extract, log: () => {} });
  w2.stop();
  const s2 = w2.snapshot(0);
  T('重启后配置恢复（enabled/folder）', s2.enabled === true && s2.folder === inbox2, JSON.stringify({ e: s2.enabled, f: s2.folder }));
  T('重启后待办恢复', s2.pendingCount === beforeCount, `${s2.pendingCount} vs ${beforeCount}`);
  T('重启后基线视为未建立（不会把历史文件当新通知）', s2.baselineReady === false);
  w2.act(s2.pending[0] && s2.pending[0].id, 'ignored');
}

/* ---------- 十二、清空待办 ---------- */
console.log('\n--- 清空 ---');
{
  write(inbox2, 'clear-me.pdf', 'c');
  await scanTwice();
  T('清空前有内容', w.snapshot(0).pendingCount >= 1, String(w.snapshot(0).pendingCount));
  w.clearPending();
  T('清空后为 0', w.snapshot(0).pendingCount === 0, String(w.snapshot(0).pendingCount));
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
stop();
console.log('\n' + (fail ? `❌ 失败 ${fail} 项 / 共 ${pass + fail} 项` : `✅ 全部 ${pass} 项通过`));
process.exit(fail ? 1 : 0);
