/**
 * 删除同步的离线测试：用假网关跑 engine.remove()，不碰真实云文档。
 * 运行：node bridge/remove_test.mjs
 */
import { createEngine, pickSegIndex, cellHasEvent } from './sheet-engine.mjs';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

/* ---------------- 假网关：内存表格 ---------------- */
function makeKd(init) {
  const grid = new Map(Object.entries(init || {}));
  const calls = [];
  const HEAD = { 0: '日期', 1: '星期', 2: '崔三', 3: '姜九', 4: '杜四', 5: '谷六', 6: '韩七', 7: '贺八' };
  for (const [c, v] of Object.entries(HEAD)) grid.set(`0|${c}`, v);
  const kd = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'sheet.get_sheets_info') {
        let maxRow = 0;
        for (const k of grid.keys()) maxRow = Math.max(maxRow, Number(k.split('|')[0]));
        return { code: 0, data: { detail: { sheetsInfo: [{ sheetId: 'SH1', rowTo: maxRow + 1 }] } } };
      }
      if (name === 'sheet.get_range_data') {
        const r = args.range, out = [];
        for (const [k, v] of grid) {
          const [rs, cs] = k.split('|').map(Number);
          if (rs >= r.rowFrom && rs <= r.rowTo && cs >= r.colFrom && cs <= r.colTo) {
            out.push({ rowFrom: rs, colFrom: cs, cellText: v });
          }
        }
        return { code: 0, data: { detail: { rangeData: out } } };
      }
      if (name === 'sheet.range_data_batch_update') {
        for (const w of args.range_data) {
          const key = `${w.row_from}|${w.col_from}`;
          if (String(w.formula == null ? '' : w.formula) === '') grid.delete(key);
          else grid.set(key, w.formula);
        }
        return { code: 0 };
      }
      if (name === 'sheet.insert_rows_cols') return { code: 0 };
      throw new Error('未预期的接口调用: ' + name);
    },
  };
  return { kd, calls, grid };
}
function cell(grid, r, c) { return grid.get(`${r}|${c}`); }
function engineFor(f) {
  return createEngine({
    kd: f.kd,
    sheet: { fileId: 'F1', url: 'u', name: 'n' },
    snapshotPath: null,
  });
}

/* ================= 1. pickSegIndex 挑段 ================= */
console.log('\n【1】pickSegIndex —— 在一格里挑出该删的那一段');
{
  const segs = ['上午9:00，B027，污水治理', '下午15:00，B027，安全生产检查'];
  eq(pickSegIndex(segs, { title: '安全生产检查', start: '15:00' }), 1, '两条不同会议 → 选中下午那条');
  eq(pickSegIndex(segs, { title: '污水治理', start: '09:00' }), 0, '选中上午那条');
  eq(pickSegIndex(segs, { title: '不存在的会', start: '10:00' }), -1, '找不到 → -1');

  const same = ['上午9:00，B027，党组会', '下午15:00，B027，党组会'];
  eq(pickSegIndex(same, { title: '党组会', start: '15:00' }), 1, '同名不同时间 → 按时间选中');
  eq(pickSegIndex(same, { title: '党组会', start: '09:00' }), 0, '同名不同时间 → 按时间选中（另一条）');

  const twin = ['上午9:00，B027，党组会', '上午9:00，A801，党组会'];
  eq(pickSegIndex(twin, { title: '党组会', start: '09:00', place: 'A801' }), 1, '同名同时间 → 按地点选');
}

/* ================= 2. 同格多条：只删其中一条 ================= */
console.log('\n【2】同格多条会议，只删匹配那一条，其它的原样保留');
{
  const f = makeKd({
    '1|0': '2026年10月29日',
    '1|5': '上午9:00，B027，污水治理\n下午15:00，B027，安全生产检查',
  });
  const e = engineFor(f);
  const out = await e.remove([{ date: '2026-10-29', leader: '谷六', title: '安全生产检查', start: '15:00' }]);
  eq(out.removed.length, 1, 'removed 1 条');
  eq(out.notFound.length, 0, '没有 notFound');
  eq(cell(f.grid, 1, 5), '上午9:00，B027，污水治理', '剩余内容只保留另一场');
  eq(out.emptied.length, 0, '该格未被清空');
  eq(out.snapshot.cells['2026-10-29|谷六'], '上午9:00，B027，污水治理', '回读快照已同步');
}

