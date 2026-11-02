/**
 * 「领导外出培训」+「周/月统计」回归测试
 *
 * 需求：
 *   1. 新页面记录领导外出培训，显示形式与参会统计一致（排名 + 计数）
 *   2. 某领导有培训时，日历上要占位显示（不能当成会议，也要能看出他不在）
 *   3. 参会统计增加月度口径，用切换按钮在周/月之间切换
 *
 * 运行：node bridge/training_test.mjs
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

const SNAP = {
  at: '2026-10-23T10:29:22.918Z',
  cols: ['崔三', '姜九', '杜四', '谷六', '韩七', '贺八'],
  cells: {
    '2026-09-14|杜四': '外出培训',
    '2026-10-20|杜四': '外出培训',
    '2026-10-21|崔三': '上午9:00，B027会议室，局党组会议',
    '2026-10-22|杜四': '1.上午9:00，A702，物业领域群腐工作调度会\n2.外出培训'
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

/* ================== 一、培训标记识别 ================== */
console.log('\n一、「外出培训」这类标记识别');
const mk = (s) => w.trainingMarkerOf(s);
T('「外出培训」识别', !!mk('外出培训') && mk('外出培训').label === '外出培训', JSON.stringify(mk('外出培训')));
T('「培训」识别', !!mk('培训'));
T('「脱产学习」识别', !!mk('脱产学习'));
T('「党校进修」识别', !!mk('党校进修'));
T('「杜四外出培训」识别', !!mk('杜四外出培训'));
T('「（9月14日-9月18日）外出培训」带出日期区间', !!mk('（9月14日-9月18日）外出培训') && mk('（9月14日-9月18日）外出培训').range === '9月14日-9月18日', JSON.stringify(mk('（9月14日-9月18日）外出培训')));
T('「全市项目谋划培训会」不算培训', mk('全市项目谋划培训会，下午14:30') === null, JSON.stringify(mk('全市项目谋划培训会，下午14:30')));
T('「培训工作部署会」不算培训', mk('上午9:00，B023，培训工作部署会') === null);
T('会议里的「培训班开班仪式」不算培训', mk('上午9:00，B027，培训班开班仪式') === null, JSON.stringify(mk('上午9:00，B027，培训班开班仪式')));

console.log('\n二、培训日期区间解析');
const rg = (s, base) => w.parseRangeText(s, base || '2026-10-23');
T('9月14日-9月18日', JSON.stringify(rg('9月14日-9月18日')) === JSON.stringify(['2026-09-14', '2026-09-18']), JSON.stringify(rg('9月14日-9月18日')));
T('10.8-10.12', JSON.stringify(rg('10.8-10.12')) === JSON.stringify(['2026-10-08', '2026-10-12']), JSON.stringify(rg('10.8-10.12')));
T('9月28日至10月2日（跨月）', JSON.stringify(rg('9月28日至10月2日')) === JSON.stringify(['2026-09-28', '2026-10-02']), JSON.stringify(rg('9月28日至10月2日')));
T('9月14日至18日（省略第二个月）', JSON.stringify(rg('9月14日至18日')) === JSON.stringify(['2026-09-14', '2026-09-18']), JSON.stringify(rg('9月14日至18日')));
T('乱写的日期返回 null', rg('13月40日-13月41日') === null, JSON.stringify(rg('13月40日-13月41日')));

/* ================== 三、不被当成会议 ================== */
console.log('\n三、培训不进入会议列表');
T('parseDocCell(\'外出培训\') 返回空', w.parseDocCell('外出培训', '2026-10-20').length === 0);
const p2 = w.parseDocCell('1.上午9:00，A702，物业领域群腐工作调度会\n2.外出培训', '2026-10-22');
T('夹在会议里的培训只留会议', p2.length === 1 && /群腐/.test(p2[0].title), JSON.stringify(p2.map(x => x.title)));

