/**
 * 「改了会议的时间 / 地点，云同步却不开始」回归测试
 *
 * 两个真实报障：
 *   1) 在会议详情里改了开始时间和地点，云文档一直没变，界面也不提示待同步。
 *   2) 同一格位以前写过东西、后来云端空了，于是这场会永远写不回去。
 *
 * 根因：
 *   · cellHasEvent 只比「标题 + 时间」，而且云端那段没写时间时只看标题
 *     → 改地点、或云端是「只知道会名」的粗登记，都被当成「云文档已有」，进 dups 直接跳过。
 *   · 待同步角标用 syncStatusOf === 'doc' 排除，于是连「待同步」都不显示。
 *   · marks 记录的是「这个格位写过」，且没存标题/时间/地点
 *     → 改过之后再写回，被「云文档里这条被人工删了，不写回」的保护逻辑挡住。
 *   · 先写新、后撤旧：新内容因去重没写进去时，旧的那段照样被删 → 格子里什么都没有。
 *
 * 运行：node bridge/edit_sync_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createEngine } from './sheet-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');

let pass = 0, fail = 0;
const T = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   → ' + extra : '')); }
};

/* ============================================================
 * 一、服务端写入引擎：同一场会改过时间/地点时「就地替换」，不追加
 * ============================================================ */
function makeKd(init) {
  const grid = new Map(Object.entries(init || {}));
  const HEAD = { 0: '日期', 1: '星期', 2: '崔三', 3: '姜九', 4: '杜四', 5: '谷六', 6: '韩七', 7: '贺八' };
  for (const [c, v] of Object.entries(HEAD)) grid.set(`0|${c}`, v);
  const kd = {
    async call(name, args) {
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
  return { kd, grid };
}
const engineFor = (f) => createEngine({ kd: f.kd, sheet: { fileId: 'F1', url: 'u', name: 'n' }, snapshotPath: null });
const CELL_LIU = 4;   // 杜四在第 4 列

console.log('\n一、服务端：改过时间/地点的同一场会，替换原来那段而不是追加一条');
{
  // 云端是旧版：15:00、B027；本地改成 14:15、B635
  const f = makeKd({ '1|0': '2026年10月27日', [`1|${CELL_LIU}`]: '下午15:00，B027，四季度经济形势调研座谈会' });
  const eng = engineFor(f);
  const out = await eng.push([{
    date: '2026-10-27', leader: '杜四',
    text: '下午14:15，B635，四季度经济形势调研座谈会',
    title: '四季度经济形势调研座谈会', start: '14:15', place: 'B635', updated: true,
  }], {});
  const cell = f.grid.get(`1|${CELL_LIU}`) || '';
  T('写入 1 处（不是当重复跳过）', out.written.length === 1 && out.duplicates.length === 0, JSON.stringify(out));
  T('标记为「替换」', out.replaced && out.replaced.length === 1, JSON.stringify(out.replaced));
  T('格子里只剩新版一条', cell === '下午14:15，B635，四季度经济形势调研座谈会', JSON.stringify(cell));
  T('旧的时间地点没残留', cell.indexOf('15:00') < 0 && cell.indexOf('B027') < 0, JSON.stringify(cell));
}

{
  // 云端是旧版，但页面没标 updated（兜底：只要内容不一样就替换，别追加）
  const f = makeKd({ '1|0': '2026年10月27日', [`1|${CELL_LIU}`]: '下午15:00，B027，四季度经济形势调研座谈会' });
  const eng = engineFor(f);
  await eng.push([{
    date: '2026-10-27', leader: '杜四',
    text: '下午14:15，B027，四季度经济形势调研座谈会',
    title: '四季度经济形势调研座谈会', start: '14:15', place: 'B027',
  }], {});
  const cell = f.grid.get(`1|${CELL_LIU}`) || '';
  T('没标 updated 也替换，不会新旧两条并存', cell === '下午14:15，B027，四季度经济形势调研座谈会', JSON.stringify(cell));
}

{
  // 内容一模一样 → 仍然算重复，不重复写
  const text = '下午14:15，B027，四季度经济形势调研座谈会';
  const f = makeKd({ '1|0': '2026年10月27日', [`1|${CELL_LIU}`]: text });
  const eng = engineFor(f);
  const out = await eng.push([{
    date: '2026-10-27', leader: '杜四', text,
    title: '四季度经济形势调研座谈会', start: '14:15', place: 'B027',
  }], {});
  T('内容一致 → 判重复、不写', out.written.length === 0 && out.duplicates.length === 1, JSON.stringify(out));
  T('格子里还是一条', (f.grid.get(`1|${CELL_LIU}`) || '').split('\n').length === 1);
}

{
  // 同格多场会：只替换命中的那一场，另一场原样保留
  const old = '上午9:30，B801，局党组会议\n下午15:00，B027，四季度经济形势调研座谈会';
  const f = makeKd({ '1|0': '2026年10月27日', [`1|${CELL_LIU}`]: old });
  const eng = engineFor(f);
  await eng.push([{
    date: '2026-10-27', leader: '杜四',
    text: '下午16:40，B635，四季度经济形势调研座谈会',
    title: '四季度经济形势调研座谈会', start: '16:40', place: 'B635', updated: true,
  }], {});
  const cell = f.grid.get(`1|${CELL_LIU}`) || '';
  T('另一场会保留', cell.indexOf('上午9:30，B801，局党组会议') >= 0, JSON.stringify(cell));
  T('命中的那场换成了新版', cell.indexOf('下午16:40，B635，四季度经济形势调研座谈会') >= 0, JSON.stringify(cell));
  T('没留下旧版', cell.indexOf('下午15:00') < 0, JSON.stringify(cell));
  T('还是两行', cell.split('\n').length === 2, JSON.stringify(cell));
}

{
  // 云文档里是「只知道会名」的粗登记（没写时间，也没写地点）
  const f = makeKd({ '1|0': '2026年10月27日', [`1|${CELL_LIU}`]: '四季度经济形势调研座谈会' });
  const eng = engineFor(f);
  const out = await eng.push([{
    date: '2026-10-27', leader: '杜四',
    text: '下午14:15，B027，四季度经济形势调研座谈会',
    title: '四季度经济形势调研座谈会', start: '14:15', place: 'B027',
  }], {});
  const cell = f.grid.get(`1|${CELL_LIU}`) || '';
  T('粗登记也能补全时间和地点', cell === '下午14:15，B027，四季度经济形势调研座谈会', JSON.stringify(cell));
  T('没有写成一格两条', out.written.length === 1 && cell.split('\n').length === 1, JSON.stringify(out.written));
}

/* ============================================================
 * 二、页面侧：判断「要不要写回」「卡片角标」「保护逻辑别误伤」
 * ============================================================ */
const tjsdom = createRequire(path.join(APP, '.tmp', 'noop.js'));
const { JSDOM, VirtualConsole } = tjsdom('jsdom');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
vc.on('error', () => {});
const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:7788/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(w) {
    w.localStorage.setItem('ytzj_doc_history_imported_v1', '1');
    w.localStorage.setItem('ytzj_kw_patch_v2', '1');
    w.confirm = () => true;
    w.alert = () => {};
    if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
  }
});
const w = dom.window;
await new Promise(r => setTimeout(r, 400));

