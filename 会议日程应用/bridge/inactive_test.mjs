/**
 * 「已调出领导 / 人事状态词」回归测试
 *
 * 背景：云文档 2026-10-23 的「姜九」列写了「调出」两个字。
 *   1) 这不是会议，不能被解析成「姜九参加了『调出』这个会」
 *   2) 姜九已调出，今后的统计里不该再出现他，也不该再往他的列里写
 *   3) 10-23 之前的历史记录要保留（那时候他还在本单位）
 *
 * 运行：node bridge/inactive_test.mjs
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
    '2026-10-23|姜九': '调出',
    '2026-10-20|姜九': '下午15:00，B027会议室，保障性住房工作调度会',
    '2026-10-21|崔三': '上午9:00，B027会议室，局党组会议',
    '2026-10-22|姜九': '1.上午9:00，A702，物业领域群腐工作调度会\n2.调出'
  }
};

async function boot() {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:7788/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      // 阻止首次自动导入历史，测试自己控制数据
      w.localStorage.setItem('ytzj_doc_history_imported_v1', '1');
      w.localStorage.setItem('ytzj_kw_patch_v2', '1');
      w.confirm = () => true;
      w.fetch = async () => ({ ok: true, status: 200, text: async () => '{"ok":false}' });
    }
  });
  await new Promise(r => setTimeout(r, 400));
  return dom;
}

const dom = await boot();
const w = dom.window;

/* ================== 一、人事状态词识别 ================== */
console.log('\n一、状态词识别（这些不是会议）');
const st = (s) => w.personnelStatusOf(s);
T('「调出」→ 调出', st('调出') === '调出', st('调出'));
T('「已调出」→ 调出', st('已调出') === '调出', st('已调出'));
T('「（调出）」→ 调出', st('（调出）') === '调出', st('（调出）'));
T('「调出，不再统计」→ 调出', st('调出，不再统计') === '调出', st('调出，不再统计'));
T('「3.调出」→ 调出', st('3.调出') === '调出', st('3.调出'));
T('「姜九调出」→ 调出', st('姜九调出') === '调出', st('姜九调出'));
T('「自10月23日起调出」→ 调出', st('自10月23日起调出') === '调出', st('自10月23日起调出'));
T('「借调」→ 借调', st('借调') === '借调', st('借调'));
T('「休假」→ 休假', st('休假') === '休假', st('休假'));
T('普通会议不算状态', st('上午9:00，B027，局党组会议') === null, st('上午9:00，B027，局党组会议'));
T('「调出工作布置会」不算状态', st('上午9:00，调出工作布置会') === null, st('上午9:00，调出工作布置会'));
T('「关于人员调出的通知会议」不算状态', st('关于人员调出的通知会议') === null, st('关于人员调出的通知会议'));

/* ================== 二、整格状态判定 ================== */
console.log('\n二、整格状态判定');
T('单元格「调出」是状态格', w.cellStatusOf('调出') === '调出', w.cellStatusOf('调出'));
T('单元格「调出\\n借调」是状态格', w.cellStatusOf('调出\n借调') === '借调', w.cellStatusOf('调出\n借调'));
T('单元格里夹会议 → 不是状态格', w.cellStatusOf('调出\n上午9:00，B027，局党组会议') === null, w.cellStatusOf('调出\n上午9:00，B027，局党组会议'));

/* ================== 三、「调出」不再被当成会议 ================== */
console.log('\n三、解析：调出不应变成会议');
const p1 = w.parseDocCell('调出', '2026-10-23');
T('parseDocCell(\'调出\') 返回空', p1.length === 0, JSON.stringify(p1));
const p2 = w.parseDocCell('1.上午9:00，A702，物业领域群腐工作调度会\n2.调出', '2026-10-22');
T('多行格只保留真会议', p2.length === 1 && /群腐/.test(p2[0].title), JSON.stringify(p2.map(x => x.title)));

const evs = w.cellsToEvents(SNAP);
const bogus = evs.filter(e => /调出/.test(e.title));
T('cellsToEvents 不产生「调出」会议', bogus.length === 0, JSON.stringify(bogus.map(x => x.title)));
T('10-23 姜九「调出」格被跳过', !evs.some(e => e.date === '2026-10-23' && (e.leaders || []).some(l => l.name === '姜九')));
T('10-20 姜九历史会议仍保留', evs.some(e => e.date === '2026-10-20' && (e.leaders || []).some(l => l.name === '姜九')));

