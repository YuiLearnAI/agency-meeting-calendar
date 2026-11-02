/**
 * 「同步把云文档里删掉的登记又写回去」回归测试
 *
 * 背景：云文档里某条登记被人手工删掉了，网页本地还留着这场会，
 *   一点同步又被写回去——用户看到的现象就是「他明明没这场会，怎么又冒出来了」。
 * 现在的规则：
 *   1) 凡是本站写过的格位，都记一笔（state.marks）
 *   2) 下次同步时，如果快照比这笔记忆新、且该格位是空的 → 判定为「人工删掉了」，不自动写回
 *   3) 快照比记忆旧（还没读到最新云上内容）→ 照常写，不能因为快照过期就漏写
 *   4) 用户明确点「仍然写回」→ ignoreExisting=true，绕过这条保护
 *
 * 运行：node bridge/sync_guard_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const tjsdom = createRequire(path.join(APP, '.tmp', 'noop.js'));
const { JSDOM, VirtualConsole } = tjsdom('jsdom');

let pass = 0, fail = 0;
const T = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   → ' + extra : '')); }
};

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
    if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
  }
});
const w = dom.window;
await new Promise(r => setTimeout(r, 400));

const EV = {
  id: 'e10', date: '2026-10-16', start: '09:00', place: 'B635',
  title: '青年群体专项工作小组第一次全体会议', type: 'dept',
  leaders: [{ name: '贺八' }]
};
const T1 = '2026-10-23T10:00:00.000Z';
const T2 = '2026-10-23T12:00:00.000Z';

console.log('\n一、写入后要记住这个格位');
w.state.events = [JSON.parse(JSON.stringify(EV))];
w.state.docSnapshot = { at: T1, cols: ['崔三', '杜四', '谷六', '韩七', '贺八'], cells: {}, source: 'test' };
w.state.marks = {};
let plan = w.buildSyncPlan(false, false);
T('首次同步：没有记忆，正常待写入', plan.items.length === 1 && plan.items[0].leader === '贺八', JSON.stringify(plan.items.map(x => x.leader)));

w.applyPushResult({
  snapshot: { at: T1, cols: ['崔三', '杜四', '谷六', '韩七', '贺八'], cells: { '2026-10-16|贺八': '上午9:00，B635，青年群体专项工作小组第一次全体会议' } },
  written: [{ date: '2026-10-16', leader: '贺八', text: '上午9:00，B635，青年群体专项工作小组第一次全体会议' }],
  duplicates: [], skipped: [], rowsCreated: []
}, plan);
T('写入后记下了格位记忆', !!(w.state.marks['2026-10-16|贺八']), JSON.stringify(Object.keys(w.state.marks)));
T('记忆里带写入时间', (w.state.marks['2026-10-16|贺八'] || {}).at === T1, JSON.stringify(w.state.marks['2026-10-16|贺八']));

console.log('\n二、云文档里被人删掉后，不能偷偷写回去');
w.state.events[0].syncedAt = null;              // 比如后来改过这场会
w.state.docSnapshot = { at: T2, cols: ['崔三', '杜四', '谷六', '韩七', '贺八'], cells: {}, source: 'test' };
plan = w.buildSyncPlan(false, false);
T('不再进待写入清单', !plan.items.some(x => x.leader === '贺八'), JSON.stringify(plan.items.map(x => x.leader)));
T('被单独识别为「已被删除」', plan.revived.length === 1 && plan.revived[0].leader === '贺八', JSON.stringify(plan.revived.map(x => x.leader)));
T('给出了原因', /删除/.test((plan.revived[0] || {}).reason || ''), (plan.revived[0] || {}).reason);

console.log('\n三、不能因为快照过期就漏写');
w.state.docSnapshot = { at: '2026-10-23T09:00:00.000Z', cols: ['贺八'], cells: {}, source: 'test' };  // 比记忆旧
plan = w.buildSyncPlan(false, false);
T('快照比记忆旧 → 仍按正常待写入处理', plan.items.some(x => x.leader === '贺八'), JSON.stringify(plan.items.map(x => x.leader)));

console.log('\n四、用户明确要求写回时放行');
w.state.docSnapshot = { at: T2, cols: ['贺八'], cells: {}, source: 'test' };
plan = w.buildSyncPlan(false, true);   // ignoreExisting = true
T('ignoreExisting 绕过保护，照写', plan.items.some(x => x.leader === '贺八'), JSON.stringify(plan.items.map(x => x.leader)));
T('此时不再报「已被删除」', plan.revived.length === 0, JSON.stringify(plan.revived));

console.log('\n五、从没写过的格位不受影响');
w.state.marks = {};
w.state.events = [JSON.parse(JSON.stringify(EV))];
w.state.docSnapshot = { at: T2, cols: ['贺八'], cells: {}, source: 'test' };
plan = w.buildSyncPlan(false, false);
T('没有记忆 → 正常写入', plan.items.length === 1 && plan.revived.length === 0, JSON.stringify({ i: plan.items.length, r: plan.revived.length }));

console.log('\n六、云文档里已有别的内容时不误判');
w.state.marks = { '2026-10-16|贺八': { at: T1, title: '别的会', start: '15:00' } };
w.state.docSnapshot = {
  at: T2, cols: ['贺八'], source: 'test',
  cells: { '2026-10-16|贺八': '下午15:00，A702，物业工作例会' }
};
plan = w.buildSyncPlan(false, false);
T('格子里有别的会议 → 当作追加，不当作删除', plan.items.length === 1 && plan.revived.length === 0, JSON.stringify({ i: plan.items.map(x => x.text), r: plan.revived.length }));

console.log('\n七、界面：确认提示与按钮');
w.state.marks = { '2026-10-16|贺八': { at: T1, title: EV.title, start: '09:00' } };
w.state.events = [Object.assign(JSON.parse(JSON.stringify(EV)), { syncedAt: null })];
w.state.docSnapshot = { at: T2, cols: ['崔三', '贺八'], cells: {}, source: 'test' };
w.BRIDGE.online = true;
w.BRIDGE.authed = true;
w.BRIDGE.features = ['snapshot', 'push', 'remove', 'report'];
w.openSync(false, false);
const modalTxt = (w.document.getElementById('modalBody') || {}).textContent || '';
T('同步面板里有「已被删掉」的提示', /云文档里已经查不到/.test(modalTxt), modalTxt.slice(0, 160));
T('面板里给了「仍然写回」按钮', !!(w.document.querySelector('#modalBody [data-act="forceWrite"]')));
T('待写入清单里没有这条', !/青年群体专项工作小组/.test(modalTxt.split('云文档里已经查不到')[0] || ''));

console.log('\n八、同步状态按钮（UI 回归）');
const chip = w.document.getElementById('bridgeChip');
T('同步状态是按钮（和其它功能栏同一套外观）', chip.tagName === 'BUTTON', chip.tagName);
T('状态文案不带「○」「●」符号', !/[○●]/.test(chip.textContent || ''), chip.textContent);
w.BRIDGE.online = false;
w.BRIDGE.checked = true;
w.renderRtChip();
T('未连接时文案是「同步服务未启动」', (chip.textContent || '') === '同步服务未启动', chip.textContent);
T('未连接时有 off 样式', /rt-chip/.test(chip.className) && /off/.test(chip.className), chip.className);
w.BRIDGE.online = true; w.BRIDGE.authed = true;
w.renderRtChip();
T('已连接且实时开启时显示「实时同步中」', /实时同步中/.test(chip.textContent || ''), chip.textContent);
T('已连接时有 on 样式（绿点）', /rt-chip/.test(chip.className) && /on/.test(chip.className), chip.className);
w.BRIDGE.authed = false;
w.renderRtChip();
T('服务在线但未登录时提示登录', /登录金山文档/.test(chip.textContent || ''), chip.textContent);
const cssTxt = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
T('自定义细滚动条样式存在', /::-webkit-scrollbar-thumb/.test(cssTxt));
T('滚动条默认半透明、hover 加深', /scrollbar-thumb:hover/.test(cssTxt));
T('统计明细层样式存在', /\.fpop\{/.test(cssTxt));

console.log('\n九、旧版「一格两场会」错记录的自动纠正');
{
  // 老版本把「1. 14:30 甲会；2. 15:45 乙会」并成了一场：时间取了 14:30、名字取了乙会
  const CELL = '1. 14:30，在市政府5楼2号会议室，参加严秘调度房地产事项会议；2. 15:45，在市政府3楼会议室，参加扫黑除恶大会。';
  w.state.docSnapshot = {
    at: '2026-10-28T10:00:00.000Z', cols: ['杜四', '韩七'], source: 'test',
    cells: { '2026-10-28|杜四': CELL }
  };
  w.state.events = [
    // 旧解析留下的错记录
    { id: 'bad1', date: '2026-10-28', start: '14:30', place: '市政府5楼2号会议室', title: '扫黑除恶大会', type: 'city', leaders: [{ name: '杜四' }], source: 'doc', syncedAt: 'x' },
    // 用户自己手动加的，不该被动
    { id: 'man1', date: '2026-10-28', start: '09:00', place: 'B027', title: '自己记的一场会', type: 'dept', leaders: [{ name: '杜四' }], source: 'manual' },
  ];
  const n = w.pruneStaleDocEvents(w.state.docSnapshot);
  T('清掉了 1 条旧错记录', n === 1, '实际 ' + n);
  T('错记录已不在日历里', !w.state.events.some(e => e.id === 'bad1'), JSON.stringify(w.state.events.map(e => e.title)));
  T('手动添加的记录不受影响', w.state.events.some(e => e.id === 'man1'));

  // 纠正后重新读回，应该得到正确的两条
  const list = w.cellsToEvents(w.state.docSnapshot);
  const got = list.filter(x => x.date === '2026-10-28').map(x => x.start + '|' + x.title);
  T('重解析得到两场会', got.length === 2, JSON.stringify(got));
  T('14:30 是严秘调度', got.some(s => s.indexOf('14:30|') === 0 && /严秘调度/.test(s)), JSON.stringify(got));
  T('15:45 是扫黑除恶', got.some(s => s.indexOf('15:45|') === 0 && /扫黑除恶/.test(s)), JSON.stringify(got));

  // 解析不出内容的格位不能误删（不然一读回就把记录清空了）
  w.state.docSnapshot = {
    at: '2026-10-30T10:00:00.000Z', cols: ['杜四'], source: 'test',
    cells: { '2026-10-29|杜四': '调出' }
  };
  w.state.events = [
    { id: 'keep1', date: '2026-10-29', start: '09:00', place: 'B027', title: '某场会', type: 'dept', leaders: [{ name: '杜四' }], source: 'doc' },
  ];
  const n2 = w.pruneStaleDocEvents(w.state.docSnapshot);
  T('状态格（调出）不会触发清理', n2 === 0 && w.state.events.length === 1, '删了 ' + n2);
}

console.log('\n' + (fail ? `❌ 失败 ${fail} 项 / 共 ${pass + fail} 项` : `✅ 全部 ${pass} 项通过`));
process.exit(fail ? 1 : 0);