const COLS = ['崔三', '姜九', '杜四', '谷六', '韩七', '贺八'];
const T1 = '2026-10-26T01:00:00.000Z';
const T2 = '2026-10-26T03:00:00.000Z';
const TITLE = '四季度经济形势调研座谈会';

function reset(opts) {
  const o = opts || {};
  w.state.leaders = [{ name: '杜四', title: '党组成员、副局长' }, { name: '崔三', title: '一级调研员' }];
  w.state.events = [{
    id: 'e27', date: '2026-10-27', start: '14:15', place: 'B027', title: TITLE,
    type: 'city', leaders: [{ name: '杜四' }], note: '', createdAt: T1,
  }];
  w.state.trash = [];
  w.state.marks = o.marks || {};
  w.state.docSnapshot = {
    at: o.at || T2, cols: COLS, cells: o.cells || {}, source: 'test',
  };
  w.state.docColumns = COLS;
}

console.log('\n二、改写后必须重新写回（以前会被「云文档已有」吞掉）');
{
  reset({ cells: { '2026-10-27|杜四': '下午15:00，B027，' + TITLE } });
  const plan = w.buildSyncPlan(false, false);
  T('只改了时间 → 进入待写入', plan.items.length === 1 && plan.items[0].updated === true, JSON.stringify(plan.items));
  T('不再当成重复', plan.dups.length === 0, JSON.stringify(plan.dups));
}
{
  reset({ cells: { '2026-10-27|杜四': '下午14:15，B635，' + TITLE } });
  const plan = w.buildSyncPlan(false, false);
  T('只改了地点 → 进入待写入', plan.items.length === 1 && plan.items[0].updated === true, JSON.stringify(plan.items));
}
{
  reset({ cells: { '2026-10-27|杜四': TITLE } });
  const plan = w.buildSyncPlan(false, false);
  T('云端只写了会名（没时间地点）→ 也要补写', plan.items.length === 1 && plan.items[0].updated === true, JSON.stringify(plan.items));
}
{
  reset({ cells: { '2026-10-27|杜四': '下午14:15，B027，' + TITLE } });
  const plan = w.buildSyncPlan(false, false);
  T('内容和云端完全一致 → 判重复，不重复写', plan.items.length === 0 && plan.dups.length === 1, JSON.stringify(plan));
}