/* ================== 四、统计口径 ================== */
console.log('\n四、统计：调出前照常计入，调出当天起不再计入');
w.state.events = [
  { id: 'e1', date: '2026-10-23', start: '09:00', title: '安全生产调度会', place: 'B027', type: 'dept', leaders: [{ name: '崔三' }, { name: '姜九' }] },
  { id: 'e2', date: '2026-10-20', start: '15:00', title: '保障性住房工作调度会', place: 'B027', type: 'dept', leaders: [{ name: '姜九' }] },
  { id: 'e3', date: '2026-10-24', start: '10:00', title: '物业工作例会', place: 'A702', type: 'dept', leaders: [{ name: '杜四' }] }
];
w.viewWeekStart = new Date(2026, 9, 19);
const s = w.attendeeStats();
T('调出前（10-20）的会议仍计入统计', s.count['姜九'] === 1, JSON.stringify(s.count));
T('姜九出现在排名里', s.names.includes('姜九'), s.names.join(','));
T('调出当天（10-23）起不再计入', (s.afterOut['姜九'] || 0) === 1, JSON.stringify(s.afterOut));
T('其他领导正常统计', s.count['崔三'] === 1 && s.count['杜四'] === 1, JSON.stringify(s.count));
T('统计口径里存了明细会议（供悬浮层用）', ((s.byName['姜九'] || [])[0] || {}).title === '保障性住房工作调度会', JSON.stringify((s.byName['姜九'] || []).map(x => x.title)));

w.renderStats();
const fpTxt = (w.document.getElementById('fpBody') || {}).textContent || '';
T('统计卡说明了「调出前计入、调出后不计入」', /姜九.*起调出.*调出前 1 场已计入.*调出后 1 场不再计入/.test(fpTxt), fpTxt.slice(-160));
T('排名里姜九带「调出」标记', (w.document.querySelectorAll('#fpBody .rank .off-tag').length) === 1);
T('姜九职务取自名册（不再是「未登记职务」）', /党组成员、副局长、三级调研员/.test(fpTxt), fpTxt.slice(0, 120));

// 点排名行 → 悬浮层列出具体会议
const yRow = Array.prototype.slice.call(w.document.querySelectorAll('#fpBody .rank'))
  .find(r => r.getAttribute('data-name') === '姜九');
const pop = w.document.getElementById('fpPop');
yRow.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
T('点击领导后浮出参会明细层', pop && !pop.hidden);
T('明细层里列出那一场会议', /保障性住房工作调度会/.test(pop.textContent || ''), (pop.textContent || '').slice(0, 80));
T('明细层标明共几场', /共 1 场/.test(pop.textContent || ''));
yRow.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
T('再点一次收起', pop.hidden);

/* ========== 四之二、调出之后的周期不再出现他的统计 ========== */
console.log('\n四之二、调出后的周期：不再出现与已调出领导有关的统计');
const setScope = (ws) => { w.viewWeekStart = ws; w.state.statsScope = 'week'; w.state.statsWeek = null; w.renderStats(); };

// 调出之后的一周（10.26—11.1），他一场会都没有
w.state.events = [
  { id: 'f1', date: '2026-10-27', start: '09:00', title: '污水治理推进会', place: 'B027', type: 'dept', leaders: [{ name: '崔三' }] },
  { id: 'f2', date: '2026-10-28', start: '10:00', title: '保障房调度会', place: 'A702', type: 'dept', leaders: [{ name: '杜四' }] }
];
setScope(new Date(2026, 9, 26));
const afterTxt = w.document.getElementById('fpBody').textContent.replace(/\s+/g, ' ');
T('调出后的周期不再提姜九', !/姜九/.test(afterTxt), afterTxt.slice(-120));
T('也没有「该周无记录」的提示行', !/无记录/.test(afterTxt), afterTxt.slice(-120));
T('其他领导照常统计', /崔三/.test(afterTxt) && /杜四/.test(afterTxt));

// 月口径同样：调出之后的月份不再出现
w.state.statsScope = 'month';
w.state.statsMonth = '2026-11';
w.renderStats();
T('调出后的月份也不提姜九', !/姜九/.test(w.document.getElementById('fpBody').textContent), w.document.getElementById('fpBody').textContent.replace(/\s+/g, ' ').slice(-120));

// 历史周期（他调出前）仍要保留，不能把过去的数据也抹掉
w.state.events = [
  { id: 'g1', date: '2026-10-14', start: '09:00', title: '住房保障专题会', place: 'B027', type: 'dept', leaders: [{ name: '姜九' }] }
];
setScope(new Date(2026, 9, 12));
const histTxt = w.document.getElementById('fpBody').textContent.replace(/\s+/g, ' ');
T('历史周期仍保留他的统计', /姜九/.test(histTxt) && /调出前 1 场已计入/.test(histTxt), histTxt.slice(-120));

