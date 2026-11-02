/**
 * 「冲突裁决 / 外出培训」跨设备同步 + 培训区间合并 回归测试
 *
 * 对应两个真实报障：
 *   1. 本机点过「连开/衔接」「冲突」「忽视」，手机打开还是弹同样的冲突提示
 *      —— 裁决只存在本机 localStorage，key 还是按事件 id 拼的，换设备必然对不上。
 *   2. 杜四在云文档里标着 9月14日 到 10月16日 两处「外出培训」，
 *      App 却把他读成「只培训了这两天」—— 首末两处标记没有并成一段连续培训。
 *
 * 运行：node bridge/state_sync_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { normalizeEntry, mergeEntries, entryFromRow, STATE_SHEET_NAME } from './app-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const tjsdom = createRequire(path.join(APP, '.tmp', 'noop.js'));
const { JSDOM, VirtualConsole } = tjsdom('jsdom');

let pass = 0, fail = 0;
const T = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   → ' + extra : '')); }
};

/* ================== 一、服务端：状态表条目编解码 ================== */
console.log('一、状态表条目（app-state.mjs）');
T('工作表名固定为「应用状态」', STATE_SHEET_NAME === '应用状态');
const ne = normalizeEntry({ key: 'd|崔三|2026-10-20|09:00|15:00', v: { v: 'ok' } });
T('缺 at 的条目补一个最早的 at', !!ne && ne.v.at === new Date(0).toISOString(), JSON.stringify(ne));
T('没有 key 的条目丢弃', normalizeEntry({ v: { at: '2026-01-01T00:00:00.000Z' } }) === null);
T('超长 key 丢弃', normalizeEntry({ key: 'x'.repeat(300), v: {} }) === null);

const base = [{ key: 'd|A', v: { v: 'ok', at: '2026-10-20T00:00:00.000Z' } }];
let m = mergeEntries(base, [{ key: 'd|A', v: { v: 'conflict', at: '2026-10-21T00:00:00.000Z' } }]);
T('更新的条目覆盖旧值', m.entries[0].v.v === 'conflict' && m.changed.length === 1, JSON.stringify(m.entries));
m = mergeEntries(base, [{ key: 'd|A', v: { v: 'conflict', at: '2026-10-19T00:00:00.000Z' } }]);
T('更旧的条目不会覆盖新值', m.entries[0].v.v === 'ok' && m.changed.length === 0, JSON.stringify(m.entries));
m = mergeEntries(base, [{ key: 'd|B', v: { v: 'ok', at: '2026-10-21T00:00:00.000Z' } }]);
T('新 key 追加进来', m.entries.length === 2 && m.changed.length === 1);
T('已存在的行不算改动（不重复写）', mergeEntries(base, base).changed.length === 0);

const er = entryFromRow('d|崔三|2026-10-20|09:00|15:00', '{"v":"ok","at":"2026-10-26T02:00:00.000Z"}');
T('表行 → 条目', er && er.v.v === 'ok' && er.key.indexOf('d|') === 0);
T('坏 JSON 行跳过', entryFromRow('d|x', '{不是JSON') === null);

/* ================== 二、页面加载 ================== */
const SNAP = {
  at: '2026-10-26T10:00:00.000Z',
  cols: ['崔三', '杜四', '谷六'],
  cells: {
    '2026-09-14|杜四': '外出培训',
    '2026-10-16|杜四': '外出培训'
  }
};
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:7788/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
  beforeParse(w) {
    w.localStorage.setItem('ytzj_doc_history_imported_v1', '1');
    w.localStorage.setItem('ytzj_kw_patch_v2', '1');
    w.confirm = () => true;
    w.fetch = async () => ({ ok: true, status: 200, text: async () => '{"ok":false}' });
  }
});
await new Promise(r => setTimeout(r, 400));
const w = dom.window;
const doc = w.document;

const mkEvent = (id, date, start, title, leader) => ({
  id, date, start, title, place: 'B027', type: 'internal',
  leaders: [{ name: leader }], note: ''
});