/* ================= 3. 整格清空 ================= */
console.log('\n【3】一格只有一条时，删完要把整格清掉');
{
  const f = makeKd({
    '1|0': '2026年10月29日',
    '1|2': '上午9:00，B027，党组会议',
  });
  const e = engineFor(f);
  const out = await e.remove([{ date: '2026-10-29', leader: '崔三', title: '党组会议', start: '09:00' }]);
  eq(out.removed.length, 1, 'removed 1 条');
  eq(out.emptied.length, 1, '记为已清空');
  eq(cell(f.grid, 1, 2), undefined, '单元格已被清空');
  eq(out.snapshot.cells['2026-10-29|崔三'], undefined, '快照里也不再有这条');
}

/* ================= 4. 找不到就不写 ================= */
console.log('\n【4】云上找不到该登记 → 不删、不写，返回 notFound');
{
  const f = makeKd({
    '1|0': '2026年10月29日',
    '1|5': '上午9:00，B027，污水治理',
  });
  const e = engineFor(f);
  const before = cell(f.grid, 1, 5);
  const out = await e.remove([{ date: '2026-10-29', leader: '谷六', title: '完全不相干的会', start: '15:00' }]);
  eq(out.removed.length, 0, 'removed 0 条');
  eq(out.notFound.length, 1, 'notFound 1 条');
  eq(cell(f.grid, 1, 5), before, '单元格内容未变');
  const wrote = f.calls.filter((c) => c.name === 'sheet.range_data_batch_update');
  eq(wrote.length, 0, '没有发起写操作');
}

/* ================= 5. 12 小时制也能匹配（回归） ================= */
console.log('\n【5】云上写「下午3点」，网页侧 15:00 也能删对（12/24 小时制回归）');
{
  const f = makeKd({
    '1|0': '2026年10月12日',
    '1|2': '下午3点，5楼2号会议室，桂进腾秘书长主持民生实事调度会',
  });
  const e = engineFor(f);
  ok(cellHasEvent(cell(f.grid, 1, 2), { title: '民生实事调度会', start: '15:00' }), '判重能认出这条');
  const out = await e.remove([{ date: '2026-10-12', leader: '崔三', title: '民生实事调度会', start: '15:00' }]);
  eq(out.removed.length, 1, '删掉了');
  eq(cell(f.grid, 1, 2), undefined, '格子已清空');
}

/* ================= 6. 多个格子一次写完 ================= */
console.log('\n【6】跨多个日期/领导时，一次批量提交且互不干扰');
{
  const f = makeKd({
    '1|0': '2026年10月27日',
    '2|0': '2026年10月29日',
    '1|4': '上午9:00，B027，物业例会',
    '1|6': '上午9:00，B027，安全生产会',
    '2|5': '上午9:00，B027，污水治理\n下午14:30，B027，城市更新调度',
  });
  const e = engineFor(f);
  const out = await e.remove([
    { date: '2026-10-27', leader: '杜四', title: '物业例会', start: '09:00' },
    { date: '2026-10-27', leader: '韩七', title: '安全生产会', start: '09:00' },
    { date: '2026-10-29', leader: '谷六', title: '城市更新调度', start: '14:30' },
  ]);
  eq(out.removed.length, 3, '删掉 3 处');
  eq(cell(f.grid, 1, 4), undefined, '杜四那格清空');
  eq(cell(f.grid, 1, 6), undefined, '韩七那格清空');
  eq(cell(f.grid, 2, 5), '上午9:00，B027，污水治理', '谷六那格只删了后一条');
  const wrote = f.calls.filter((c) => c.name === 'sheet.range_data_batch_update');
  eq(wrote.length, 1, '只发了一次批量写入');
  eq(wrote[0].args.range_data.length, 3, '一次写 3 个单元格');
}

