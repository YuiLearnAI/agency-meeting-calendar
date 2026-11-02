// 搜索功能回归测试：模糊匹配 + 结果渲染
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

/* ========== 模糊匹配 ========== */
console.log('--- 模糊匹配 ---');
T('fuzzyNorm 去空白标点', w.fuzzyNorm('安全生产  工作会议！') === '安全生产工作会议');
T('fuzzyNorm 去英文标点/大小写', w.fuzzyNorm('Meeting Room A-1') === 'meetingrooma1');
T('fuzzyMatch 直接子串', w.fuzzyMatch('全市住建领域安全生产工作会议', '安全生产') === true);
T('fuzzyMatch 忽略空白', w.fuzzyMatch('安全生产 工作会议', '安全工作') === true);
T('fuzzyMatch 逐字模糊(跳字)', w.fuzzyMatch('安全生产工作会议', '安工会议') === true);
T('fuzzyMatch 大小写不敏感', w.fuzzyMatch('Meeting', 'meet') === true);
T('fuzzyMatch 不匹配返回false', w.fuzzyMatch('安全生产', '房地产') === false);
T('fuzzyMatch 空关键词返回false', w.fuzzyMatch('安全生产', '') === false);

/* ========== 事件搜索文本 ========== */
console.log('--- 事件搜索字段 ---');
const ev = { title: '局党组会议', place: 'B027会议室', leaders: [{ name: '谷六' }], date: '2026-10-26', start: '9:00', note: '带材料', raw: '' };
const st = w.eventSearchText(ev);
T('搜索文本含标题', st.includes('局党组会议'));
T('搜索文本含地点', st.includes('B027会议室'));
T('搜索文本含领导名', st.includes('谷六'));
T('搜索文本含日期', st.includes('2026-10-26'));

/* ========== doSearch 结果渲染 ========== */
console.log('--- 搜索结果渲染 ---');
w.state.events = [
  { id: 'a1', title: '全市住建领域安全生产工作会议', place: '市政府三楼会议室', leaders: [{ name: '韩七' }], date: '2026-10-27', start: '14:30', note: '', raw: '' },
  { id: 'a2', title: '物业管理工作例会', place: '我局五楼会议室', leaders: [{ name: '杜四' }], date: '2026-10-28', start: '15:00', note: '', raw: '' },
  { id: 'a3', title: '局党组会议', place: 'B027会议室', leaders: [{ name: '谷六' }], date: '2026-10-26', start: '9:00', note: '', raw: '' },
];
const input = w.document.getElementById('searchInput');
const pop = w.document.getElementById('searchPop');

input.value = '安全生产';
w.doSearch();
T('搜索"安全生产"命中1条', pop.querySelectorAll('.s-item').length === 1);
T('结果含高亮mark', !!pop.querySelector('mark'));
T('结果含会议标题', pop.textContent.includes('安全生产'));

input.value = '谷六';
w.doSearch();
T('搜索领导名"谷六"命中1条', pop.querySelectorAll('.s-item').length === 1);

input.value = '会议';
w.doSearch();
T('搜索"会议"命中全部3条', pop.querySelectorAll('.s-item').length === 3);
T('结果按时间最新在前(10-28在最前)', pop.querySelector('.s-item .s-meta').textContent.includes('2026-10-28'));

// 同一日期内，时间晚的排前面
w.state.events = [
  { id: 'b1', title: '早会', place: '', leaders: [], date: '2026-10-30', start: '9:00', note: '', raw: '' },
  { id: 'b2', title: '晚会', place: '', leaders: [], date: '2026-10-30', start: '15:00', note: '', raw: '' },
];
input.value = '会';
w.doSearch();
T('同日多场：时间晚的在前(15:00在最前)', pop.querySelector('.s-item .s-meta').textContent.includes('15:00'));

input.value = '不存在的词';
w.doSearch();
T('搜索无结果显示空提示', pop.textContent.includes('没有匹配'));

input.value = '';
w.doSearch();
T('清空关键词收起结果', !pop.classList.contains('on'));

/* ========== 高亮 ========== */
console.log('--- 高亮 ---');
T('hl 高亮命中片段', w.hl('安全生产工作会议', '安全').includes('<mark>安全</mark>'));
T('hl 无命中返回原文', w.hl('安全生产', '房地产') === '安全生产');

console.log('\n===== 结果：' + pass + ' PASS / ' + fail + ' FAIL =====');
process.exit(fail ? 1 : 0);
