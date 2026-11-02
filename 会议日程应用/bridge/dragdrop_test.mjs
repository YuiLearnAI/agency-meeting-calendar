// 拖拽文件解析回归测试：验证 drop 事件绑定与触发
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
    w.URL.createObjectURL = () => 'blob:fake';
  }
});
const w = dom.window;
await new Promise((r) => setTimeout(r, 800));

console.log('--- 拖拽绑定 ---');
const aside = w.document.getElementById('aside');
const input = w.document.getElementById('input');
T('aside 元素存在', !!aside);
T('textarea 元素存在', !!input);
T('aside 有 drop-overlay 子元素', !!aside.querySelector('.drop-overlay'));

// 拦截 extractFiles，追踪是否被调用
let extractCalled = 0;
let extractArgs = null;
const origExtractFiles = w.extractFiles;
w.extractFiles = function(files){
  extractCalled++;
  extractArgs = files;
};

console.log('--- 模拟 drop 到 textarea ---');
{
  const fakeFile = { name: 'test.docx', size: 123 };
  const files = [fakeFile];
  const dataTransfer = { files, dropEffect: '', effectAllowed: 'all' };
  // 构造 drop 事件
  const dropEvt = new w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(dropEvt, 'dataTransfer', { value: dataTransfer });
  input.dispatchEvent(dropEvt);
  await new Promise((r) => setTimeout(r, 50));
  T('drop 到 textarea 触发 extractFiles', extractCalled === 1, 'called=' + extractCalled);
  T('传入的 files 正确', extractArgs && extractArgs[0] && extractArgs[0].name === 'test.docx');
}

console.log('--- 模拟 drop 到 aside ---');
{
  extractCalled = 0;
  const files = [{ name: 'a.docx' }, { name: 'b.pdf' }];
  const dataTransfer = { files, dropEffect: '' };
  const dropEvt = new w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(dropEvt, 'dataTransfer', { value: dataTransfer });
  aside.dispatchEvent(dropEvt);
  await new Promise((r) => setTimeout(r, 50));
  T('drop 到 aside 触发 extractFiles', extractCalled === 1, 'called=' + extractCalled);
  T('多文件一次传入', extractArgs && extractArgs.length === 2);
}

console.log('--- 模拟 dragover 高亮 ---');
{
  const dragoverEvt = new w.Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(dragoverEvt, 'dataTransfer', { value: { dropEffect: '' } });
  input.dispatchEvent(dragoverEvt);
  T('dragover 后 aside 加高亮类', aside.classList.contains('dragover'));
  // dragleave 移除
  const leaveEvt = new w.Event('dragleave', { bubbles: true, cancelable: true });
  leaveEvt.relatedTarget = null;
  aside.dispatchEvent(leaveEvt);
  T('dragleave 后移除高亮类', !aside.classList.contains('dragover'));
}

console.log('--- extractFiles 批量逻辑 ---');
{
  w.extractFiles = origExtractFiles; // 还原
  // 直接测 extractFiles 入口
  let localCalls = [];
  w.extractLocalFile = function(f){ localCalls.push(f.name); };
  w.extractFiles([{name:'x.docx'},{name:'y.pdf'},{name:'z.png'}]);
  T('extractFiles 逐个调 extractLocalFile', localCalls.length === 3, JSON.stringify(localCalls));
  T('按顺序处理', localCalls.join(',') === 'x.docx,y.pdf,z.png');
}

console.log('\n===== 结果：' + pass + ' PASS / ' + fail + ' FAIL =====');
process.exit(fail ? 1 : 0);
