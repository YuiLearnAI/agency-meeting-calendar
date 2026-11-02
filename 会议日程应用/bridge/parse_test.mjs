// 解析与布局回归测试：日期简写识别 + 冲突提示条固定单行 + 按钮可换行
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, '..');
const require = createRequire(join(APP, '.tmp', 'noop.js'));
const { JSDOM, VirtualConsole } = require('jsdom');

const html = readFileSync(join(APP, 'index.html'), 'utf8');
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];

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
const doc = w.document;
await new Promise((r) => setTimeout(r, 300));

/* ================== 一、日期简写解析 ================== */
console.log('--- 日期简写 ---');
const REF = new Date(2026, 9, 23);   // 2026-10-23
function dateOf(text, ref) {
  const norm = w.normalizeText(text);
  const d = w.findDate(norm, ref || REF);
  return d ? d.date : null;
}

const CASES = [
  // [输入, 期望日期, 说明]
  ['10.31', '2026-10-31', '点号简写'],
  ['10 31', '2026-10-31', '空格简写'],
  ['10/31', '2026-10-31', '斜杠简写'],
  ['10-31', '2026-10-31', '短横简写'],
  ['2026.10.31', '2026-10-31', '四位年份+点号'],
  ['2026-10-31', '2026-10-31', 'ISO 写法'],
  ['2026/10/31', '2026-10-31', '四位年份+斜杠'],
  ['10月31日', '2026-10-31', '中文月日'],
  ['10月31号', '2026-10-31', '中文月号'],
  ['11.5', '2026-11-05', '点号且日≤12、行尾'],
  ['11.5日', '2026-11-05', '点号+日'],
  ['11.5号', '2026-11-05', '点号+号'],
  ['11.5 上午9:00 开会', '2026-11-05', '点号后接时间'],
  ['10.31 上午9:00，B027，局党组会', '2026-10-31', '点号+时间+地点'],
  ['10 31 下午3点 B027 局党组会', '2026-10-31', '空格+下午时间'],
  ['2026 10 31 上午9点', '2026-10-31', '空格含年份'],
  // 不能误判
  ['14:30 开会', null, '时间不是日期'],
  ['9:00', null, '时间不是日期'],
  ['会议室 5 楼 3 号', null, '楼层房号不是日期'],
  ['面积 3.5 米', null, '小数不是日期'],
  ['共 10 人 3 场', null, '数字串不是日期'],
  ['会议室 3 5号', null, '空格房号不认号'],
  ['评分 1.2 分', null, '小数+分不认'],
  ['2026 年 10 月', null, '只有年月没有日'],
];
for (const [input, expect, note] of CASES) {
  const got = dateOf(input);
  T(`${note}：${JSON.stringify(input)} → ${expect || '不识别'}`, got === expect, '实际=' + got);
}

// 跨年：11 月的日期写到 12 月末应识别为当年（不早于参考日 180 天）
{
  const ref = new Date(2026, 11, 20);   // 2026-12-20
  T('12.31 在 12 月参考日下仍为当年', dateOf('12.31', ref) === '2026-12-31', dateOf('12.31', ref));
}

/* ================== 二、完整一行解析（日期+时间+地点+标题） ================== */
console.log('\n--- 整行解析 ---');
{
  const norm = w.normalizeText('10.31 上午9:00 B027 局党组会议 谷六');
  const d = w.findDate(norm, REF);
  const t = w.findTime(norm);
  const p = w.findPlace(norm);
  T('10.31 整行：日期对', d && d.date === '2026-10-31', d && d.date);
  T('10.31 整行：时间对', t && t.start === '09:00', t && t.start);
  T('10.31 整行：地点对', p && /B027/.test(p.place), p && p.place);
}
{
  const norm = w.normalizeText('10 31 下午3:30 5楼2号会议室 民生实事调度会');
  const d = w.findDate(norm, REF);
  const t = w.findTime(norm);
  const p = w.findPlace(norm);
  T('10 31 整行：日期对', d && d.date === '2026-10-31', d && d.date);
  T('10 31 整行：时间对（下午3:30→15:30）', t && t.start === '15:30', t && t.start);
  T('10 31 整行：地点对', p && /5楼2号会议室/.test(p.place), p && p.place);
}

