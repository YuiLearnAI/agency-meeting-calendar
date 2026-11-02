// 冲突检测回归测试：硬冲突(同时刻) + 软冲突(同半天多场，需交互裁决) + 贺八称谓
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, '..');
const require = createRequire(join(APP, '.tmp', 'noop.js'));
const { JSDOM, VirtualConsole } = require('jsdom');

const html = readFileSync(join(APP, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const T = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  →  ' + extra : '')); }
};

const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
vc.on('error', () => {});

const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:7788/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(w) {
    w.localStorage.setItem('ytzj_doc_history_imported_v1', '1');
    w.localStorage.setItem('ytzj_kw_patch_v2', '1');
    w.confirm = () => true;
    if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false }) });
  }
});
const w = dom.window;
await new Promise((r) => setTimeout(r, 600));

/* ================== 一、称谓：贺八例外 ================== */
console.log('--- 称谓规则 ---');
T('谷六/副局长 → 谷局', w.honorificOf('谷六', '党组成员、副局长') === '谷局');
T('崔三/一级调研员 → 崔局', w.honorificOf('崔三', '一级调研员') === '崔局');
T('樊五/纪检组长 → 樊局', w.honorificOf('樊五', '党组成员、纪检组组长') === '樊局');
T('贺八/主任 → 贺主任(例外)', w.honorificOf('贺八', '市住房保障中心主任') === '贺主任');
T('安一/局长 → 安局', w.honorificOf('安一', '党组书记、局长') === '安局');

/* ================== 二、冲突检测 ================== */
console.log('--- 冲突检测 ---');

function mk(id, date, start, title, name) {
  return { id, date, start, title, leaders: [{ name }] };
}

// 场景1：同一时刻 → 硬冲突
w.state.events = [
  mk('e1', '2026-10-26', '9:00', '党组会', '谷六'),
  mk('e2', '2026-10-26', '9:00', '城建会', '谷六'),
];
let c = w.computeConflicts();
T('场景1: 同时刻2场 → 硬冲突1组', c.hard.length === 1, JSON.stringify(c.hard));
T('场景1: 无软冲突待确认', c.pending.length === 0);
T('场景1: 2场均标记冲突', c.ids['e1'] && c.ids['e2']);
T('场景1: 硬冲突详情含"同一时刻"', c.hard[0] && c.hard[0].text.indexOf('同一时刻') >= 0);

// 场景2：同半天不同时刻 → 软冲突待确认
w.state.events = [
  mk('e3', '2026-10-26', '15:00', '物业会', '杜四'),
  mk('e4', '2026-10-26', '16:30', '更新会', '杜四'),
];
w.state.conflictDecisions = {};
c = w.computeConflicts();
T('场景2: 同下午不同时刻 → 无硬冲突', c.hard.length === 0);
T('场景2: 软冲突待确认1组', c.pending.length === 1, JSON.stringify(c.pending));
T('场景2: 未裁决不计冲突', !c.ids['e3'] && !c.ids['e4']);
T('场景2: 待确认项顺序正确(前场15:00在前)', c.pending[0] && c.pending[0].firstStart === '15:00');

// 场景3：裁决为 conflict → 记冲突
w.state.conflictDecisions = { 'e3|e4': 'conflict' };
c = w.computeConflicts();
T('场景3: 裁决conflict后计冲突', c.ids['e3'] && c.ids['e4']);
T('场景3: 不再待确认', c.pending.length === 0);

// 场景4：裁决为 ok → 不计冲突
w.state.conflictDecisions = { 'e3|e4': 'ok' };
c = w.computeConflicts();
T('场景4: 裁决ok后不计冲突', !c.ids['e3'] && !c.ids['e4']);
T('场景4: 也不待确认', c.pending.length === 0);

// 场景5：跨半天(上午+下午) → 不冲突
w.state.events = [
  mk('e5', '2026-10-26', '11:00', '上午会', '谷六'),
  mk('e6', '2026-10-26', '14:00', '下午会', '谷六'),
];
w.state.conflictDecisions = {};
c = w.computeConflicts();
T('场景5: 上午+下午各一场 → 无冲突', c.hard.length === 0 && c.pending.length === 0);

// 场景6：同一领导，两天各一场 → 不冲突
w.state.events = [
  mk('e7', '2026-10-26', '9:00', '周一', '韩七'),
  mk('e8', '2026-10-27', '9:00', '周二', '韩七'),
];
c = w.computeConflicts();
T('场景6: 跨天同时刻 → 无冲突', c.hard.length === 0 && c.pending.length === 0);