/* ================== 三、裁决 key 跨设备一致 ================== */
console.log('\n三、裁决 key 跨设备一致（手机端能认本机的裁决）');
w.state.ignoredConflicts = {};
w.state.conflictDecisions = {};
w.state.trainings = [];
w.state.events = [
  mkEvent('dev1_a', '2026-10-20', '09:00', '党组会', '崔三'),
  mkEvent('dev1_b', '2026-10-20', '10:30', '物业调度会', '崔三')
];
let c = w.computeConflicts();
T('同一天上下午各一场 → 1 组待确认', c.pending.length === 1, JSON.stringify(c.pending.map(x => x.key)));
const keyOnDevice1 = c.pending[0].key;
T('裁决 key 不含事件 id', !/dev1_/.test(keyOnDevice1), keyOnDevice1);
T('裁决 key 是「领导|日期|开始1|开始2」', keyOnDevice1 === '崔三|2026-10-20|09:00|10:30', keyOnDevice1);
T('开始时刻顺序无关', w.decisionKey({ start: '10:30', date: '2026-10-20' }, { start: '09:00', date: '2026-10-20' }, '崔三') === keyOnDevice1,
  w.decisionKey({ start: '10:30', date: '2026-10-20' }, { start: '09:00', date: '2026-10-20' }, '崔三'));

// 本机点「连开/衔接」
w.setDecision(keyOnDevice1, 'ok');
c = w.computeConflicts();
T('裁决后不再待确认', c.pending.length === 0);
T('裁决记了时间戳', !!w.state.conflictDecidedAt[keyOnDevice1]);
const entriesA = w.cloudStateEntries();
const dEntry = entriesA.find(e => e.key === 'd|' + keyOnDevice1);
T('裁决能变成云端条目', !!dEntry && dEntry.v.v === 'ok', JSON.stringify(dEntry));

// —— 换设备：同样的会，但事件 id 全是新生成的（云端读回来就是这样）
w.state.conflictDecisions = {};
w.state.conflictDecidedAt = {};
w.state.events = [
  mkEvent('phone_9x', '2026-10-20', '09:00', '党组会', '崔三'),
  mkEvent('phone_7y', '2026-10-20', '10:30', '物业调度会', '崔三')
];
c = w.computeConflicts();
T('新设备（新 id）一开始仍待确认', c.pending.length === 1);
const nApply = w.applyCloudStateEntries(entriesA);
T('读到云端状态后应用了 1 条', nApply >= 1, String(nApply));
c = w.computeConflicts();
T('应用后新设备不再提示冲突（报障①）', c.pending.length === 0, JSON.stringify(c.pending.map(x => x.key)));

// 再应用一次不应重复计数
w.applyCloudStateEntries(entriesA);
const entriesB = w.cloudStateEntries();
T('本机条目与云端一致（不会来回打架）',
  JSON.stringify(entriesB.find(e => e.key === 'd|' + keyOnDevice1)) === JSON.stringify(dEntry),
  JSON.stringify(entriesB.find(e => e.key === 'd|' + keyOnDevice1)));

/* ================== 四、判为「冲突」也要同步 ================== */
console.log('\n四、判为冲突 / 忽视 同样跨设备');
w.state.conflictDecisions = {};
w.state.conflictDecidedAt = {};
w.setDecision(keyOnDevice1, 'conflict');
c = w.computeConflicts();
T('判为冲突后该组两场都标冲突', c.eventCount === 2 && c.pending.length === 0, JSON.stringify(c.ids));
const eConf = w.cloudStateEntries().find(e => e.key === 'd|' + keyOnDevice1);
T('冲突裁决也带得走', !!eConf && eConf.v.v === 'conflict');

// 忽视
w.state.ignoredConflicts = {};
w.state.events = [
  mkEvent('h1', '2026-10-21', '09:00', '撞会A', '谷六'),
  mkEvent('h2', '2026-10-21', '09:00', '撞会B', '谷六')
];
c = w.computeConflicts();
T('硬冲突 1 组', c.hard.length === 1);
w.ignoreConflict(c.hard[0].key, [c.hard[0].idA, c.hard[0].idB]);
const iEntry = w.cloudStateEntries().find(e => e.key === 'i|' + c.hard[0].key);
T('忽视记录能变成云端条目', !!iEntry && typeof iEntry.v.at === 'string', JSON.stringify(iEntry));
T('忽视 key 里没有事件 id', !/h1|h2/.test(iEntry.key), iEntry.key);