const evs = w.cellsToEvents(SNAP);
T('cellsToEvents 不产生「外出培训」会议', !evs.some(e => /培训/.test(e.title)), JSON.stringify(evs.map(x => x.title)));

const trs = w.cellsToTrainings(SNAP);
T('cellsToTrainings 从云文档收到培训记录', trs.length === 3, JSON.stringify(trs.map(x => x.leader + x.from)));
T('培训记录指向正确的人', trs.every(x => x.leader === '杜四'), JSON.stringify(trs.map(x => x.leader)));
T('培训记录日期正确', trs.some(x => x.from === '2026-09-14') && trs.some(x => x.from === '2026-10-20'));

/* ================== 四、天数 / 区间计算 ================== */
console.log('\n四、培训天数与区间');
T('单日 = 1 天', w.trainingDaysOf({ from: '2026-10-20', to: '2026-10-20' }) === 1);
T('10.20-10.22 = 3 天', w.trainingDaysOf({ from: '2026-10-20', to: '2026-10-22' }) === 3);
T('跨月 9.28-10.2 = 5 天', w.trainingDaysOf({ from: '2026-09-28', to: '2026-10-02' }) === 5);
T('to 缺省按单日', w.trainingDaysOf({ from: '2026-10-20' }) === 1);

/* ================== 五、日历占位 ================== */
console.log('\n五、日历里占位显示');
w.state.trainings = [];
w.state.events = [
  { id: 'e1', date: '2026-10-21', start: '09:00', title: '局党组会议', place: 'B027', type: 'internal', leaders: [{ name: '崔三' }] },
  { id: 'e2', date: '2026-10-22', start: '09:00', title: '物业领域群腐工作调度会', place: 'A702', type: 'dept', leaders: [{ name: '杜四' }] }
];
w.addTraining({ leader: '杜四', from: '2026-10-20', to: '2026-10-22', title: '市委党校中青年干部培训班', place: '市委党校' });
w.viewWeekStart = new Date(2026, 9, 19);
w.renderWeek();

const bars = doc.querySelectorAll('.trn');
T('培训期间每天各一条占位（3 天 → 3 条）', bars.length === 3, String(bars.length));
T('占位条写明是谁', /杜四/.test(bars[0].textContent), bars[0].textContent.trim().slice(0, 40));
T('占位条显示第几天', /第 1\/3 天/.test(doc.querySelector('.trn').textContent), doc.querySelector('.trn').textContent.trim());
T('最后一天显示 第 3/3 天', /第 3\/3 天/.test(bars[2].textContent));
T('占位条带培训名称', /市委党校中青年干部培训班/.test(bars[0].textContent));
T('占位条带地点', /市委党校/.test(bars[0].textContent));
T('培训与会议撞车的当天给出提示', /这天还安排了 1 场会给他/.test(bars[2].textContent), bars[2].textContent.replace(/\s+/g, ' '));
T('无培训的日期没有占位条', [...bars].every(b => !/20\d\d/.test(b.getAttribute('data-tid')) ) && doc.querySelectorAll('.daycol').length === 7);

