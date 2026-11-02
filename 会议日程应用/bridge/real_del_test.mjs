/**
 * 真实环境冒烟测试：对金山文档《会议安排》执行「写入→删除」，验证删得准、删得干净、能恢复原状。
 *
 * 只动临时单元格：
 *   A. 找一格本来空的 → 写入测试会议 → 删除 → 必须回到空白
 *   B. 找一格已有内容的 → 追加测试会议 → 删除 → 原有内容必须一字不差
 * 无论成功失败，最后都会把「同步删除自测」这条清掉，并比对全表快照与开始时一致。
 *
 * 运行：node bridge/real_del_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kdocs } from './kdocs.mjs';
import { createEngine, cellSegments } from './sheet-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHEET = {
  fileId: 'nK7paBFZD1Mw9b9GPHrrBxqVyiwKXpFSr',
  url: 'https://www.kdocs.cn/l/ctI49zhGV2pd',
  name: '会议安排.xlsx',
};
const MARK = '同步删除自测';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

const kd = new Kdocs(process.env.KDOCS_AUTH_FILE || path.join(__dirname, '.auth.json'));
if (!kd.authed()) {
  console.log('未登录：先启动服务并完成一次金山文档授权，再跑本测试。');
  process.exit(2);
}
const engine = createEngine({ kd, sheet: SHEET, snapshotPath: null });

const touched = []; // 记住测试碰过的位置，兜底清理

async function readCell(date, leader) {
  const sh = await engine.readSheet();
  return sh.cells[`${date}|${leader}`] || '';
}

async function cleanup() {
  try {
    const sh = await engine.readSheet();
    const victims = [];
    for (const [key, txt] of Object.entries(sh.cells)) {
      if (!txt || !txt.includes(MARK)) continue;
      const [date, leader] = key.split('|');
      for (const seg of cellSegments(txt)) {
        if (seg.includes(MARK)) {
          victims.push({ date, leader, title: MARK, start: '', place: '' });
        }
      }
    }
    if (victims.length) {
      const r = await engine.remove(victims);
      console.log(`  · 兜底清理：删掉 ${r.removed.length} 条残留测试数据`);
    }
  } catch (e) {
    console.log('  · 兜底清理失败（需手工检查）：' + e.message);
  }
}

const baseline = await engine.readSheet();
const baseCells = { ...baseline.cells };
console.log(`起点：${Object.keys(baseCells).length} 处登记\n`);

let exitCode = 0;
try {
  /* ---------- A. 空格子：写入 → 删除 → 应恢复空白 ---------- */
  console.log('【A】空单元格：写入测试会议后删除，格子要回到空白');
  let blank = null;
  for (const date of Object.keys(baseline.rowsByDate).sort()) {
    for (const [leader, col] of Object.entries(baseline.colOf)) {
      if (col == null) continue;
      if (!String(baseline.cells[`${date}|${leader}`] || '').trim()) { blank = { date, leader }; break; }
    }
    if (blank) break;
  }
  if (!blank) {
    console.log('  SKIP  没有找到空白单元格');
  } else {
    console.log(`  选中空位：${blank.date} / ${blank.leader}`);
    const T = { date: blank.date, leader: blank.leader, title: MARK, start: '09:00', place: 'B027' };
    const pushed = await engine.push([{ ...T, text: '上午9:00，B027，' + MARK }]);
    touched.push(T);
    ok(pushed.written.length === 1, 'A1 写入成功');
    const afterPush = await readCell(blank.date, blank.leader);
    ok(afterPush.includes(MARK), 'A2 云上确实写进去了', JSON.stringify(afterPush));

    const rm = await engine.remove([T]);
    ok(rm.removed.length === 1, 'A3 删除命中 1 条');
    ok(rm.emptied.length === 1, 'A4 引擎判定该格已清空');
    const afterRm = await readCell(blank.date, blank.leader);
    ok(!String(afterRm).trim(), 'A5 云上该格已恢复空白', JSON.stringify(afterRm));
  }

  /* ---------- B. 有内容的格子：追加 → 删除 → 原内容不变 ---------- */
  console.log('\n【B】已有内容的单元格：追加测试会议后删除，原有内容要一字不差');
  let busy = null;
  for (const [key, txt] of Object.entries(baseline.cells)) {
    if (String(txt || '').trim().length > 6) { const [d, l] = key.split('|'); busy = { date: d, leader: l, orig: txt }; break; }
  }
  if (!busy) {
    console.log('  SKIP  没有找到已有内容的单元格');
  } else {
    console.log(`  选中：${busy.date} / ${busy.leader}`);
    const T = { date: busy.date, leader: busy.leader, title: MARK, start: '10:30', place: 'B027' };
    const pushed = await engine.push([{ ...T, text: '上午10:30，B027，' + MARK }]);
    touched.push(T);
    ok(pushed.written.length === 1, 'B1 追加成功');
    const afterPush = await readCell(busy.date, busy.leader);
    ok(afterPush.includes(MARK), 'B2 测试会议已追加');
    ok(afterPush.includes(cellSegments(busy.orig)[0]), 'B3 原有内容还在');

    const rm = await engine.remove([T]);
    ok(rm.removed.length === 1, 'B4 删除命中 1 条');
    ok(rm.emptied.length === 0, 'B5 没有把整格清空');
    const afterRm = await readCell(busy.date, busy.leader);
    ok(afterRm === busy.orig, 'B6 原有内容与测试前完全一致', JSON.stringify(afterRm));
  }
} catch (e) {
  console.log('\n执行异常：' + e.message);
  fail++;
  exitCode = 1;
} finally {
  await cleanup();
}

/* ---------- 收尾：全表比对 ---------- */
const end = await engine.readSheet();
const endCells = end.cells;
const diffs = [];
for (const k of new Set([...Object.keys(baseCells), ...Object.keys(endCells)])) {
  if ((baseCells[k] || '') !== (endCells[k] || '')) diffs.push(k);
}
console.log('\n【C】收尾核对');
ok(diffs.length === 0, '全表 ' + Object.keys(baseCells).length + ' 处登记与测试开始前完全一致',
   diffs.length ? ('有变化的格子：' + diffs.slice(0, 5).join('、')) : '');
ok(!Object.values(endCells).some((v) => String(v || '').includes(MARK)), '没有残留的测试数据');

console.log(`\n===== 结果：${pass} 项通过，${fail} 项失败 =====`);
process.exit(fail ? 1 : exitCode);