/* ================== 三、整段文本解析（原有写法不许回归） ================== */
console.log('\n--- 原有写法回归 ---');
{
  const text = [
    '1. 10月26日（星期一）上午9:00，在B027会议室召开局党组会议，请谷六副局长参加。',
    '2. 2026-10-27 14:30 市政府三楼会议室 全市住建领域安全生产工作会议 韩七',
    '3. 10月28日下午3点 我局五楼会议室 物业管理工作例会 杜四',
    '4. 周四上午九点 B027 周例会 崔三',
    '5. 10 月 29 日 上午 10 时 C108 数字政府建设调度会 杜四',
    '6. 10.31 上午9:00，B027会议室，局党组会议，谷六参加',
    '7. 10 31 下午3:30 5楼2号会议室 民生实事调度会 杜四',
    '8. 2026.11.6 14:30 C108 物业工作例会 杜四',
    '9. 11-12 下午2:30 B029 招标投标整治会 韩七'
  ].join('\n');
  const items = w.parseText(text, w.cfgForParse());
  const got = items.map((it) => `${it.date} ${it.start} ${it.title}`);
  T('9 行全部解析出日期', items.length === 9, '实际 ' + items.length + ' 条');
  // 「周四」是相对日期：按解析器同一套规则算出期望值（本周内已过就顺延到下周四），
  // 否则每到樊五/周末这条用例都会假红
  const upcomingWeekday = (idx) => {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const cur = (base.getDay() + 6) % 7;
    const mon = new Date(base); mon.setDate(base.getDate() - cur);
    const t = new Date(mon); t.setDate(mon.getDate() + idx);
    if (t.getTime() < base.getTime()) t.setDate(t.getDate() + 7);
    const p = (n) => String(n).padStart(2, '0');
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  };
  const want = [
    '2026-10-26 09:00', '2026-10-27 14:30', '2026-10-28 15:00',
    upcomingWeekday(3) + ' 09:00', '2026-10-29 10:00', '2026-10-31 09:00',
    '2026-10-31 15:30', '2026-11-06 14:30', '2026-11-12 14:30'
  ];
  want.forEach((prefix, i) => {
    T(`第 ${i + 1} 行：${prefix}`, (got[i] || '').startsWith(prefix), got[i]);
  });
  T('新写法能认到参会领导', /谷六/.test(JSON.stringify(items[5] && items[5].leaders)));
  T('10 31 写法地点不被日期吞掉', (items[6] && /5楼2号会议室/.test(items[6].place)), items[6] && items[6].place);
}

/* ================== 四、冲突提示条：固定单行 + 明细浮层 ================== */
console.log('\n--- 冲突提示条 ---');
{
  const conflicts = {
    ids: { a: 1, b: 1, c: 1 },
    hard: [
      { text: '崔三 · 2026-10-26 · 09:00「会议甲」与「会议乙」同一时刻', idA: 'a', idB: 'b' },
      { text: '韩七 · 2026-10-27 · 15:00「会议丁」与「会议戊」同一时刻', idA: 'c', idB: 'd' }
    ],
    soft: [],
    pending: [
      { key: 'x|y', name: '崔三', date: '2026-10-26', slot: 'pm', idA: 'x', idB: 'y',
        firstStart: '15:00', firstTitle: '会议甲', secondStart: '16:00', secondTitle: '会议乙', decision: null }
    ],
    byLeader: [{ name: '崔三', count: 3 }, { name: '韩七', count: 2 }],
    eventCount: 5, leaderCount: 2, dayCount: 2, pendingCount: 1
  };
  w.renderAlert(conflicts);
  const bar = doc.getElementById('alertBar');
  T('提示条已展开', bar.className === 'alertbar on');
  T('提示条内有明细按钮', !!doc.getElementById('cfToggle'));
  const pop = doc.getElementById('cfPop');
  T('明细浮层默认收起', !!pop && pop.hidden === true);
  T('浮层按领导统计场次', pop.textContent.includes('崔三') && pop.textContent.includes('3 场'));
  T('浮层放在提示条内部（绝对定位，不占高度）', pop.parentElement === bar);
  T('软冲突待确认项渲染裁决按钮', !!pop.querySelector('.cf-ok') && !!pop.querySelector('.cf-bad'));

  doc.getElementById('cfToggle').click();
  await new Promise((r) => setTimeout(r, 20));
  T('点「明细」后展开', doc.getElementById('cfPop').hidden === false);
  T('展开后按钮文案变为收起', /收起/.test(doc.getElementById('cfToggle').textContent));
  doc.getElementById('cfToggle').click();
  await new Promise((r) => setTimeout(r, 20));
  T('再点一次收起', doc.getElementById('cfPop').hidden === true);

  // 结构上没有会把提示条撑高的元素
  T('提示条内没有 details/summary 撑高', bar.querySelectorAll('details').length === 0);
  T('提示条只有一行文本块', bar.querySelectorAll('.cf-main').length === 1);
}
{
  // 无冲突时隐藏
  w.renderAlert({ ids: {}, hard: [], soft: [], pending: [], byLeader: [], eventCount: 0, leaderCount: 0, dayCount: 0, pendingCount: 0 });
  T('无冲突时整条隐藏', doc.getElementById('alertBar').className === 'alertbar');
}

