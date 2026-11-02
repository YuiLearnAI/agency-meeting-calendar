// 文件夹监听 · 前端交互回归：右下角提醒卡片、导入/忽略、设置面板
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

const calls = [];               // 记录前端发起的接口调用
let stateResp = null;           // /api/watch/state 的返回

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
    w.fetch = async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, opts });
      let body = { ok: true };
      if (u.indexOf('/api/watch/state') >= 0) body = stateResp || { ok: true, rev: 1, changed: false, pending: [], pendingCount: 0 };
      else if (u.indexOf('/api/watch/act') >= 0) body = { ok: true, rev: 99 };
      else if (u.indexOf('/api/watch/roots') >= 0) body = { ok: true, roots: [{ label: '桌面', path: 'C:\\Users\\x\\Desktop' }] };
      else if (u.indexOf('/api/watch/dirs') >= 0) body = { ok: true, path: 'C:\\Users\\x', dirs: ['会议通知', 'Downloads'] };
      else if (u.indexOf('/api/watch/check') >= 0) body = { ok: true, count: 3, files: ['a.docx', 'b.pdf'] };
      else if (u.indexOf('/api/watch/config') >= 0) body = { ok: true, rev: 5, enabled: true, folder: 'C:\\Users\\x', interval: 3000, pending: [], pendingCount: 0 };
      else if (u.indexOf('/api/ping') >= 0) body = { ok: true, version: '1.3.0', features: ['snapshot', 'push', 'remove', 'report', 'extract', 'watch'], authed: true };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
  }
});
const w = dom.window;
const doc = w.document;
await new Promise((r) => setTimeout(r, 250));

/* ---------- 一、入口存在 ---------- */
console.log('--- 入口 ---');
T('更多菜单里有「文件监听」按钮', !!doc.getElementById('btnWatch'), '');
T('页面有右下角提醒容器', !!doc.getElementById('watchStack'));
T('容器默认是空的（不占位）', doc.getElementById('watchStack').innerHTML === '');
T('WATCH 状态对象已就绪', typeof w.WATCH === 'object' && !!w.WATCH, typeof w.WATCH);

/* ---------- 二、卡片渲染 ---------- */
console.log('\n--- 提醒卡片 ---');
w.BRIDGE.online = true;
w.BRIDGE.features = ['watch'];
w.BRIDGE.base = '';

stateResp = {
  ok: true, rev: 3, changed: true, enabled: true, folder: 'C:\\inbox', interval: 3000,
  pendingCount: 3,
  pending: [
    { id: 'aa1', name: '物业会议通知.docx', path: 'C:\\inbox\\物业会议通知.docx', at: Date.now(), ok: true,
      text: '关于召开全市物业管理工作会议的通知\n一、会议时间\n2026年10月30日（星期五）上午9：00\n二、会议地点\nB027会议室\n三、参会人员\n杜四、谷六', error: '' },
    { id: 'bb2', name: '信访预通知.pdf', path: 'C:\\inbox\\信访预通知.pdf', at: Date.now(), ok: true,
      text: '关于召开市信访工作联席会议全体（扩大）会议\n的预通知\n一、会议时间\n2026年9月14日（星期一）下午14：30\n二、会议地点\n市信访局会议室', error: '' },
    { id: 'cc3', name: '扫描件.png', path: 'C:\\inbox\\扫描件.png', at: Date.now(), ok: false, text: '', error: '未提取到文字内容' }
  ]
};

await w.watchPollOnce();
const stack = doc.getElementById('watchStack');
T('轮询后渲染出 3 张卡片', stack.querySelectorAll('.wcard').length === 3, String(stack.querySelectorAll('.wcard').length));
T('卡片显示文件名', stack.textContent.indexOf('物业会议通知.docx') >= 0);
T('卡片显示识别出的日期', stack.textContent.indexOf('2026-10-30') >= 0, stack.textContent.slice(0, 200));
T('卡片显示会议时间', stack.textContent.indexOf('09:00') >= 0);
T('卡片显示地点', stack.textContent.indexOf('B027会议室') >= 0);
T('卡片显示会议名', stack.textContent.indexOf('全市物业管理工作会议') >= 0);
T('解析失败的文件有独立样式', stack.querySelectorAll('.wcard.bad').length === 1,
  String(stack.querySelectorAll('.wcard.bad').length));
T('解析失败时给出原因', stack.textContent.indexOf('未提取到文字内容') >= 0);
T('可解析的卡片有「导入到日历」', stack.querySelectorAll('button[data-act="import"]').length === 2,
  String(stack.querySelectorAll('button[data-act="import"]').length));