/* ================== 五、同步：不写他的列 ================== */
console.log('\n五、同步：已调出的人不再写入');
T('syncColumns 不含姜九', !w.syncColumns().includes('姜九'), w.syncColumns().join(','));
T('syncColumns 仍含其他人', w.syncColumns().includes('崔三') && w.syncColumns().includes('贺八'));

w.state.docSnapshot = { at: SNAP.at, cols: SNAP.cols, cells: SNAP.cells, source: 'test' };
w.state.events = [
  { id: 'e4', date: '2026-10-26', start: '09:00', title: '污水治理推进会', place: 'B027', type: 'dept', leaders: [{ name: '姜九' }] },
  { id: 'e5', date: '2026-10-27', start: '10:00', title: '老旧小区改造调度会', place: 'A702', type: 'dept', leaders: [{ name: '崔三' }, { name: '姜九' }] }
];
const plan = w.buildSyncPlan(false, false);
T('只有姜九参会 → 不写入', !plan.items.some(x => x.leader === '姜九'), JSON.stringify(plan.items.map(x => x.leader)));
T('混合参会 → 只写崔三', plan.items.some(x => x.leader === '崔三') && plan.items.length === 1, JSON.stringify(plan.items.map(x => x.leader)));
T('其中一场被标记为不写入并给出原因', plan.skipped.some(x => /调出/.test(x.reason)), JSON.stringify(plan.skipped.map(x => x.reason)));
T('只涉及已调出人员的会议不进待同步角标', !w.pendingEvents().some(e => e.id === 'e4'), w.pendingEvents().map(e => e.id).join(','));

/* ================== 六、兜底清理历史脏数据 ================== */
console.log('\n六、兜底：清掉以前误导入的「调出」会议');
w.state.events = [
  { id: 'bad', date: '2026-10-23', start: '', title: '调出', place: '', type: 'dept', leaders: [{ name: '姜九' }] },
  { id: 'ok', date: '2026-10-24', start: '10:00', title: '物业工作例会', place: 'A702', type: 'dept', leaders: [{ name: '杜四' }] }
];
const cleaned = w.cleanupStatusEvents();
T('清理掉 1 条假会议', cleaned === 1, String(cleaned));
T('真会议保留', w.state.events.length === 1 && w.state.events[0].id === 'ok');

/* ================== 七、设置界面与持久化 ================== */
console.log('\n七、设置界面与本地保存');
w.openSettings();
const offBody = w.document.getElementById('offBody');
T('设置里有「已调出」表格', !!offBody);
T('表格里预置姜九', /姜九/.test(offBody.textContent || '') || (offBody.querySelector('input[data-g="name"]') || {}).value === '姜九');
const sinceInput = offBody.querySelector('input[data-g="since"]');
T('生效日期是 2026-10-23', sinceInput && sinceInput.value === '2026-10-23', sinceInput && sinceInput.value);

// 改生效日期 → 保存后应生效
sinceInput.value = '2026-10-26';
w.document.getElementById('setSave').click();
T('保存后 since 更新', (w.state.inactive[0] || {}).since === '2026-10-26', JSON.stringify(w.state.inactive));
T('10-25 的会重新计入（since 之后的日期才排除）', w.isInactiveOn('姜九', '2026-10-25') === false);
T('10-27 的会仍排除', w.isInactiveOn('姜九', '2026-10-27') === true);

const saved = JSON.parse(w.localStorage.getItem('ytzj_meeting_calendar_v1') || '{}');
T('inactive 已写入 localStorage', Array.isArray(saved.inactive) && saved.inactive[0].name === '姜九', JSON.stringify(saved.inactive));

// 还原为真实生效日期
w.state.inactive = [{ name: '姜九', since: '2026-10-23', reason: '已调出，与我局无关' }];
w.saveState();

/* ================== 八、回归：不影响正常解析与同步 ================== */
console.log('\n八、回归：正常会议不受影响');
const items = w.parseText('1. 10.31 上午9:00，B027会议室，局党组会议，谷六参加\n2. 10月27日下午3点 A702 全市物业工作现场会 杜四', w.cfgForParse());
T('正常文本仍解析出 2 场', items.length === 2, JSON.stringify(items.map(x => x.title)));
T('日期写法未受影响', items[0].date === '2026-10-31', items[0].date);
T('推荐的领导仍是本单位在岗人员', items.every(it => !(it.leaders || []).some(l => (l.name || l) === '姜九')));

console.log('\n' + (fail ? `❌ 失败 ${fail} 项 / 共 ${pass + fail} 项` : `✅ 全部 ${pass} 项通过`));
dom.window.close();
process.exit(fail ? 1 : 0);