console.log('\n三、卡片角标：改过的会要显示「待更新」，不能显示「已同步 ✓」');
{
  reset({ cells: { '2026-10-27|杜四': '下午14:15，B027，' + TITLE } });
  T('一致 → doc（✓）', w.syncStatusOf(w.state.events[0]) === 'doc');
}
{
  reset({ cells: { '2026-10-27|杜四': '下午15:00，B027，' + TITLE } });
  T('时间改过 → stale（⟳）', w.syncStatusOf(w.state.events[0]) === 'stale', w.syncStatusOf(w.state.events[0]));
}
{
  reset({ cells: { '2026-10-27|杜四': '下午14:15，B635，' + TITLE } });
  T('地点改过 → stale（⟳）', w.syncStatusOf(w.state.events[0]) === 'stale', w.syncStatusOf(w.state.events[0]));
  T('并且算进待同步队列（角标会亮）', w.pendingEvents().length === 1, String(w.pendingEvents().length));
}
{
  // 角标图标真的画出来了
  reset({ cells: { '2026-10-27|杜四': '下午15:00，B027，' + TITLE } });
  w.viewWeekStart = new Date(2026, 9, 26);   // 把视图钉在事件所在周（10-26 周一），否则默认当前周渲染不出卡片
  w.renderWeek();
  const ico = w.document.querySelector('.ev .ev-sync');
  T('卡片上出现 ⟳ 角标', !!ico && ico.textContent === '⟳' && ico.className.indexOf('stale') >= 0,
    ico ? ico.className + ' ' + ico.textContent : '无角标');
}

console.log('\n四、「人工删掉就别写回」的保护不能被改会这件事误伤');
{
  // 云端该格空了，但上次写进去的就是「这条会」（标题时间地点全同）→ 认作人工删除，不写回
  reset({
    cells: {},
    marks: { '2026-10-27|杜四': { at: T1, title: TITLE, start: '14:15', place: 'B027' } },
  });
  w.state.events[0].createdAt = '2026-10-25T00:00:00.000Z';
  const plan = w.buildSyncPlan(false, false);
  T('确实是人工删掉的那一条 → 仍然不写回', plan.revived.length === 1 && plan.items.length === 0, JSON.stringify(plan));
}
{
  // 同一格位以前写过，但本地后来把时间改了 → 必须写回
  reset({
    cells: {},
    marks: { '2026-10-27|杜四': { at: T1, title: TITLE, start: '15:00', place: 'B027' } },
  });
  w.state.events[0].createdAt = '2026-10-25T00:00:00.000Z';
  const plan = w.buildSyncPlan(false, false);
  T('改过时间 → 不被「人工删除」挡住，正常写回', plan.items.length === 1 && plan.revived.length === 0, JSON.stringify(plan));
}
{
  // 同一格位以前写过，但本地把地点改了
  reset({
    cells: {},
    marks: { '2026-10-27|杜四': { at: T1, title: TITLE, start: '14:15', place: 'B635' } },
  });
  w.state.events[0].createdAt = '2026-10-25T00:00:00.000Z';
  const plan = w.buildSyncPlan(false, false);
  T('改过地点 → 正常写回', plan.items.length === 1 && plan.revived.length === 0, JSON.stringify(plan));
}
{
  // 同一格位以前写过别的会，现在换了一场全新的会
  reset({
    cells: {},
    marks: { '2026-10-27|杜四': { at: T1, title: '局党组会议', start: '09:00', place: 'B801' } },
  });
  w.state.events[0].createdAt = '2026-10-25T00:00:00.000Z';
  const plan = w.buildSyncPlan(false, false);
  T('换了一场会 → 正常写回', plan.items.length === 1 && plan.revived.length === 0, JSON.stringify(plan));
}
{
  // 老版本留下的标记没有标题（历史数据）→ 保守按「同一条」处理
  reset({ cells: {}, marks: { '2026-10-27|杜四': { at: T1, title: '', start: '' } } });
  w.state.events[0].createdAt = '2026-10-25T00:00:00.000Z';
  const plan = w.buildSyncPlan(false, false);
  T('老标记（没存内容）→ 保守不写回', plan.revived.length === 1, JSON.stringify(plan));
}
{
  // 云文档被删之后又新建了一场会（createdAt 晚于标记时间）→ 属于新会，要写
  reset({ cells: {}, marks: { '2026-10-27|杜四': { at: T1, title: TITLE, start: '14:15', place: 'B027' } } });
  w.state.events[0].createdAt = T2;
  const plan = w.buildSyncPlan(false, false);
  T('标记之后新建的会 → 正常写回', plan.items.length === 1 && plan.revived.length === 0, JSON.stringify(plan));
}