T('失败卡片不显示导入按钮', stack.querySelector('.wcard.bad').querySelector('button[data-act="import"]') === null);
T('菜单按钮出现待办角标', !!doc.querySelector('#btnWatch .watch-badge') &&
  doc.querySelector('#btnWatch .watch-badge').textContent === '3',
  (doc.querySelector('#btnWatch .watch-badge') || {}).textContent);

/* ---------- 三、点 ✕ 只隐藏本次，不删队列 ---------- */
console.log('\n--- 关闭单张卡片 ---');
{
  const before = w.WATCH.items.length;
  stack.querySelector('.wcard[data-id="bb2"] .wc-x').click();
  await new Promise((r) => setTimeout(r, 30));
  T('点 ✕ 后该卡片不再显示', stack.querySelectorAll('.wcard').length === 2, String(stack.querySelectorAll('.wcard').length));
  T('点 ✕ 不删除队列（只是本次先不看）', w.WATCH.items.length === before, String(w.WATCH.items.length));
}

/* ---------- 四、导入到日历 ---------- */
console.log('\n--- 导入 ---');
{
  const before = w.state.events.length;
  const card = Array.from(stack.querySelectorAll('.wcard')).find((c) => c.getAttribute('data-id') === 'aa1');
  T('找到目标卡片', !!card);
  card.querySelector('button[data-act="import"]').click();
  await new Promise((r) => setTimeout(r, 120));

  T('日历里多了一场会议', w.state.events.length === before + 1, `${w.state.events.length} vs ${before + 1}`);
  const ev = w.state.events[w.state.events.length - 1];
  T('导入的日期正确', ev.date === '2026-10-30', ev.date);
  T('导入的时间正确', ev.start === '09:00', ev.start);
  T('导入的地点正确', ev.place === 'B027会议室', ev.place);
  T('导入的会议名正确', /物业管理工作会议/.test(ev.title), ev.title);
  T('导入的参会领导正确', (ev.leaders || []).some((l) => l.name === '杜四'),
    JSON.stringify((ev.leaders || []).map((l) => l.name)));
  T('已通知服务端标记导入', calls.some((c) => c.url.indexOf('/api/watch/act') >= 0),
    JSON.stringify(calls.map((c) => c.url).slice(-4)));
  T('处理后该卡片消失', !Array.from(stack.querySelectorAll('.wcard')).some((c) => c.getAttribute('data-id') === 'aa1'));

  // 重复导入要拦下来
  const before2 = w.state.events.length;
  w.watchImport('bb2');
  await new Promise((r) => setTimeout(r, 120));
  const before3 = w.state.events.length;
  w.WATCH.items = w.WATCH.items.concat([{ id: 'bb2b', name: '信访预通知.pdf', ok: true, text: stateResp.pending[1].text }]);
  w.WATCH.parsed = {};
  w.watchImport('bb2b');
  await new Promise((r) => setTimeout(r, 120));
  T('同一场会重复导入会被跳过', w.state.events.length === before3, `${w.state.events.length} vs ${before3}`);
  T('第一次导入信访会议成功', before2 + 1 === before3, `${before3} vs ${before2 + 1}`);
}

/* ---------- 五、忽略 ---------- */
console.log('\n--- 忽略 ---');
{
  const n0 = calls.filter((c) => c.url.indexOf('/api/watch/act') >= 0).length;
  const card = Array.from(stack.querySelectorAll('.wcard'))[0];
  if (card) {
    card.querySelector('button[data-act="ignore"]').click();
    await new Promise((r) => setTimeout(r, 80));
  }
  const n1 = calls.filter((c) => c.url.indexOf('/api/watch/act') >= 0).length;
  T('点「忽略」会调用服务端标记', n1 === n0 + 1, `${n1} vs ${n0 + 1}`);
}