// 场景7：不同领导同半天 → 不冲突
w.state.events = [
  mk('e9', '2026-10-26', '9:00', '会A', '崔三'),
  mk('e10', '2026-10-26', '10:00', '会B', '韩七'),
];
c = w.computeConflicts();
T('场景7: 不同领导 → 无冲突', c.hard.length === 0 && c.pending.length === 0);

// 场景8：三场同半天 → 生成多组软冲突配对
w.state.events = [
  mk('e11', '2026-10-26', '9:00', '会1', '安一'),
  mk('e12', '2026-10-26', '10:00', '会2', '安一'),
  mk('e13', '2026-10-26', '11:00', '会3', '安一'),
];
w.state.conflictDecisions = {};
c = w.computeConflicts();
T('场景8: 三场同半天 → 3组待确认', c.pending.length === 3, JSON.stringify(c.pending.map(p=>p.key)));

/* ================== 三、decisionKey 稳定性 ================== */
console.log('--- 决策键 ---');
T('决策键顺序无关', w.decisionKey({id:'a'},{id:'b'}) === w.decisionKey({id:'b'},{id:'a'}));

/* ================== 四、忽视功能 ================== */
console.log('--- 忽视功能 ---');

// 事件时间工具
T('eventTimeMs 正确解析', w.eventTimeMs(mk('x','2026-10-26','9:00','t','名')) === new Date(2026,9,26,9,0).getTime());

// 忽视：会议时间未到 → 当前会话不提醒，下次(新会话)再提醒
w.state.events = [
  mk('e20', '2099-10-26', '9:00', '未来会1', '谷六'),
  mk('e21', '2099-10-26', '10:00', '未来会2', '谷六'),
];
w.state.conflictDecisions = {};
w.state.ignoredConflicts = {};
c = w.computeConflicts();
T('忽视前: 软冲突待确认1组', c.pending.length === 1);
// 模拟忽视
w.ignoreConflict('e20|e21', ['e20','e21']);
c = w.computeConflicts();
T('忽视后: 本次会话不再提醒(待确认为0)', c.pending.length === 0, JSON.stringify(c.pending));
// 记录已写入
T('忽视记录已保存(带session)', w.state.ignoredConflicts['e20|e21'] && w.state.ignoredConflicts['e20|e21'].session === w.APP_SESSION);
// 模拟"下次进入应用"：换个会话标识
var oldSession = w.APP_SESSION;
w.APP_SESSION = 'newsession_xyz';
c = w.computeConflicts();
T('新会话+时间未到 → 再次提醒', c.pending.length === 1);
w.APP_SESSION = oldSession;

// 忽视：会议时间已过 → 永久不再提醒
w.state.events = [
  mk('e22', '2020-01-01', '9:00', '过去会1', '崔三'),
  mk('e23', '2020-01-01', '10:00', '过去会2', '崔三'),
];
w.state.conflictDecisions = {};
w.state.ignoredConflicts = {};
w.ignoreConflict('e22|e23', ['e22','e23']);
// 换新会话，时间已过，仍不提醒
w.APP_SESSION = 'another_session';
c = w.computeConflicts();
T('已过去+新会话 → 永久不提醒', c.pending.length === 0 && c.hard.length === 0);
w.APP_SESSION = oldSession;

// 忽视：硬冲突(同一时刻)也可忽视
w.state.events = [
  mk('e30', '2099-10-26', '9:00', '撞会A', '韩七'),
  mk('e31', '2099-10-26', '9:00', '撞会B', '韩七'),
];
w.state.ignoredConflicts = {};
c = w.computeConflicts();
T('硬冲突: 忽视前1组', c.hard.length === 1);
var hkey = c.hard[0].key;
w.ignoreConflict(hkey, ['e30','e31']);
c = w.computeConflicts();
T('硬冲突: 忽视后0组', c.hard.length === 0);

// ignoreStillHolds 单元测试
T('ignoreStillHolds: 无记录返回false', w.ignoreStillHolds(null) === false);
T('ignoreStillHolds: 已过去返回true(永久)', w.ignoreStillHolds({ latest: Date.now()-100000, session: 'other' }) === true);
T('ignoreStillHolds: 未过去+同会话返回true(临时)', w.ignoreStillHolds({ latest: Date.now()+100000, session: w.APP_SESSION }) === true);
T('ignoreStillHolds: 未过去+异会话返回false(恢复)', w.ignoreStillHolds({ latest: Date.now()+100000, session: 'other' }) === false);

console.log('\n===== 结果：' + pass + ' PASS / ' + fail + ' FAIL =====');
process.exit(fail ? 1 : 0);