console.log('\n五、格位记忆要记住「写进去的是哪一场会」');
{
  reset({ cells: {} });
  const plan = w.buildSyncPlan(false, false);
  const text = '下午14:15，B027，' + TITLE;
  w.applyPushResult({
    snapshot: { at: T2, cols: COLS, cells: { '2026-10-27|杜四': text } },
    written: [{ date: '2026-10-27', leader: '杜四', text }],
    duplicates: [], skipped: [], rowsCreated: [],
  }, plan);
  const mk = w.state.marks['2026-10-27|杜四'];
  T('记下了标题', mk && mk.title === TITLE, JSON.stringify(mk));
  T('记下了开始时间', mk && mk.start === '14:15', JSON.stringify(mk));
  T('记下了地点', mk && mk.place === 'B027', JSON.stringify(mk));
}

{
  // 主动撤下旧登记之后，这个格位的记忆要作废，否则改过的会永远写不回去
  reset({});
  w.state.marks = { '2026-10-27|杜四': { at: T1, title: TITLE, start: '14:15', place: 'B027' } };
  w.state.trash = [{ id: 'tr_x', reason: 'edited', date: '2026-10-27', leaders: ['杜四'], title: TITLE, start: '14:15', place: 'B027' }];
  w.applyRemoveResult(
    { removed: [{ date: '2026-10-27', leader: '杜四' }], notFound: [], emptied: [] },
    [{ trashId: 'tr_x', date: '2026-10-27', leader: '杜四' }]
  );
  T('撤下旧登记后，格位记忆一并清掉', !w.state.marks['2026-10-27|杜四'], JSON.stringify(w.state.marks));
  T('待清理记录也出队', w.state.trash.length === 0, JSON.stringify(w.state.trash));
}

console.log('\n六、轮询读回时，别把「改之前」的旧登记又收成一场新会');
{
  reset({ cells: { '2026-10-27|杜四': '下午15:00，B027，' + TITLE } });
  w.state.trash = [{ id: 'tr_e', reason: 'edited', date: '2026-10-27', leaders: ['杜四'], title: TITLE, start: '15:00', place: 'B027' }];
  const list = w.cellsToEvents(w.state.docSnapshot);
  const r = w.mergeDocEvents(list, w.state.docSnapshot);
  T('没有多出一场 15:00 的旧会', w.state.events.length === 1, JSON.stringify(w.state.events.map(e => e.start + ' ' + e.title)));
  T('新增数为 0', r.added === 0, JSON.stringify(r));
  T('本地改过的会没被标成「已同步」', !w.state.events[0].syncedAt, String(w.state.events[0].syncedAt));
}
{
  // 没有「改过」记录时，云端同名不同时间的会仍按新会收进来（不能被上面的保护误伤）
  reset({ cells: { '2026-10-27|杜四': '下午15:00，B027，' + TITLE } });
  w.state.trash = [];
  const list = w.cellsToEvents(w.state.docSnapshot);
  w.mergeDocEvents(list, w.state.docSnapshot);
  T('云端另一场同名会照常收进来', w.state.events.length === 2, JSON.stringify(w.state.events.map(e => e.start)));
}
{
  // 只改了地点：读回不能把本地的新地点盖回旧地点，也不能标成已同步
  reset({ cells: { '2026-10-27|杜四': '下午14:15，B635，' + TITLE } });
  w.state.trash = [{ id: 'tr_p', reason: 'edited', date: '2026-10-27', leaders: ['杜四'], title: TITLE, start: '14:15', place: 'B635' }];
  const list = w.cellsToEvents(w.state.docSnapshot);
  w.mergeDocEvents(list, w.state.docSnapshot);
  T('本地新地点没被旧地点覆盖', w.state.events[0].place === 'B027', w.state.events[0].place);
  T('没被标成已同步（还要写回）', !w.state.events[0].syncedAt);
}
{
  // 从云文档来的会（source='doc'）改过之后，不能被「旧记录纠正」删掉
  reset({ cells: { '2026-10-27|杜四': '下午14:15，B027，局党组会议' } });
  w.state.events = [{
    id: 'e_old', date: '2026-10-27', start: '16:00', place: 'B801', title: '局党组会议',
    type: 'internal', leaders: [{ name: '杜四' }], note: '', syncedAt: null, source: 'doc', createdAt: T1,
  }];
  w.state.trash = [{ id: 'tr_o', reason: 'edited', date: '2026-10-27', leaders: ['杜四'], title: '局党组会议', start: '16:00', place: 'B801' }];
  const removed = w.pruneStaleDocEvents(w.state.docSnapshot);
  T('改过的云端来源记录不被纠正删除', removed === 0 && w.state.events.length === 1, String(removed));
}

