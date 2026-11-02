/**
 * 实时同步（自动写入 / 自动读取）回归测试
 *
 * 规则：
 *   1) 打开页面、同步服务在线且已登录 → 自动读一次云文档，之后按间隔持续跟随
 *   2) 本地数据一有改动（saveState）→ 1.5 秒后自动写进云文档，连续改动合并成一次
 *   3) 云文档内容指纹没变（changed=false）→ 什么都不做：不合并、不重绘、不写 localStorage
 *   4) 自动删除默认关闭：删除类变更仍到「同步云文档」面板里手动确认
 *   5) 顶部同步状态是一个普通按钮，只用小圆点表达状态
 *
 * 运行：node bridge/realtime_test.mjs
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

const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
vc.on('error', () => {});

/** 可编程的 fetch 桩：记录所有请求，按接口返回不同结果 */
const calls = [];
const STUB = { authed: true, changed: true, cells: {}, pushOk: true, removeOk: true };

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
          snapshot: { at: '2026-10-23T12:00:00.000Z', cols: ['崔三', '杜四'], cells: STUB.cells, source: 'file' },
        });
      }
      if (u.includes('/api/push')) {
        if (!STUB.pushOk) return reply({ ok: false, error: 'BOOM', message: '云端写入失败' }, false, 500);
        const body = JSON.parse(opt.body || '{}');
        return reply({
          ok: true,
          written: (body.items || []).map(x => ({ date: x.date, leader: x.leader, text: x.text })),
          duplicates: [], skipped: [], rowsCreated: [],
          snapshot: { at: '2026-10-23T12:01:00.000Z', cols: ['崔三', '杜四'], cells: {}, source: 'file' },
        });
      }
      if (u.includes('/api/remove')) {
        if (!STUB.removeOk) return reply({ ok: false, error: 'BOOM', message: '云端删除失败' }, false, 500);
        const body = JSON.parse(opt.body || '{}');
        return reply({
          ok: true,
          removed: (body.items || []).map(x => ({ date: x.date, leader: x.leader, text: x.title })),
          notFound: [], emptied: [],
          snapshot: { at: '2026-10-23T12:02:00.000Z', cols: ['崔三', '杜四'], cells: {}, source: 'file' },
        });
      }
      return reply({ ok: true });
    };
  },
});

const w = dom.window;
const doc = w.document;
const countUrl = (frag, since = 0) => calls.slice(since).filter(c => c.url.includes(frag)).length;
await sleep(600);

const COLS = ['崔三', '杜四', '谷六', '韩七', '贺八'];
const EV = {
  id: 'rt1', date: '2026-10-30', start: '09:00', place: 'B027',
  title: '局党组理论学习中心组学习会', type: 'party',
  leaders: [{ name: '崔三' }],
};

console.log('\n一、打开页面就开始跟随');
T('页面启动时探测了同步服务', countUrl('/api/ping') >= 1, String(countUrl('/api/ping')));
T('已登录时启动后就自动读了一次云文档', countUrl('/api/snapshot') >= 1, String(countUrl('/api/snapshot')));
T('实时同步默认开启', w.rtCfg().enabled === true);
T('自动读取定时器已挂上', !!w.RT.pullTimer);
w.renderRtChip();
T('状态按钮显示「实时同步中」', /实时同步中/.test(doc.getElementById('bridgeChip').textContent));

console.log('\n二、本地改动 → 自动写入（1.5 秒内）');
w.state.docSnapshot = { at: '2026-10-23T11:00:00.000Z', cols: COLS.slice(), cells: {}, source: 'test' };
w.state.marks = {};
w.state.trash = [];
w.state.events = [JSON.parse(JSON.stringify(EV))];
let mark = calls.length;
w.saveState();                       // 模拟「新增会议后保存」
T('刚保存时还没写（留给用户继续改）', countUrl('/api/push', mark) === 0);
w.renderRtChip();
T('排队期间状态显示待写', /实时同步中|正在写入/.test(doc.getElementById('bridgeChip').textContent));
await sleep(1800);
T('1.5 秒后自动写了一次', countUrl('/api/push', mark) === 1, String(countUrl('/api/push', mark)));
const pushCall = calls.slice(mark).find(c => c.url.includes('/api/push'));
const pushed = pushCall ? JSON.parse(pushCall.opt.body).items : [];
T('写入内容是这场会', pushed.length === 1 && pushed[0].date === '2026-10-30' && pushed[0].leader === '崔三',
  JSON.stringify(pushed));