// 新设备读到这条忽视
w.state.ignoredConflicts = {};
w.applyCloudStateEntries([iEntry]);
c = w.computeConflicts();
T('新设备读到「别人已忽视」→ 不再提示', c.hard.length === 0);

/* ================== 五、培训区间合并（报障②） ================== */
console.log('\n五、培训：首末两处标记要并成一段（报障②）');
w.state.trainings = [];
w.state.trainGone = {};
w.state.docSnapshot = SNAP;
const rawMarks = w.cellsToTrainings(SNAP);
T('原始标记仍是两条', rawMarks.length === 2, JSON.stringify(rawMarks.map(x => x.from)));
const merged = w.mergeTrainingMarks(rawMarks);
T('合并后只剩 1 条记录', merged.length === 1, JSON.stringify(merged));
T('区间为 9月14日 → 10月16日', merged[0].from === '2026-09-14' && merged[0].to === '2026-10-16', JSON.stringify(merged[0]));
T('合并出来的记录标为 auto（可被用户修正）', merged[0].auto === true);

w.importTrainingsFromSnapshot();
T('导入后只有 1 条培训记录', w.state.trainings.length === 1, JSON.stringify(w.state.trainings));
T('天数 = 33 天（不是两天）', w.trainingDaysOf(w.state.trainings[0]) === 33, String(w.trainingDaysOf(w.state.trainings[0])));
T('10月1日判定为在培训中', w.trainingsOn('2026-10-01').length === 1);

// 重复导入不重复、不变形
const n2 = w.importTrainingsFromSnapshot();
T('再导一次不新增', w.state.trainings.length === 1 && n2 === 0, String(n2));

/* ---- 用户手工改窄区间：不能被云端标记撑回去 ---- */
console.log('\n六、用户手工修改优先');
const t0 = w.state.trainings[0];
t0.to = '2026-10-10';
t0.auto = false;
t0.editedAt = new Date().toISOString();
w.saveState(true);
w.importTrainingsFromSnapshot();
T('用户改窄后仍是 1 条', w.state.trainings.length === 1, JSON.stringify(w.state.trainings.map(x => x.from + '~' + x.to)));
T('区间保持用户改的 10月10日', w.state.trainings[0].to === '2026-10-10', w.state.trainings[0].to);

/* ---- 用户删掉：不能自动长回来 ---- */
console.log('\n七、删掉的培训不会自动长回来');
const del = w.state.trainings[0];
w.markTrainingGone(del);
w.state.trainings = w.state.trainings.filter(x => x.id !== del.id);
w.importTrainingsFromSnapshot();
T('删掉后重导不会复活', w.state.trainings.length === 0, JSON.stringify(w.state.trainings.map(x => x.from)));

/* ---- 间隔太远的两段不合并 ---- */
console.log('\n八、两段不同的培训不会被硬捏成一段');
w.state.trainings = [];
w.state.trainGone = {};
w.state.docSnapshot = {
  at: SNAP.at, cols: SNAP.cols,
  cells: {
    '2026-03-02|杜四': '外出培训',
    '2026-03-06|杜四': '外出培训',
    '2026-11-02|杜四': '外出培训',
    '2026-11-06|杜四': '外出培训'
  }
};
const m2 = w.mergeTrainingMarks(w.cellsToTrainings(w.state.docSnapshot));
T('三月一段 + 十一月一段 = 2 条', m2.length === 2, JSON.stringify(m2.map(x => x.from + '~' + x.to)));
T('三月段 3-02~3-06', m2.some(x => x.from === '2026-03-02' && x.to === '2026-03-06'), JSON.stringify(m2));
T('十一月段 11-02~11-06', m2.some(x => x.from === '2026-11-02' && x.to === '2026-11-06'));