/* ================== 四、样式层面：不许再出现「撑不开/裁字」 ================== */
console.log('\n--- 样式规则 ---');
{
  const alertRule = (css.match(/\.alertbar\{[^}]*\}/) || [''])[0];
  T('.alertbar 固定高度（不再被内容撑高）', /height:44px/.test(alertRule), alertRule);
  T('.alertbar 不换行', /flex-wrap:nowrap/.test(alertRule));

  const btnRule = (css.match(/\nbutton\{[^}]*\}/) || [''])[0];
  T('按钮默认允许换行', /white-space:normal/.test(btnRule), btnRule);
  T('按钮不会超过容器宽度', /max-width:100%/.test(btnRule), btnRule);
  T('按钮长词可断行', /overflow-wrap:anywhere/.test(btnRule), btnRule);

  const heroRule = (css.match(/\.sync-hero \.hero-actions button\{[^}]*\}/) || [''])[0];
  T('同步面板按钮不再 flex:none', !/flex:none/.test(heroRule) && /max-width:100%/.test(heroRule), heroRule);

  const inputRule = (css.match(/#input\{[^}]*\}/) || [''])[0];
  T('解析输入框高度自适应且可拉大', /clamp\(/.test(inputRule) && /resize:vertical/.test(inputRule), inputRule);
  T('解析输入框最大高度不再是 150px 硬顶', !/max-height:150px/.test(inputRule));
  T('小屏下不再压到 110px', !/max-height:110px/.test(css));

  T('bridge-chip 不再在 1320px 直接消失', !/#bridgeChip\{display:none\}/.test(css));

  // 关键：滚动容器里的子项禁止被 flex 压缩（否则输入框被压扁而不是滚动）
  T('左栏子项不压缩', /\.aside-scroll > \*\{[^}]*flex:0 0 auto/.test(css));
  T('弹窗内容不压缩', /\.modal-body > \*\{[^}]*flex:0 0 auto/.test(css));
  T('弹窗底部按钮可换行', /\.modal-foot\{[^}]*flex-wrap:wrap/.test(css));
}

/* ================== 五、真实计算样式（jsdom 能解析的项） ================== */
console.log('\n--- 计算样式 ---');
{
  const bar = doc.getElementById('alertBar');
  const cs = w.getComputedStyle(bar);
  T('计算高度为 44px', cs.height === '44px', cs.height);
  T('计算 flex-wrap 为 nowrap', cs.flexWrap === 'nowrap', cs.flexWrap);
  const btn = doc.getElementById('btnParse');
  const bcs = w.getComputedStyle(btn);
  T('普通按钮 white-space=normal', bcs.whiteSpace === 'normal', bcs.whiteSpace);
  const inp = doc.getElementById('input');
  const ics = w.getComputedStyle(inp);
  T('输入框可拖拽调整高度', ics.resize === 'vertical', ics.resize);
}

/* ================== 六、时间 / 地点解析修复回归 ================== */
console.log('\n--- 时间与地点 ---');
{
  const parse = (t) => (w.parseText(t, {
    leaders: w.state.leaders, keywords: w.state.keywords, refDate: new Date('2026-10-23')
  }) || [])[0] || {};

  let r = parse('10月28日下午3点 五楼会议室 月度工作调度会 崔三');
  T('「下午3点 五楼」不再被读成 3 点 05 分', r.start === '15:00', r.start);

  r = parse('2026-10-27 14:30 市政务中心3楼 全市安全生产会 崔三');
  T('「市政务中心3楼」能识别为地点', r.place === '市政务中心3楼', r.place);

  r = parse('10月28日下午3点 我局五楼会议室 月度工作调度会 崔三');
  T('「我局五楼会议室」不被截断成「我局五楼」', r.place === '我局五楼会议室', r.place);

  r = parse('10月28日 上午9:00 5楼3号 某会 崔三');
  T('「5楼3号」仍不被当成地点', !r.place, r.place);

  r = parse('10月28日下午3点15分 五楼会议室 某会 崔三');
  T('「3点15分」仍解析为 15:15', r.start === '15:15', r.start);

  r = parse('10月28日下午3点半 五楼会议室 某会 崔三');
  T('「3点半」仍解析为 15:30', r.start === '15:30', r.start);

  r = parse('10月28日 上午9:00 三楼会议室 某会 崔三');
  T('「三楼会议室」中文楼层正常', r.place === '三楼会议室', r.place);
}

/* ================== 七、结构化公文通知解析（分节通知） ================== */
console.log('\n--- 结构化通知 ---');
{
  const parse = (t) => (w.parseText(t, {
    leaders: w.state.leaders, keywords: w.state.keywords, refDate: new Date('2026-10-23')
  }) || [])[0] || {};

  // 用户原始场景：信访联席会议预通知
  let r = parse('关于召开市信访工作联席会议全体（扩大）会议暨信访群体专项工作小组第一次全体会议\n的预通知\n各区（市）信访工作联席办，市信访工作联席会议成员单位：\n根据工作安排，将于近期召开市信访联席会议全体（扩大）会议暨信访群体专项工作小组第一次全体会议，现将有关事项通知如下。\n一、会议时间\n2026年9月14日（星期一）下午14：30');
  T('信访通知：日期 2026-09-14', r.date === '2026-09-14', r.date);
  T('信访通知：时间 14:30', r.start === '14:30', r.start);
  T('信访通知：标题提取正确（含「信访」且非「未命名」）', r.title && /信访工作联席会议/.test(r.title) && r.title !== '未命名会议', r.title);
  T('信访通知：类型为市政府层面', r.type === 'city', r.type);

  // 完整四节：时间/地点/人员/内容
  r = parse('关于召开全市住建领域安全生产工作会议的通知\n各区（市）住建局，局机关各科室：\n根据工作安排，现将有关事项通知如下。\n一、会议时间\n2026年10月27日（星期二）上午9：00\n二、会议地点\n市政府三楼会议室\n三、参会人员\n韩七、杜四\n四、会议内容\n研究部署全市住建领域安全生产工作');
  T('完整通知：地点完整', r.place === '市政府三楼会议室', r.place);
  T('完整通知：识别到韩七', (r.leaders || []).some(l => l.name === '韩七'), JSON.stringify((r.leaders || []).map(l => l.name)));
  T('完整通知：识别到杜四', (r.leaders || []).some(l => l.name === '杜四'));
  T('完整通知：会议内容进入备注', /研究部署/.test(r.note || ''), r.note);

  // 字母房间号带「会议室」后缀要完整保留
  r = parse('关于召开局党组会议的通知\n局领导：\n现将有关事项通知如下。\n一、会议时间\n2026年10月26日（星期一）上午9：00\n二、会议地点\nB027会议室\n三、参会领导\n安一、崔三、谷六');
  T('字母房号：B027会议室 不被截成 B027', r.place === 'B027会议室', r.place);
  T('字母房号：类型为局内部', r.type === 'internal', r.type);
  T('字母房号：识别到安一', (r.leaders || []).some(l => l.name === '安一'));

  // 无标题通知：标题兜底为「未命名会议」，但地点/人员不能丢
  r = parse('一、会议时间\n2026年9月14日（星期一）下午14：30\n二、会议地点\n市信访局会议室\n三、参会人员\n请崔三参加');
  T('无标题通知：标题兜底「未命名会议」', r.title === '未命名会议', r.title);
  T('无标题通知：地点正确', r.place === '市信访局会议室', r.place);
  T('无标题通知：称谓「崔三」被识别', (r.leaders || []).some(l => l.name === '崔三'), JSON.stringify((r.leaders || []).map(l => l.name)));

  // 反例：普通一行会议（无分节结构）不能被 parseNotice 误接管
  r = parse('10月28日下午3点 五楼会议室 月度工作调度会 崔三');
  T('普通一行：仍走逐行解析，标题正确', r.title === '月度工作调度会', r.title);
}

console.log('\n--- 称谓识别（崔局 / 谷局 / 贺主任） ---');
{
  const cfg = () => ({ leaders: w.state.leaders, keywords: w.state.keywords, refDate: new Date('2026-10-23') });
  const leadersOf = (t) => (w.parseText(t, cfg()) || [])[0] || { leaders: [] };

  let r = leadersOf('10月28日上午9:00，B027，局党组扩大会议，请崔局参加');
  T('「崔局」识别为崔三', (r.leaders || []).some(l => l.name === '崔三'), JSON.stringify((r.leaders || []).map(l => l.name)));
  T('称谓不混进会议名', !/崔局/.test(r.title || ''), r.title);

  r = leadersOf('10月28日下午3点，A801，市政项目推进会，请谷局参会');
  T('「谷局」识别为谷六', (r.leaders || []).some(l => l.name === '谷六'), JSON.stringify((r.leaders || []).map(l => l.name)));

  r = leadersOf('10月28日上午10:00，B029，住房保障工作调度会，贺主任参加');
  T('「贺主任」识别为贺八（而非安一）', (r.leaders || []).some(l => l.name === '贺八') && !(r.leaders || []).some(l => l.name === '安一'), JSON.stringify((r.leaders || []).map(l => l.name)));

  r = leadersOf('10月28日上午9:00，B027，局党组会议，安局主持');
  T('「安局」识别为一把手安一', (r.leaders || []).some(l => l.name === '安一'), JSON.stringify((r.leaders || []).map(l => l.name)));

  r = leadersOf('10月28日上午9:00，B027，参会领导：杜局、韩局');
  T('「参会领导：杜局」识别为杜四', (r.leaders || []).some(l => l.name === '杜四'), JSON.stringify((r.leaders || []).map(l => l.name)));
  T('「参会领导：韩局」识别为韩七', (r.leaders || []).some(l => l.name === '韩七'), JSON.stringify((r.leaders || []).map(l => l.name)));
  T('不会把「杜局」当成人名存进去', !(r.leaders || []).some(l => /局$/.test(l.name)), JSON.stringify((r.leaders || []).map(l => l.name)));

  // 不是称谓的「局」不能被误认
  T('「我局」「市住建局」不当成称谓', w.aliasHits('我局召开会议，市住建局转发', cfg().leaders).length === 0,
    JSON.stringify(w.aliasHits('我局召开会议，市住建局转发', cfg().leaders)));

  // 推荐里称谓优先级最高：关键词指向别人，也要听称谓的
  const sug = w.recommendLeaders('10月28日 安全生产工作视频会议，请崔局参加', cfg());
  T('推荐时「崔局」压过关键词（安全生产→韩七）', sug && sug.name === '崔三', sug && sug.name);
  T('推荐结果标明依据称谓', !!(sug && sug.byAlias), sug && JSON.stringify(sug));

  // 已调出的人不再被推荐
  const sug2 = w.recommendLeaders('物业领域工作调度会，请姜局参加', cfg());
  T('已调出的姜九不会被推荐', !sug2 || sug2.name !== '姜九', sug2 && sug2.name);
}

console.log('\n--- 一格/一行里挤了多场会（分号分隔） ---');
{
  const cfg = () => ({ leaders: w.state.leaders, keywords: w.state.keywords, refDate: new Date('2026-10-23') });
  const cell = (raw) => w.parseDocCell(raw, '2026-10-28');

  // 用户报的原始场景：一格两场会，全挤在一行里
  const ONE = '1. 14:30，在市政府5楼2号会议室，参加严秘调度房地产事项会议；2. 15:45，在市政府3楼会议室，参加扫黑除恶大会。';
  let r = cell(ONE);
  T('单行两场会拆成 2 条', r.length === 2, '条数 ' + r.length);
  T('第 1 场时间是 14:30（不是 15:45）', r[0] && r[0].start === '14:30', r[0] && r[0].start);
  T('第 1 场名称是「严秘调度房地产事项会议」', r[0] && /严秘调度房地产事项会议/.test(r[0].title), r[0] && r[0].title);
  T('第 1 场地点是 5楼2号会议室', r[0] && /5楼2号会议室/.test(r[0].place || ''), r[0] && r[0].place);
  T('第 2 场时间是 15:45', r[1] && r[1].start === '15:45', r[1] && r[1].start);
  T('第 2 场名称是「扫黑除恶大会」', r[1] && /扫黑除恶大会/.test(r[1].title), r[1] && r[1].title);
  T('第 2 场地点是 3楼会议室', r[1] && /3楼会议室/.test(r[1].place || ''), r[1] && r[1].place);
  T('标题里不残留序号「1.」「2.」', !r.some(x => /^\s*\d/.test(x.title)), JSON.stringify(r.map(x => x.title)));

  // 换成真换行，结果必须一致
  r = cell('1. 14:30，在市政府5楼2号会议室，参加严秘调度房地产事项会议；\n2. 15:45，在市政府3楼会议室，参加扫黑除恶大会。');
  T('改成硬换行后同样是 2 条且内容一致', r.length === 2 && r[0].start === '14:30' && r[1].start === '15:45',
    JSON.stringify(r.map(x => x.start + ' ' + x.title)));

  // 三场会
  r = cell('1. 9:00，在B027，参加局党组会；2. 14:30，在市政府5楼2号会议室，参加房地产调度会；3. 16:00，在A702，参加物业例会。');
  T('三场会拆成 3 条', r.length === 3, '条数 ' + r.length);
  T('三场会时间依次为 9:00 / 14:30 / 16:00', r.map(x => x.start).join(',') === '09:00,14:30,16:00', r.map(x => x.start).join(','));

  // 分号后面只是补充说明，不能当成第二场会
  r = cell('15:30，在市政府5楼3号会议室，参加桂秘调度书记楼事项会议；请提前10分钟到场');
  T('分号后是说明时仍只有 1 条', r.length === 1, '条数 ' + r.length);
  T('说明不会污染会议名', r[0] && /桂秘调度书记楼事项会议/.test(r[0].title), r[0] && r[0].title);

  // 单场会的老行为不能被破坏
  r = cell('上午9:00，在B635，青年群体专项工作小组第一次全体会议');
  T('单场会仍解析为 1 条', r.length === 1 && r[0].title === '青年群体专项工作小组第一次全体会议', JSON.stringify(r));
  T('状态格「调出」仍不当会议', cell('调出').length === 0, JSON.stringify(cell('调出')));

  // 「1. 14:30」不能被当成日期 1月14日
  const norm = w.normalizeText('10月28日 1. 14:30，在市政府5楼2号会议室开会');
  T('「1. 14:30」不会被改写成「1月14日」', !/1月14日/.test(norm), norm);
  T('「10.31」这种点号日期仍然认', /10月31日/.test(w.normalizeText('10.31 下午3点 某会')), w.normalizeText('10.31 下午3点 某会'));

  // 粘贴路径：一行两场会
  r = w.parseText('10月28日 1. 14:30，在市政府5楼2号会议室，参加严秘调度房地产事项会议；2. 15:45，在市政府3楼会议室，参加扫黑除恶大会。', cfg());
  T('粘贴一行两场也拆成 2 条', r.length === 2, '条数 ' + r.length);
  T('粘贴拆出的日期都落在 10-28', r.every(x => x.date === '2026-10-28'), JSON.stringify(r.map(x => x.date)));
  T('粘贴拆出的时间分别是 14:30 / 15:45', r.map(x => x.start).join(',') === '14:30,15:45', r.map(x => x.start).join(','));

  // 粘贴路径：日期一行、两场会议各占一行
  r = w.parseText('10月28日\n1. 14:30，在市政府5楼2号会议室，参加严秘调度房地产事项会议；\n2. 15:45，在市政府3楼会议室，参加扫黑除恶大会。', cfg());
  T('日期单独一行、下面两场会也能拆成 2 条', r.length === 2, '条数 ' + r.length + ' ' + JSON.stringify(r.map(x => x.start + ' ' + x.title)));
  T('这种写法日期不丢', r.every(x => x.date === '2026-10-28'), JSON.stringify(r.map(x => x.date)));

  // 反例：时间区间、会议名里带分号，都不该多拆
  r = w.parseText('10月28日 上午9:00-11:00 五楼会议室 全市安全生产工作会议', cfg());
  T('时间区间不会被拆成两场', r.length === 1 && r[0].start === '09:00', JSON.stringify(r.map(x => x.start)));

  r = w.parseText('10月28日下午3点 五楼会议室 月度工作调度会；请各科室准时参加。', cfg());
  T('粘贴时「分号+说明」也不拆', r.length === 1 && /月度工作调度会/.test(r[0].title), JSON.stringify(r.map(x => x.title)));
}

console.log('\n' + (fail ? `❌ 失败 ${fail} 项 / 共 ${pass + fail} 项` : `✅ 全部 ${pass} 项通过`));
process.exit(fail ? 1 : 0);