/* ---------- 六、设置面板 ---------- */
console.log('\n--- 设置面板 ---');
{
  w.WATCH.enabled = true;
  w.WATCH.folder = 'C:\\inbox';
  w.WATCH.interval = 3000;
  w.WATCH.items = [];
  w.openWatchPanel();
  await new Promise((r) => setTimeout(r, 120));

  T('面板标题是「文件监听」', doc.getElementById('modalTitle').textContent === '文件监听');
  T('有开关', !!doc.getElementById('wEnabled'));
  T('开关反映当前状态', doc.getElementById('wEnabled').checked === true);
  T('有路径输入框', !!doc.getElementById('wFolder'));
  T('路径回填正确', doc.getElementById('wFolder').value === 'C:\\inbox', doc.getElementById('wFolder').value);
  T('有扫描频率选择', !!doc.getElementById('wInterval'));
  T('频率回填正确', doc.getElementById('wInterval').value === '3000', doc.getElementById('wInterval').value);
  T('列出常用位置', doc.getElementById('wRoots').textContent.indexOf('桌面') >= 0,
    doc.getElementById('wRoots').textContent);
  T('可点选子目录', doc.getElementById('wDirs').textContent.indexOf('会议通知') >= 0,
    doc.getElementById('wDirs').textContent);
  T('说明里写明只在本机解析', /不联网/.test(doc.getElementById('modalBody').textContent));

  // 点常用位置应写入路径
  const chip = doc.querySelector('#wRoots button[data-p]');
  if (chip) {
    chip.click();
    await new Promise((r) => setTimeout(r, 60));
  }
  T('点常用位置会填入路径', doc.getElementById('wFolder').value === 'C:\\Users\\x\\Desktop',
    doc.getElementById('wFolder').value);

  // 保存配置
  const saveBtn = doc.getElementById('wSave');
  saveBtn.click();
  await new Promise((r) => setTimeout(r, 120));
  T('保存会调用 config 接口', calls.some((c) => c.url.indexOf('/api/watch/config') >= 0),
    JSON.stringify(calls.map((c) => c.url).slice(-3)));
  T('保存后关闭面板', doc.getElementById('backdrop').hidden === true);
}

/* ---------- 七、样式与安全 ---------- */
console.log('\n--- 样式 ---');
{
  const rule = (css.match(/\.watch-stack\{[^}]*\}/) || [''])[0];
  T('提醒栈固定在右下角', /position:fixed/.test(rule) && /right:18px/.test(rule) && /bottom:18px/.test(rule), rule);
  T('提醒栈不挡点击（容器本身穿透）', /pointer-events:none/.test(rule), rule);
  T('空容器不占位', /\.watch-stack:empty\{display:none\}/.test(css));
  T('卡片自身可点击', /\.wcard\{[^}]*pointer-events:auto/.test(css), (css.match(/\.wcard\{[^}]*\}/) || [''])[0]);
  T('卡片有入场动画', /@keyframes wcardIn/.test(css));
  T('窄屏下改为通栏', /@media\(max-width:640px\)\{\.watch-stack\{[^}]*left:10px/.test(css));
  T('卡片文字用主题色（不用写死白/黑）', /\.wc-title\{[^}]*color:var\(--txt\)/.test(css),
    (css.match(/\.wc-title\{[^}]*\}/) || [''])[0]);

  // 和右下角「参会统计卡」不能互相压住
  T('统计卡会为提醒让位（CSS 规则存在）', /body\.watch-on \.fp\{[^}]*bottom:calc/.test(css),
    (css.match(/body\.watch-on \.fp\{[^}]*\}/) || [''])[0]);
  T('提醒栈超高时自身滚动，不顶穿屏幕', /max-height:min\(70vh/.test((css.match(/\.watch-stack\{[^}]*\}/) || [''])[0]),
    (css.match(/\.watch-stack\{[^}]*\}/) || [''])[0]);
}

/* ---------- 八、XSS ---------- */
console.log('\n--- 安全 ---');
{
  w.WATCH.items = [{ id: 'xss1', name: '<img src=x onerror=alert(1)>.docx', ok: true,
    text: '10月30日上午9:00 B027 <script>alert(2)</script>会议' }];
  w.WATCH.hidden = {};
  w.WATCH.parsed = {};
  w.renderWatchCards();
  const box = doc.getElementById('watchStack');
  T('文件名里的 HTML 被转义', box.querySelectorAll('img').length === 0);
  T('会议名里的 script 被转义', box.querySelectorAll('script').length === 0);
  T('仍以纯文本显示文件名', box.textContent.indexOf('onerror') >= 0);

  // 有卡片时 body 打标记 → 统计卡让位
  T('有卡片时给 body 打标记', doc.body.classList.contains('watch-on'), doc.body.className);
  w.WATCH.items = [];
  w.renderWatchCards();
  T('卡片清空后标记移除', !doc.body.classList.contains('watch-on'), doc.body.className);
  T('卡片清空后容器为空', box.innerHTML === '');
}

console.log('\n' + (fail ? `❌ 失败 ${fail} 项 / 共 ${pass + fail} 项` : `✅ 全部 ${pass} 项通过`));
process.exit(fail ? 1 : 0);