/* ================= 7. 不存在的日期/列 ================= */
console.log('\n【7】日期行或领导列不存在时，报 notFound 而不是乱删');
{
  const f = makeKd({ '1|0': '2026年10月29日', '1|5': '上午9:00，B027，污水治理' });
  const e = engineFor(f);
  const out = await e.remove([
    { date: '2026-12-31', leader: '谷六', title: '污水治理', start: '09:00' },
    { date: '2026-10-29', leader: '安一', title: '污水治理', start: '09:00' },
  ]);
  eq(out.removed.length, 0, '一条都没删');
  eq(out.notFound.length, 2, '两条都报 notFound');
  ok(/日期行/.test(out.notFound[0].reason), '缺日期行的原因说明正确', out.notFound[0].reason);
  ok(/这一列/.test(out.notFound[1].reason), '缺领导列的原因说明正确', out.notFound[1].reason);
  eq(cell(f.grid, 1, 5), '上午9:00，B027，污水治理', '原内容未动');
}

/* ================= 8. 空参数不炸 ================= */
console.log('\n【8】空列表 / 脏数据不发起任何写入');
{
  const f = makeKd({ '1|0': '2026年10月29日', '1|5': '上午9:00，B027，污水治理' });
  const e = engineFor(f);
  const out = await e.remove([{ date: '', leader: '', title: '' }, null]);
  eq(out.removed.length, 0, '没有删除');
  eq(f.calls.filter((c) => c.name === 'sheet.range_data_batch_update').length, 0, '没有写操作');
  eq(out.snapshot.cells['2026-10-29|谷六'], '上午9:00，B027，污水治理', '快照照常返回');
}

/* ================= 9. 一格两场会（分号分隔） ================= */
console.log('\n【9】一格塞了两场会：只删命中的那一场');
{
  const CELL = '1. 14:30，在市政府5楼2号会议室，参加严秘调度房地产事项会议；2. 15:45，在市政府3楼会议室，参加扫黑除恶大会。';
  const f = makeKd({ '1|0': '2026年10月28日', '1|4': CELL });
  const e = engineFor(f);
  const out = await e.remove([{ date: '2026-10-28', leader: '杜四', title: '严秘调度房地产事项会议', start: '14:30' }]);
  eq(out.removed.length, 1, '删掉 1 场');
  const left = cell(f.grid, 1, 4);
  ok(/扫黑除恶大会/.test(left), '另一场原样保留', left);
  ok(!/严秘调度/.test(left), '被删的那场确实没了', left);
  ok(!/\n/.test(left), '原来是一行，删完还是一行（没被拆成多行）', JSON.stringify(left));
}

{
  const CELL = '1. 14:30，在市政府5楼2号会议室，参加严秘调度房地产事项会议；2. 15:45，在市政府3楼会议室，参加扫黑除恶大会。';
  const f = makeKd({
    '1|0': '2026年10月28日', '1|4': CELL,
    '1|6': '15:30，在市政府5楼3号会议室，参加桂秘调度书记楼事项会议',
  });
  const e = engineFor(f);
  await e.remove([{ date: '2026-10-28', leader: '杜四', title: '扫黑除恶大会', start: '15:45' }]);
  const left = cell(f.grid, 1, 4);
  ok(/严秘调度/.test(left) && !/扫黑除恶/.test(left), '删第二场时第一场完好', left);
  eq(cell(f.grid, 1, 6), '15:30，在市政府5楼3号会议室，参加桂秘调度书记楼事项会议', '同一天的其它列不受影响');
}

console.log('\n【10】cellHasEvent：一格多场按场判断');
{
  const CELL = '1. 14:30，开会；2. 15:45，开另一个会';
  ok(cellHasEvent(CELL, { title: '开另一个会', start: '15:45' }), '能在第二条里找到');
  ok(!cellHasEvent(CELL, { title: '开另一个会', start: '14:30' }), '时间对不上的不算命中（不能因为同格就认）');
  ok(cellHasEvent(CELL, { title: '开会', start: '14:30' }), '第一条照常命中');
}

console.log(`\n===== 结果：${pass} 项通过，${fail} 项失败 =====`);
process.exit(fail ? 1 : 0);