// 点占位条 → 打开编辑
bars[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
T('点占位条打开编辑弹窗', doc.getElementById('modalTitle').textContent === '编辑培训记录', doc.getElementById('modalTitle').textContent);
T('弹窗里带出这条记录', doc.getElementById('trnLeader').value === '杜四' && doc.getElementById('trnFrom').value === '2026-10-20',
  doc.getElementById('trnLeader').value + ' ' + doc.getElementById('trnFrom').value);
w.closeModal();

/* ================== 六、培训页面（显示形式同参会统计） ================== */
console.log('\n六、培训页面');
w.state.trainings = [];
w.addTraining({ leader: '杜四', from: '2026-10-20', to: '2026-10-22', title: '市委党校中青年干部培训班', place: '市委党校' });
w.addTraining({ leader: '韩七', from: '2026-09-28', to: '2026-10-02', title: '全省建筑业管理干部培训', place: '南昌' });
w.addTraining({ leader: '韩七', from: '2026-10-15', to: '2026-10-15', title: '安全生产专题培训', place: 'B029' });
w.openTrainings();

const body = doc.getElementById('modalBody');
T('标题为「领导外出培训」', doc.getElementById('modalTitle').textContent === '领导外出培训', doc.getElementById('modalTitle').textContent);
const ranks = body.querySelectorAll('.rank');
T('统计区用排名列表（与参会统计同款）', ranks.length === 2, String(ranks.length));
T('按培训天数排序：韩七在前（6 天）', /韩七/.test(ranks[0].textContent) && /6 天/.test(ranks[0].textContent), ranks[0].textContent.replace(/\s+/g, ' '));
T('排名里同时给次数与天数', /2 次 · 6 天/.test(ranks[0].textContent), ranks[0].textContent.replace(/\s+/g, ' '));
T('杜四 3 天', /3 天/.test(ranks[1].textContent), ranks[1].textContent.replace(/\s+/g, ' '));
T('明细列出 3 条', body.querySelectorAll('.trn-item').length === 3, String(body.querySelectorAll('.trn-item').length));
T('明细带「云文档」以外的来源不误标', !/云文档/.test(body.querySelector('.trn-item').textContent));

// 新增一条
doc.getElementById('trnLeader').value = '谷六';
doc.getElementById('trnFrom').value = '2026-11-02';
doc.getElementById('trnTo').value = '2026-11-06';
doc.getElementById('trnTitle').value = '市县住建局长培训班';
doc.getElementById('trnSave').click();
T('表单可新增培训记录', w.state.trainings.length === 4, String(w.state.trainings.length));
T('新增后天数为 5 天', w.trainingDaysOf(w.state.trainings.find(t => t.leader === '谷六')) === 5);
T('新增后统计排名变 3 人', doc.getElementById('modalBody').querySelectorAll('.rank').length === 3);

// 重复添加
const before = w.state.trainings.length;
doc.getElementById('trnLeader').value = '谷六';
doc.getElementById('trnFrom').value = '2026-11-02';
doc.getElementById('trnTo').value = '2026-11-06';
doc.getElementById('trnTitle').value = '市县住建局长培训班';
doc.getElementById('trnSave').click();
T('同一条不会重复添加', w.state.trainings.length === before, String(w.state.trainings.length));

// 删除
const delBtn = doc.querySelector('#modalBody [data-act="del"]');
const delId = delBtn.getAttribute('data-tid');
delBtn.click();
T('可以删除培训记录', !w.state.trainings.some(t => t.id === delId), String(w.state.trainings.length));

/* ================== 七、周/月统计切换 ================== */
console.log('\n七、参会统计的周 / 月切换');
w.state.events = [
  { id: 'a1', date: '2026-10-05', start: '09:00', title: '十月上旬调度会', place: 'B027', type: 'dept', leaders: [{ name: '崔三' }] },
  { id: 'a2', date: '2026-10-15', start: '09:00', title: '中旬推进会', place: 'B027', type: 'dept', leaders: [{ name: '崔三' }, { name: '杜四' }] },
  { id: 'a3', date: '2026-10-22', start: '09:00', title: '物业调度会', place: 'A702', type: 'dept', leaders: [{ name: '杜四' }] },
  { id: 'a4', date: '2026-09-30', start: '09:00', title: '九月末会议', place: 'B027', type: 'dept', leaders: [{ name: '韩七' }] }
];
w.state.trainings = [];
w.addTraining({ leader: '杜四', from: '2026-10-20', to: '2026-10-22', title: '市委党校培训班' });
w.state.statsScope = 'week';
w.state.statsMonth = null;
w.viewWeekStart = new Date(2026, 9, 19);
w.renderStats();

T('默认是周口径', doc.getElementById('fpTitle').textContent === '本周领导参会统计', doc.getElementById('fpTitle').textContent);
T('周口径只统计本周（10-22 那场）', doc.getElementById('fpBody').textContent.includes('杜四'), doc.getElementById('fpBody').textContent.replace(/\s+/g, ' '));
T('周口径不含本月上旬的会', !/崔三/.test(doc.getElementById('fpBody').textContent));
T('周口径也有左右翻的导航', doc.getElementById('fpMonthNav').hidden === false);
T('周导航显示的是周区间（不是月份）', doc.getElementById('fpMonthLabel').textContent === '10.19—10.25', doc.getElementById('fpMonthLabel').textContent);
T('左右箭头提示语换成「周」', doc.getElementById('fpMonthPrev').title === '上一周' && doc.getElementById('fpMonthNext').title === '下一周',
  doc.getElementById('fpMonthPrev').title + '/' + doc.getElementById('fpMonthNext').title);
T('副标题仍是场次人数（所在周由导航显示，不挤成两行）', /^1 场会议 · 1 人$/.test(doc.getElementById('fpSub').textContent), doc.getElementById('fpSub').textContent);

// 周口径翻周（只动统计，不动日历）
doc.getElementById('fpMonthPrev').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
T('周口径点‹切到上一周', doc.getElementById('fpMonthLabel').textContent === '10.12—10.18', doc.getElementById('fpMonthLabel').textContent);
T('翻到别的周后标题变「该周」', doc.getElementById('fpTitle').textContent === '该周领导参会统计', doc.getElementById('fpTitle').textContent);
T('上一周统计到 10-15 那场（崔三、杜四都算）', /崔三/.test(doc.getElementById('fpBody').textContent) && /杜四/.test(doc.getElementById('fpBody').textContent));
T('翻统计周不会改动日历当前周', w.toISO(w.viewWeekStart) === '2026-10-19', w.toISO(w.viewWeekStart));
T('翻周位置已存本地', JSON.parse(w.localStorage.getItem('ytzj_meeting_calendar_v1') || '{}').statsWeek === '2026-10-12',
  JSON.stringify(JSON.parse(w.localStorage.getItem('ytzj_meeting_calendar_v1') || '{}').statsWeek));
doc.getElementById('fpMonthLabel').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
T('点中间那段文字回到本周', doc.getElementById('fpMonthLabel').textContent === '10.19—10.25' && doc.getElementById('fpTitle').textContent === '本周领导参会统计',
  doc.getElementById('fpMonthLabel').textContent + ' / ' + doc.getElementById('fpTitle').textContent);

// 切到月
const monthBtn = doc.querySelector('#fpScope button[data-scope="month"]');
monthBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
T('切换到月口径有 on 状态', monthBtn.classList.contains('on'));
T('标题变成本月', doc.getElementById('fpTitle').textContent === '本月领导参会统计', doc.getElementById('fpTitle').textContent);
T('月导航出现', doc.getElementById('fpMonthNav').hidden === false);
T('月份显示 2026年10月', doc.getElementById('fpMonthLabel').textContent === '2026年10月', doc.getElementById('fpMonthLabel').textContent);

const fpTxt = doc.getElementById('fpBody').textContent.replace(/\s+/g, ' ');
T('月口径统计到本月 3 场（崔三 2 场）', /崔三.*2 场/.test(fpTxt), fpTxt.slice(0, 120));
T('月口径统计到杜四 2 场', /杜四.*2 场/.test(fpTxt), fpTxt.slice(0, 120));
T('月口径不跨月（9-30 的韩七不算）', !/韩七/.test(fpTxt), fpTxt.slice(0, 160));
T('排名里带培训天数标记', /训 3 天/.test(fpTxt), fpTxt.slice(0, 160));
T('副标题写出月份与场次', /2026年10月 · 3 场会议/.test(doc.getElementById('fpSub').textContent), doc.getElementById('fpSub').textContent);
T('复制按钮文案跟着变成「本月」', /本月参会名单/.test(doc.getElementById('btnCopyWeek').textContent), doc.getElementById('btnCopyWeek').textContent);

// 翻月
doc.getElementById('fpMonthPrev').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
T('上个月切到 2026年9月', doc.getElementById('fpMonthLabel').textContent === '2026年9月', doc.getElementById('fpMonthLabel').textContent);
T('9 月能统计到 9-30 那场', /韩七/.test(doc.getElementById('fpBody').textContent));
doc.getElementById('fpMonthNext').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
T('下个月切回 2026年10月', doc.getElementById('fpMonthLabel').textContent === '2026年10月', doc.getElementById('fpMonthLabel').textContent);

// 切回周
doc.querySelector('#fpScope button[data-scope="week"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
T('切回周口径', doc.getElementById('fpTitle').textContent === '本周领导参会统计');
T('切回周后导航显示周区间', doc.getElementById('fpMonthNav').hidden === false && doc.getElementById('fpMonthLabel').textContent === '10.19—10.25',
  doc.getElementById('fpMonthLabel').textContent);
T('口径写入 localStorage', JSON.parse(w.localStorage.getItem('ytzj_meeting_calendar_v1') || '{}').statsScope === 'week');
// 跨年那周要带上年份，否则「12.28—1.3」看不出是哪一年
const wsNy = w.startOfWeek(new w.Date(2026, 11, 28));
T('跨年周标签带年份', w.statsWeekShort(wsNy) === '2026.12.28—2027.1.3', w.statsWeekShort(wsNy));

/* ================== 八、复制名单带培训段 ================== */
console.log('\n八、复制出来的名单');
w.state.statsScope = 'month';
w.state.statsMonth = '2026-10';
w.saveState();
const txt = w.rangeListText(w.eventsInRange('2026-10-01', '2026-10-31'), '2026-10-01', '2026-10-31', '本月');
T('名单带月份区间标题', /【参会名单】2026年10月1日—10月31日/.test(txt), txt.split('\n')[0]);
T('名单列出会议', /物业调度会/.test(txt));
T('名单单列【外出培训】段', /【外出培训】/.test(txt), txt.slice(-160));
T('培训段落写明人与名称', /杜四.*市委党校培训班/.test(txt.replace(/\u3000/g, ' ')), txt.slice(-160));
T('培训段落带日期区间', /10月20日—10月22日/.test(txt), txt.slice(-160));

/* ================== 九、持久化 ================== */
console.log('\n九、持久化与兼容');
const saved = JSON.parse(w.localStorage.getItem('ytzj_meeting_calendar_v1') || '{}');
T('培训记录已存本地', Array.isArray(saved.trainings) && saved.trainings.length >= 1, JSON.stringify((saved.trainings || []).map(t => t.leader)));
T('统计口径已存本地', saved.statsScope === 'month');
T('培训不产生待同步项', (() => {
  w.state.events = [];
  w.state.trainings = [{ id: 'x', leader: '杜四', from: '2026-10-20', to: '2026-10-22', title: '培训', place: '', note: '' }];
  return w.pendingEvents().length === 0;
})());

/* ================== 十、回归 ================== */
console.log('\n十、回归：原功能不受影响');
w.state.statsScope = 'week';
w.viewWeekStart = new Date(2026, 9, 19);
w.renderWeek();
T('周视图仍渲染 7 列', doc.querySelectorAll('.daycol').length === 7);
T('会议卡片仍可点击', doc.querySelectorAll('.ev').length >= 0);
T('正常文本仍能解析会议', w.parseText('1. 10月26日 上午9:00 B027 局党组会议 谷六', w.cfgForParse()).length === 1);

console.log('\n' + (fail ? `❌ 失败 ${fail} 项 / 共 ${pass + fail} 项` : `✅ 全部 ${pass} 项通过`));
dom.window.close();
process.exit(fail ? 1 : 0);
