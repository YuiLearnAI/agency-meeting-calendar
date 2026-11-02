// 「更多 ▾」菜单回归：六项功能统一 4 字命名、提示语齐全、点进去对得上号
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
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  →  ' + extra : '')); }
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
await new Promise((r) => setTimeout(r, 250));

const btns = Array.prototype.slice.call(doc.querySelectorAll('#moreMenu button'));
// 只留汉字，去掉 emoji 与空格
const cn = (b) => (b.textContent || '').replace(/[^\u4e00-\u9fa5]/g, '');

console.log('--- 一、命名统一 4 字 ---');
T('菜单共 7 项', btns.length === 7, String(btns.length));
btns.forEach((b) => {
  T('「' + cn(b) + '」是 4 个字', cn(b).length === 4, cn(b) + '（' + cn(b).length + ' 字）');
});
T('名称依次为：参会统计 / 外出培训 / 文件监听 / 分工规则 / 数据管理 / 重启服务 / 主题切换',
  btns.map(cn).join(',') === '参会统计,外出培训,文件监听,分工规则,数据管理,重启服务,主题切换',
  btns.map(cn).join(','));
T('原来的「文件夹监听」已收成 4 字', !btns.some((b) => /文件夹监听/.test(b.textContent)), '');
T('原来的「分工与规则」已收成 4 字', !btns.some((b) => /分工与规则/.test(b.textContent)), '');

console.log('\n--- 二、每项都有悬停提示 ---');
btns.forEach((b) => {
  const t = b.getAttribute('title') || '';
  T('「' + cn(b) + '」有提示语', t.length >= 4, t || '（空）');
});

console.log('\n--- 二之二、图标定宽，文字左边缘对齐 ---');
T('每项图标都包在定宽的 .mi 里',
  btns.every((b) => b.firstElementChild && b.firstElementChild.className === 'mi'),
  btns.map((b) => (b.firstElementChild || {}).className || '（无）').join(','));
T('.mi 在样式里定宽、居中', /\.more-menu \.mi\{[^}]*width:1\.2em[^}]*text-align:center/.test(css),
  (css.match(/\.more-menu \.mi\{[^}]*\}/) || [''])[0]);

console.log('\n--- 三、点进去对得上号 ---');
const click = (id) => doc.getElementById(id).click();
const modalTitle = () => doc.getElementById('modalTitle').textContent;
const closeModal_ = () => { doc.getElementById('modalClose').click(); };

// 参会统计：打开右下角统计卡，标题带「参会统计」（先确保它是收起的）
w.setStatsOpen(false);
click('btnStats');
T('点「参会统计」弹出统计卡', doc.getElementById('fp').hidden === false);
T('统计卡标题对得上', /参会统计/.test(doc.getElementById('fpTitle').textContent), doc.getElementById('fpTitle').textContent);
click('btnStats');
T('再点一次收起', doc.getElementById('fp').hidden === true);

click('btnTrain');
T('点「外出培训」打开培训面板', modalTitle() === '领导外出培训', modalTitle());
closeModal_();

click('btnWatch');
T('点「文件监听」打开监听面板', modalTitle() === '文件监听', modalTitle());
closeModal_();

click('btnSettings');
T('点「分工规则」打开分工面板', modalTitle() === '分工规则', modalTitle());
closeModal_();

click('btnData');
T('点「数据管理」打开数据面板', modalTitle() === '数据管理', modalTitle());
closeModal_();

const themeBefore = doc.documentElement.getAttribute('data-theme') || doc.body.className || JSON.stringify(w.state.theme);
click('btnTheme');
const themeAfter = doc.documentElement.getAttribute('data-theme') || doc.body.className || JSON.stringify(w.state.theme);
T('点「主题切换」不弹窗、直接换主题', themeBefore !== themeAfter, themeBefore + ' → ' + themeAfter);
click('btnTheme');
const themeBack = doc.documentElement.getAttribute('data-theme') || doc.body.className || JSON.stringify(w.state.theme);
T('再点一次换回来', themeBack === themeBefore, themeBack);

console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项 / 共 ' + (pass + fail) + ' 项' : '✅ 全部 ' + pass + ' 项通过'));
process.exit(fail ? 1 : 0);