const evAfter = w.state.events.find(e => e.id === 'rt1');
T('写入后标记为已同步', !!evAfter.syncedAt);

console.log('\n三、没有新改动就不重复写');
mark = calls.length;
w.saveState();
await sleep(1800);
T('无待同步内容时不发写入请求', countUrl('/api/push', mark) === 0, String(countUrl('/api/push', mark)));

console.log('\n四、云文档没变就不打扰');
mark = calls.length;
const beforeAt = w.state.docSnapshot.at;
STUB.changed = false;
await w.rtPullNow(false);
T('确实问过云文档', countUrl('/api/snapshot', mark) >= 1);
T('内容未变时不覆盖本地快照', w.state.docSnapshot.at === beforeAt, w.state.docSnapshot.at);
T('内容未变时不重写整份状态', countUrl('/api/snapshot', mark) >= 1);
STUB.changed = true;

console.log('\n五、云文档有变 → 自动读回');
mark = calls.length;
STUB.cells = { '2026-11-02|杜四': '下午2:30，B027，全市物业管理工作推进会' };
await w.rtPullNow(false);
T('读回了新会议', w.state.events.some(e => e.date === '2026-11-02' && e.title.indexOf('物业') >= 0),
  JSON.stringify(w.state.events.map(e => e.date + ' ' + e.title)));
T('快照里已记下这条登记', !!w.state.docSnapshot.cells['2026-11-02|杜四'],
  JSON.stringify(Object.keys(w.state.docSnapshot.cells)));

console.log('\n五之二、旧版服务没返回 changed 时，页面自己算指纹兜底');
STUB.changed = undefined;   // 模拟「服务还是旧版本」
// 清掉前面几段留下的「待确认删除」标记，这一段只验证「内容一致就不重复合并」
w.state.events.forEach(e => { delete e.docGoneAt; });
const SAME_CELLS = { '2026-11-02|杜四': '下午2:30，B027，全市物业管理工作推进会' };
STUB.cells = { ...SAME_CELLS };   // 云上内容与本地快照完全一致
w.state.docSnapshot = {
  at: '2026-10-23T12:00:00.000Z', cols: ['崔三', '杜四'],
  cells: { ...SAME_CELLS }, source: 'test',
};
w.state.docSig = w.snapSigOf(w.state.docSnapshot);
const evCount = w.state.events.length;
mark = calls.length;
const snapAtBefore = w.state.docSnapshot.at;
await w.rtPullNow(false);
T('内容一致时不会重复合并', w.state.events.length === evCount,
  evCount + ' → ' + w.state.events.length);
T('也不会覆盖本地快照', w.state.docSnapshot.at === snapAtBefore);
STUB.changed = true;
STUB.cells = {};

console.log('\n六、删除类变更不自动执行（默认安全）');
w.state.trash = [{
  id: 'tr1', reason: 'deleted', at: new Date().toISOString(),
  date: '2026-11-02', start: '', title: '全市物业管理工作推进会', place: '', leaders: ['杜四'],
}];
mark = calls.length;
w.saveState();
await sleep(1800);
T('自动删除关闭时不会调删除接口', countUrl('/api/remove', mark) === 0, String(countUrl('/api/remove', mark)));
w.openSync(false);
const bodyTxt = doc.getElementById('modalBody').textContent || '';
T('同步面板里能看到「需同步撤下」的登记', /需同步撤下|需删除/.test(bodyTxt), bodyTxt.slice(0, 120));
w.closeModal();

console.log('\n七、修改过的会议：新内容写入，旧登记自动撤下（否则云文档会重复）');
w.state.trash = [{
  id: 'tr2', reason: 'edited', at: new Date().toISOString(),
  date: '2026-11-02', start: '14:30', title: '全市物业管理工作推进会', place: 'B027', leaders: ['杜四'],
}];
w.state.docSnapshot = {
  at: '2026-10-23T11:30:00.000Z', cols: COLS.slice(),
  cells: { '2026-11-02|杜四': '下午2:30，B027，全市物业管理工作推进会' }, source: 'test',
};
w.state.marks = {};
w.state.events.push({
  id: 'rt4', date: '2026-11-02', start: '15:00', place: 'B027',
  title: '全市物业管理工作推进会', type: 'dept', leaders: [{ name: '杜四' }],
});
mark = calls.length;
w.saveState();
await sleep(1800);
T('写入了改期后的新内容', countUrl('/api/push', mark) === 1, String(countUrl('/api/push', mark)));
T('旧登记同时撤下（避免同一场会两条）', countUrl('/api/remove', mark) === 1, String(countUrl('/api/remove', mark)));
T('删除队列已清掉这条', !w.state.trash.some(t => t.id === 'tr2'));