console.log('\n七、同步顺序：先撤旧登记，再写新内容');
{
  reset({ cells: { '2026-10-27|杜四': '下午15:00，B027，' + TITLE } });
  w.state.trash = [{ id: 'tr_e', reason: 'edited', date: '2026-10-27', leaders: ['杜四'], title: TITLE, start: '15:00', place: 'B027' }];
  w.state.rt = { enabled: true, write: true, read: true, drop: false, interval: 30000 };
  w.BRIDGE.online = true; w.BRIDGE.authed = true;
  w.BRIDGE.features = ['snapshot', 'push', 'remove', 'report', 'extract', 'watch', 'state'];
  const order = [];
  const NEW_TEXT = '下午14:15，B027，' + TITLE;
  w.bridgeFetch = function (p) {
    order.push(p);
    if (p === '/api/remove') {
      return Promise.resolve({ removed: [{ date: '2026-10-27', leader: '杜四' }], notFound: [], emptied: [] });
    }
    if (p === '/api/push') {
      return Promise.resolve({
        written: [{ date: '2026-10-27', leader: '杜四', text: NEW_TEXT }],
        duplicates: [], skipped: [], rowsCreated: [],
        snapshot: { at: T2, cols: COLS, cells: { '2026-10-27|杜四': NEW_TEXT } },
      });
    }
    if (p.indexOf('/api/state') === 0) return Promise.resolve({ ok: true, entries: [] });
    return Promise.resolve({ ok: true });
  };
  w.RT.pushing = false;
  await w.rtPushNow(false);
  const iRm = order.indexOf('/api/remove');
  const iPush = order.indexOf('/api/push');
  T('两个请求都发了', iRm >= 0 && iPush >= 0, JSON.stringify(order));
  T('先 remove 后 push', iRm >= 0 && iPush >= 0 && iRm < iPush, JSON.stringify(order));
  T('写完这场会标成已同步', !!w.state.events[0].syncedAt, String(w.state.events[0].syncedAt));
  T('待清理队列已清空', w.state.trash.length === 0, JSON.stringify(w.state.trash));
  T('格位记忆更新成新版', (w.state.marks['2026-10-27|杜四'] || {}).start === '14:15', JSON.stringify(w.state.marks));
}

console.log('\n八、老格位记忆一次性作废：否则「改过的会」永远写不回去');
{
  reset({});
  w.state.marksMigrated = 0;
  w.state.marks = {
    '2026-10-27|杜四': { at: T1, start: '' },                                    // 老数据：没存是哪个会
    '2026-10-28|杜四': { at: T1, title: '局党组会议', start: '09:00', place: 'B801' },
  };
  const n = w.migrateOldMarks();
  T('作废了 1 条没法判断的旧标记', n === 1, String(n));
  T('记了完整信息的保留', !!w.state.marks['2026-10-28|杜四'], JSON.stringify(Object.keys(w.state.marks)));
  T('迁移只跑一次', w.migrateOldMarks() === 0);
}

/* ---------------- 汇总 ---------------- */
console.log('\n' + (fail ? '❌' : '✅') + ' 共 ' + (pass + fail) + ' 项：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
