/**
 * 「云文档里删掉的会议，日历跟着删」回归测试
 *
 * 规则：
 *   1) 上一份快照里有、这一份里所有列都找不到了 → 先标记（卡片红标），下次检查确认后移除
 *   2) 内容没变（changed=false）也要继续走这一步，否则会永远卡在标记状态（原 bug）
 *   3) 手动「立即读回」= 用户主动确认，一次即删
 *   4) 整张表读成空的 / 领导列消失 / 从没登记过的本地会议 → 一律不删
 *   5) 删掉的会议进可恢复栈，恢复后只留本地、不自动写回云文档
 *
 * 运行：node bridge/cloud_gone_test.mjs
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));

const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
vc.on('error', () => {});

const calls = [];
const STUB = { authed: true, changed: true, cells: {}, cols: [] };

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
    const reply = (obj, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(obj) });
    w.fetch = async (url, opt) => {
      const u = String(url);
      calls.push({ url: u, opt: opt || {} });
      if (u.includes('/api/ping')) {
        return reply({
          ok: true, app: 'meeting-sync-bridge', version: '1.1.0',
          features: ['snapshot', 'push', 'remove', 'report'],
          authed: STUB.authed, tokenExpiresAt: '2026-11-01 10:00',
          doc: { name: '会议安排.xlsx', url: 'https://www.kdocs.cn/l/x' }, loginState: 'idle',
        });
      }
      if (u.includes('/api/snapshot')) {
        return reply({
          ok: true, changed: STUB.changed,
          snapshot: {
            at: new Date().toISOString(),
            cols: STUB.cols.length ? STUB.cols : ['崔三', '杜四', '贺八', '姜九'],
            cells: STUB.cells, source: 'file',
          },
        });
      }
      if (u.includes('/api/push')) {
        const body = JSON.parse(opt.body || '{}');
        return reply({
          ok: true,
          written: (body.items || []).map(x => ({ date: x.date, leader: x.leader, text: x.text })),
          duplicates: [], skipped: [], rowsCreated: [],
          snapshot: { at: new Date().toISOString(), cols: STUB.cols, cells: STUB.cells, source: 'file' },
        });
      }
      if (u.includes('/api/remove')) {
        return reply({ ok: true, removed: [], notFound: [], emptied: [],
          snapshot: { at: new Date().toISOString(), cols: STUB.cols, cells: STUB.cells, source: 'file' } });
      }
      return reply({ ok: true });
    };
  },
});

const w = dom.window;
const doc = w.document;
const countUrl = (frag, since = 0) => calls.slice(since).filter(c => c.url.includes(frag)).length;
await sleep(600);

const COLS = ['崔三', '杜四', '贺八', '姜九'];
w.state.docColumns = COLS.slice();
// 一个永远存在的“背景格”，保证每次读回来的表不是空的
const BG = { '2026-10-31|姜九': '上午9:00，在B027，某局会议' };
const CELL = { '2026-10-30|贺八': '上午9:30，在B615，住保中心全体干部大会' };
const EV = {
  id: 'g1', date: '2026-10-30', start: '09:30', place: 'B615',
  title: '住保中心全体干部大会', type: 'internal',
  leaders: [{ name: '贺八', role: '市住房保障中心主任' }],
  syncedAt: '2026-10-20T00:00:00.000Z', source: 'doc',
};
const resetEv = () => { w.state.events = [clone(EV)]; w.state.cloudGone = []; w.state.trash = []; };
const snapWith = (cells) => ({ at: new Date().toISOString(), cols: COLS.slice(), cells: clone(cells), source: 'test' });

console.log('\n一、云文档里删掉 → 第一次只标记，第二次才删（两段式，防误删）');
resetEv();
w.state.docSnapshot = snapWith({ ...BG, ...CELL });     // 上一次读到的：这条还在
STUB.cells = { ...BG };                                  // 现在云上已经被删了
STUB.changed = true;
let r = await w.rtPullNow(false);
T('第一次读回：会议还在日历里', w.state.events.length === 1, String(w.state.events.length));
T('第一次读回：被打上「待确认」标记', !!w.state.events[0].docGoneAt);
T('第一次读回：还没进恢复栈', w.state.cloudGone.length === 0);
T('读回结果如实报告待确认条数', r && r.goneMarked === 1 && r.gone === 0, JSON.stringify(r && { g: r.gone, m: r.goneMarked }));
T('卡片角标状态是 gone', w.syncStatusOf(w.state.events[0]) === 'gone');

console.log('\n二、内容没变也要继续确认（原 bug：卡在标记状态永远删不掉）');
const beforeLen = w.state.events.length;
STUB.changed = false;                                    // 服务端：云文档这次没变化
r = await w.rtPullNow(false);
T('changed=false 时仍然完成了确认删除', w.state.events.length === beforeLen - 1,
  beforeLen + ' → ' + w.state.events.length);
T('会议已从日历移除', !w.state.events.some(e => e.id === 'g1'));
T('进了可恢复栈', w.state.cloudGone.length === 1 && w.state.cloudGone[0].event.title === EV.title,
  JSON.stringify(w.state.cloudGone.map(g => g.event && g.event.title)));
T('读回结果报告删除条数', r && r.gone === 1, JSON.stringify(r && { g: r.gone }));

console.log('\n三、再读几次不会重复记');
const goneLen = w.state.cloudGone.length;
await w.rtPullNow(false);
T('恢复栈没有重复新增', w.state.cloudGone.length === goneLen, String(w.state.cloudGone.length));

console.log('\n四、手动「立即读回」= 用户主动确认，一次即删');
resetEv();
w.state.docSnapshot = snapWith({ ...BG, ...CELL });
STUB.cells = { ...BG };
STUB.changed = true;
await w.pullFromDoc(null, false);                        // auto=false → force
T('手动读回一次就删掉', w.state.events.length === 0, String(w.state.events.length));
T('同样进恢复栈', w.state.cloudGone.length === 1);

console.log('\n五、绝不误删的几种情况');
resetEv();
w.state.docSnapshot = snapWith({ ...BG, ...CELL });
STUB.cells = {};                                         // 整张表读成空的（接口异常）
STUB.changed = true;
await w.rtPullNow(false);
T('整表读空：不删任何会议', w.state.events.length === 1, String(w.state.events.length));
T('整表读空：不进恢复栈', w.state.cloudGone.length === 0);

resetEv();
w.state.statsMonth = null;
w.state.events = [{
  id: 'local1', date: '2026-11-02', start: '15:00', place: '', title: '本地刚建的会',
  leaders: [{ name: '崔三' }], createdAt: new Date().toISOString(),
}];                                                       // 没有 syncedAt：从没登记过
w.state.docSnapshot = snapWith({ ...BG });
w.state.cloudGone = [];
STUB.cells = { ...BG };
await w.rtPullNow(false);
await w.rtPullNow(false);
T('从没登记过的本地会议不会被删', w.state.events.length === 1 && w.state.events[0].id === 'local1',
  JSON.stringify(w.state.events.map(e => e.id)));

resetEv();
w.state.docSnapshot = snapWith({ ...BG, ...CELL });
STUB.cols = ['崔三', '杜四', '姜九'];                 // 贺八这一列没了（改名/删除列）
STUB.cells = { ...BG };
w.state.docColumns = ['崔三', '杜四', '姜九'];
await w.rtPullNow(false);
await w.rtPullNow(false);
T('领导列不存在时不当成「被删了」', w.state.events.length === 1, String(w.state.events.length));
STUB.cols = [];
w.state.docColumns = COLS.slice();

resetEv();
w.state.events = [{
  id: 'g2', date: '2026-10-30', start: '09:30', place: 'B615', title: '住保中心全体干部大会',
  leaders: [{ name: '贺八' }, { name: '崔三' }],
  syncedAt: '2026-10-20T00:00:00.000Z', source: 'doc',
}];
w.state.docSnapshot = snapWith({
  ...BG,
  '2026-10-30|贺八': CELL['2026-10-30|贺八'],
  '2026-10-30|崔三': '上午9:30，在B615，住保中心全体干部大会',
});
STUB.cells = { ...BG, '2026-10-30|崔三': '上午9:30，在B615，住保中心全体干部大会' };  // 只删了一个人的
await w.rtPullNow(false);
await w.rtPullNow(false);
T('只删了部分参会领导时保留会议', w.state.events.length === 1, String(w.state.events.length));

console.log('\n六、删掉的不会偷偷写回云文档');
resetEv();
w.state.docSnapshot = snapWith({ ...BG, ...CELL });
STUB.cells = { ...BG };
STUB.changed = true;
await w.rtPullNow(false);
await w.rtPullNow(false);
const plan = w.buildSyncPlan(false, false);
T('删除后没有待写入项', plan.items.length === 0, JSON.stringify(plan.items));
let mark = calls.length;
w.saveState();
await sleep(1800);
T('没有向云文档发写入请求', countUrl('/api/push', mark) === 0, String(countUrl('/api/push', mark)));

console.log('\n七、可恢复：回到日历，但不再被自动删/自动写回');
const n = w.restoreCloudGone();
T('恢复成功', n === 1, String(n));
T('恢复后会议回到日历', w.state.events.length === 1 && w.state.events[0].title === EV.title);
T('恢复的会议带 heldLocal 标记', !!w.state.events[0].heldLocal);
T('恢复后清空恢复栈', w.state.cloudGone.length === 0);
await w.rtPullNow(false);
await w.rtPullNow(false);
T('云文档里仍然没有，但不再被删', w.state.events.length === 1, String(w.state.events.length));
T('恢复的会议不会重新排队写入', w.buildSyncPlan(false, false).items.length === 0,
  JSON.stringify(w.buildSyncPlan(false, false).items));

console.log('\n八、卡片 / 面板 UI 如实反映');
resetEv();
w.state.docSnapshot = snapWith({ ...BG, ...CELL });
STUB.cells = { ...BG };
STUB.changed = true;
await w.rtPullNow(false);
w.viewWeekStart = new Date(2026, 9, 26);   // 10 月 30 日所在的那一周
w.renderWeek();
const badge = doc.querySelector('.ev-sync.gone');
T('卡片上出现红色「已删除」角标', !!badge, badge ? badge.className : '没有找到 .ev-sync.gone');
T('角标提示说明了后续动作', !!badge && /下次检查后会自动从日历移除/.test(badge.getAttribute('title') || ''),
  badge ? badge.getAttribute('title') : '');
T('角标文案不再是那个让人看不懂的云朵', !!badge && badge.textContent !== '☁', badge ? badge.textContent : '');

await w.rtPullNow(false);                 // 第二次确认 → 真删
w.openSync(false, false);
const box = doc.querySelector('.sync-gone');
T('同步面板出现「云文档里删掉了 N 场会」区块', !!box);
T('区块里能看到是哪些会', !!box && /住保中心全体干部大会/.test(box.textContent), box ? box.textContent.slice(0, 80) : '');
T('提供恢复按钮', !!doc.querySelector('[data-act="restoreGone"]'));

console.log('\n九、一次消失太多 → 先不删，交给用户确认（防整篇被换掉）');
const many = [];
for (let i = 1; i <= 10; i++) {
  const d = '2026-11-' + String(i).padStart(2, '0');
  many.push({
    id: 'm' + i, date: d, start: '09:00', place: 'B615', title: '测试会议' + i,
    leaders: [{ name: '崔三' }], syncedAt: '2026-10-20T00:00:00.000Z', source: 'doc',
  });
}
const manyCells = {};
many.forEach(x => { manyCells[x.date + '|崔三'] = '上午9:00，在B615，' + x.title; });
w.state.events = clone(many);
w.state.cloudGone = [];
w.state.docSnapshot = snapWith({ ...BG, ...manyCells });
STUB.cells = { ...BG };            // 10 条一起没了
STUB.changed = true;
await w.rtPullNow(false);
T('第一次：10 场全部标记为待确认', w.state.events.filter(e => e.docGoneAt).length === 10,
  String(w.state.events.filter(e => e.docGoneAt).length));
r = await w.rtPullNow(false);
T('超过批量上限时一场都不自动删', w.state.events.length === 10, String(w.state.events.length));
T('结果里报告了被拦下的场次', r && r.goneHeld === 10, JSON.stringify(r && { held: r.goneHeld }));

w.openSync(false, false);
const pendBox = doc.querySelector('.sync-gone.pend');
T('同步面板出现「N 场会在云文档里查不到了」', !!pendBox);
T('面板说明是「为防误删先没动」', !!pendBox && /为防误删先没动/.test(pendBox.textContent));
const purgeBtn = doc.querySelector('[data-act="purgeGone"]');
const holdBtn = doc.querySelector('[data-act="holdGone"]');
T('提供「确认从日历删除」按钮', !!purgeBtn);
T('提供「保留在本地」按钮', !!holdBtn);

console.log('\n十、用户可以自己决定：删掉 或 保留');
holdBtn.click();
T('点「保留在本地」后标记清空', w.state.events.filter(e => e.docGoneAt).length === 0);
T('并打上 heldLocal（以后不再自动删）', w.state.events.every(e => !!e.heldLocal));
await w.rtPullNow(false);
await w.rtPullNow(false);
T('保留之后再读多次也不删', w.state.events.length === 10, String(w.state.events.length));

w.state.events.forEach(e => { e.heldLocal = false; e.docGoneAt = new Date().toISOString(); });
w.openSync(false, false);
const purgeBtn2 = doc.querySelector('[data-act="purgeGone"]');
T('重新出现确认删除按钮', !!purgeBtn2);
purgeBtn2.click();
T('点「确认从日历删除」后全部删掉', w.state.events.length === 0, String(w.state.events.length));
T('删掉的都进了可恢复栈', w.state.cloudGone.length === 10, String(w.state.cloudGone.length));

console.log('\n===== 结果：' + pass + ' 项通过，' + fail + ' 项失败 =====');
w.close();
process.exit(fail ? 1 : 0);