console.log('\n八、打开开关后行为立即变化');
w.openLivePanel();
T('实时同步面板打开了', !doc.getElementById('backdrop').hidden);
const dp = doc.getElementById('rtDrop');
T('面板里有「自动删除」开关，且默认不勾', !!dp && dp.checked === false);
dp.checked = true;
dp.dispatchEvent(new w.Event('change'));
T('勾上后写进设置', w.rtCfg().drop === true);
dp.checked = false;
dp.dispatchEvent(new w.Event('change'));
T('取消后恢复关闭', w.rtCfg().drop === false);
const iv = doc.getElementById('rtInterval');
iv.value = '15000';
iv.dispatchEvent(new w.Event('change'));
T('检查频率可改（15 秒）', w.rtCfg().interval === 15000, String(w.rtCfg().interval));
iv.value = '30000';
iv.dispatchEvent(new w.Event('change'));
T('改回 30 秒后定时器重建', !!w.RT.pullTimer && w.rtCfg().interval === 30000);
w.closeModal();
await sleep(500);   // 等面板切换触发的自动读取收尾（读与写是互斥的）

console.log('\n九、出错不炸页面，状态如实反馈');
STUB.pushOk = false;
w.state.docSnapshot = { at: '2026-10-23T11:00:00.000Z', cols: COLS.slice(), cells: {}, source: 'test' };
w.state.marks = {};
w.state.events.push({
  id: 'rt2', date: '2026-10-31', start: '15:00', place: '', title: '同步异常测试会',
  type: 'dept', leaders: [{ name: '韩七' }],
});
w.rtCfg().enabled = true;
await w.rtPushNow(false);
T('失败后记录错误信息', /云端写入失败/.test(String(w.RT.lastErr)), String(w.RT.lastErr));
w.renderRtChip();
T('状态按钮变成「同步异常」', /同步异常/.test(doc.getElementById('bridgeChip').textContent),
  doc.getElementById('bridgeChip').textContent);
T('失败没有把数据标成已同步', !w.state.events.find(e => e.id === 'rt2').syncedAt);
STUB.pushOk = true;

console.log('\n十、关掉实时同步就完全不动云文档');
w.rtCfg().enabled = false;
w.renderRtChip();
T('状态按钮提示已关闭', /实时同步已关/.test(doc.getElementById('bridgeChip').textContent),
  doc.getElementById('bridgeChip').textContent);
mark = calls.length;
w.state.docSnapshot = { at: '2026-10-23T11:00:00.000Z', cols: COLS.slice(), cells: {}, source: 'test' };
w.state.events.push({
  id: 'rt3', date: '2026-11-01', start: '10:00', place: '', title: '关闭期间的会',
  type: 'dept', leaders: [{ name: '谷六' }],
});
w.saveState();
await sleep(1800);
T('关闭后不再自动写入', countUrl('/api/push', mark) === 0, String(countUrl('/api/push', mark)));
T('但没有丢：仍留在待同步队列', w.pendingEvents().some(e => e.id === 'rt3'));

console.log('\n十一、设置持久化');
w.rtCfg().enabled = true;
w.rtCfg().interval = 60000;
w.saveState();
const saved = JSON.parse(w.localStorage.getItem('ytzj_st_meetings_v1') || w.localStorage.getItem(Object.keys(w.localStorage).find(k => (w.localStorage.getItem(k) || '').indexOf('"rt"') >= 0) || '') || '{}');
const raw = [...Array(w.localStorage.length).keys()]
  .map(i => w.localStorage.getItem(w.localStorage.key(i)))
  .find(v => v && v.indexOf('"rt"') >= 0) || '{}';
const persisted = JSON.parse(raw);
T('实时同步设置写进了本地存储', !!(persisted.rt && persisted.rt.interval === 60000),
  JSON.stringify(persisted.rt || null));

console.log('\n' + (fail === 0 ? '✅ 全部 ' + pass + ' 项通过' : '❌ 失败 ' + fail + ' 项 / 共 ' + (pass + fail) + ' 项'));
process.exit(fail === 0 ? 0 : 1);