/* ================== 九、培训也走云状态 ================== */
console.log('\n九、培训记录跨设备');
w.state.trainings = [];
w.state.trainGone = {};
w.state.docSnapshot = SNAP;
w.importTrainingsFromSnapshot();
const autoRec = w.state.trainings[0];
let tEntries = w.cloudStateEntries().filter(e => e.key.indexOf('t|') === 0);
T('自动收的培训不往云端写（云端标记本来就推得出来）', tEntries.length === 0, JSON.stringify(tEntries));

autoRec.auto = false;
autoRec.editedAt = new Date().toISOString();
tEntries = w.cloudStateEntries().filter(e => e.key.indexOf('t|') === 0);
T('用户确认过的培训会写进云端', tEntries.length === 1, JSON.stringify(tEntries));
T('条目里带完整区间', tEntries[0].v.from === '2026-09-14' && tEntries[0].v.to === '2026-10-16', JSON.stringify(tEntries[0].v));

// 新设备：本地没有培训，只靠云端条目
w.state.trainings = [];
w.state.trainGone = {};
w.applyCloudStateEntries(tEntries);
T('新设备从云端拿到这段培训', w.state.trainings.length === 1, JSON.stringify(w.state.trainings));
T('新设备拿到的天数一致', w.trainingDaysOf(w.state.trainings[0]) === 33, String(w.trainingDaysOf(w.state.trainings[0] || {})));

// 删除墓碑也跨设备
const tomb = w.cloudStateEntries().filter(e => e.key.indexOf('t|') === 0 && e.v.del);
w.state.trainGone = {};
w.state.trainGone[w.trainingKey(w.state.trainings[0])] = new Date().toISOString();
w.state.trainings = [];
const tombEntries = w.cloudStateEntries().filter(e => e.key.indexOf('t|') === 0 && e.v.del);
T('删除会留下墓碑条目', tombEntries.length === 1, JSON.stringify(tomb));
T('墓碑带 del 标记', tombEntries[0].v.del === 1);

/* ================== 十、界面：冲突提示确实消失 ================== */
console.log('\n十、界面回归');
w.state.ignoredConflicts = {};
w.state.conflictDecisions = {};
w.state.conflictDecidedAt = {};
w.state.events = [
  mkEvent('ui_a', '2026-10-22', '09:00', '局党组会议', '崔三'),
  mkEvent('ui_b', '2026-10-22', '10:30', '物业工作调度会', '崔三')
];
w.viewWeekStart = new Date(2026, 9, 19);
w.renderWeek();
T('未裁决时顶部有冲突提示条', doc.getElementById('alertBar').className.indexOf('on') >= 0, doc.getElementById('alertBar').className);
const uiKey = w.computeConflicts().pending[0].key;
w.applyCloudStateEntries([{ key: 'd|' + uiKey, v: { v: 'ok', at: new Date(Date.now() + 1000).toISOString() } }]);
w.renderWeek();
T('应用云端裁决后提示条消失', doc.getElementById('alertBar').className.indexOf('on') < 0, doc.getElementById('alertBar').className);
T('会议卡片不再标冲突', doc.querySelectorAll('.ev.conflict').length === 0, String(doc.querySelectorAll('.ev.conflict').length));

/* ================== 十一、老数据兼容 ================== */
console.log('\n十一、老版本数据兼容');
w.state.conflictDecisions = { 'old_id_a|old_id_b': 'ok' };
w.state.conflictDecidedAt = {};
w.state.events = [
  mkEvent('old_id_a', '2026-10-23', '09:00', '老会A', '韩七'),
  mkEvent('old_id_b', '2026-10-23', '10:30', '老会B', '韩七')
];
c = w.computeConflicts();
T('老 key 的裁决仍然生效', c.pending.length === 0, JSON.stringify(c.pending.map(x => x.key)));
T('老 key 已迁移成新 key', !!w.state.conflictDecisions['韩七|2026-10-23|09:00|10:30'],
  JSON.stringify(Object.keys(w.state.conflictDecisions)));
const mig = w.cloudStateEntries().find(e => e.key === 'd|韩七|2026-10-23|09:00|10:30');
T('迁移后的裁决能同步出去', !!mig && mig.v.v === 'ok', JSON.stringify(mig));

console.log('\n===== 结果：' + pass + ' PASS / ' + fail + ' FAIL =====');
process.exit(fail ? 1 : 0);
