// 同步面板「删除同步」按钮的端到端回归测试（真实 DOM + 真实点击事件，网络层用桩）
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

const ISO = '2026-10-29';
const CELL = '上午9:00，B027 会议室，污水治理专题调度会';
const COLS = ['崔三', '姜九', '杜四', '谷六', '韩七', '贺八'];

function makeEvent() {
  return {
    id: 'ev_test_1', date: ISO, start: '09:00', place: 'B027 会议室',
    title: '污水治理专题调度会', type: 'city', note: '',
    leaders: [{ name: '谷六', role: '党组成员、副局长' }],
    syncedAt: new Date().toISOString(), skippedAt: null
  };
}

async function boot(opts = {}) {
  const calls = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  vc.on('error', () => {});

  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:7788/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      // 本地数据：一条已登记会议 + 对应云文档快照
      const snap = { at: new Date().toISOString(), cols: COLS.slice(), cells: { [ISO + '|谷六']: CELL }, source: 'file' };
      w.localStorage.setItem('ytzj_meeting_calendar_v1', JSON.stringify({
        events: opts.noEvent ? [] : [makeEvent()],
        trash: [], leaders: [], theme: 'dark', weekStart: null, statsOpen: false,
        docColumns: COLS, docSnapshot: snap
      }));
      w.localStorage.setItem('ytzj_doc_history_imported_v1', '1');
      w.localStorage.setItem('ytzj_kw_patch_v2', '1');

      w.confirm = () => true;
      w.alert = () => {};
      if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

      w.fetch = async (url, init) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, '');
        const body = init && init.body ? JSON.parse(init.body) : null;
        calls.push({ path, body });
        const reply = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });

        if (path.startsWith('/api/ping')) {
          const base = { ok: true, authed: opts.offline ? false : true, doc: { name: '会议安排' }, version: '1.1.0' };
          // oldServer: 老版本服务，ping 里没有 features 或没有 remove
          if (opts.oldServer) {
            base.version = '1.0.0';
            if (!opts.noFeatures) base.features = ['snapshot', 'push'];   // 老服务不返回 features 时字段整个缺失
          }
          else if (!opts.noFeatures) { base.features = ['snapshot', 'push', 'remove', 'report']; }
          return reply(base);
        }
        if (path.startsWith('/api/snapshot')) {
          return reply({ ok: true, snapshot: { at: new Date().toISOString(), cols: COLS, cells: { [ISO + '|谷六']: CELL } } });
        }
        if (path.startsWith('/api/push')) {
          return reply({ ok: true, written: [], duplicates: [], skipped: [], rowsCreated: [],
            snapshot: { at: new Date().toISOString(), cols: COLS, cells: { [ISO + '|谷六']: CELL } } });
        }
        if (path.startsWith('/api/remove')) {
          // 模拟老服务：该路由不存在
          if (opts.oldServer) {
            return { ok: false, status: 404, text: async () => JSON.stringify({ ok: false, error: '未知接口' }) };
          }
          return reply({ ok: true,
            removed: (body.items || []).map((it) => ({ date: it.date, leader: it.leader, text: it.title })),
            notFound: [], emptied: [],
            snapshot: { at: new Date().toISOString(), cols: COLS, cells: {} } });
        }
        return reply({ ok: true });
      };
    }
  });

  const w = dom.window;
  // 等 init() 与 probeBridge() 完成
  await new Promise((r) => setTimeout(r, 350));
  return { dom, w, calls, doc: w.document };
}

const flush = (n = 8) => new Promise((r) => { let i = 0; const tick = () => (++i >= n ? r() : setTimeout(tick, 25)); tick(); });

function idsIn(doc) {
  return [...doc.querySelectorAll('[id]')].map((el) => el.id);
}
function dupIds(doc) {
  const seen = {}, dup = [];
  idsIn(doc).forEach((id) => { if (seen[id]) { if (dup.indexOf(id) < 0) dup.push(id); } else seen[id] = 1; });
  return dup;
}

/* ============ 场景 1：删除一场会议后，面板里能同步删除 ============ */
console.log('--- 场景1：删除已登记会议 → 同步删除 ---');
{
  const { w, calls, doc } = await boot();
  T('同步服务已连上且已登录', w.BRIDGE.online === true && w.BRIDGE.authed === true);

  // 用户操作：打开会议 → 点删除
  w.openEventModal('ev_test_1');
  await flush(2);
  doc.getElementById('mDel').click();
  await flush(2);
  T('删除后产生了待清理记录（trash=1）', w.state.trash.length === 1, 'trash=' + w.state.trash.length);
  T('会议已从日历移除', w.state.events.length === 0);

  // 用户操作：点「⬆ 同步云文档」
  w.openSync(false);
  await flush(2);

  const rmBtns = [...doc.querySelectorAll('[data-act="syncRemove"]')];
  T('面板里出现删除按钮', rmBtns.length >= 1, '个数=' + rmBtns.length);
  T('删除按钮都绑定了点击处理', rmBtns.length > 0 && rmBtns.every((b) => typeof b.onclick === 'function'),
    rmBtns.map((b) => typeof b.onclick).join(','));
  T('面板内没有重复 id', dupIds(doc).length === 0, dupIds(doc).join(','));

  const footBtn = doc.querySelector('#modalFoot [data-act="syncRemove"]');
  T('底部「只同步删除」按钮存在且未禁用', !!footBtn && !footBtn.disabled);
  T('底部按钮文案含「删除」', !!footBtn && /删除/.test(footBtn.textContent), footBtn && footBtn.textContent);

  // 点击底部按钮（原来这里点了没反应）
  const before = calls.filter((c) => c.path.startsWith('/api/remove')).length;
  footBtn.click();
  await flush(12);

  const rmCalls = calls.filter((c) => c.path.startsWith('/api/remove'));
  T('点击后确实发起了删除请求', rmCalls.length === before + 1, 'remove 调用=' + rmCalls.length);
  T('删除请求带上了正确的登记', rmCalls.length > 0 && rmCalls[0].body.items.length === 1 &&
    rmCalls[0].body.items[0].date === ISO && rmCalls[0].body.items[0].leader === '谷六',
    JSON.stringify(rmCalls[0] && rmCalls[0].body));

  T('删除成功后待清理队列已清空', w.state.trash.length === 0, 'trash=' + w.state.trash.length);
  const bodyTxt = doc.getElementById('modalBody').textContent || '';
  T('结果页显示已删除条数', /从云文档删除\s*1\s*处/.test(bodyTxt.replace(/\s+/g, ' ')), bodyTxt.slice(0, 160));
  T('结果页逐条列出删除项', /已删除/.test(bodyTxt));

  // 关闭后角标归零
  w.closeModal();
  await flush(2);
  const badge = doc.getElementById('syncBadge');
  T('同步角标不再提示待删除', !badge || !badge.textContent || badge.textContent === '', badge && badge.textContent);
}

/* ============ 场景 2：面板内「只删除这 N 处」按钮 ============ */
console.log('\n--- 场景2：面板内的独立删除按钮 ---');
{
  const { w, calls, doc } = await boot();
  w.openEventModal('ev_test_1');
  await flush(2);
  doc.getElementById('mDel').click();
  await flush(2);
  w.openSync(false);
  await flush(2);

  const inBody = doc.querySelector('#modalBody [data-act="syncRemove"]');
  T('面板正文里有独立删除按钮', !!inBody);
  const before = calls.filter((c) => c.path.startsWith('/api/remove')).length;
  inBody.click();
  await flush(12);
  const rmCalls = calls.filter((c) => c.path.startsWith('/api/remove'));
  T('正文按钮也能真正发起删除', rmCalls.length === before + 1);
  T('正文按钮删除后队列清空', w.state.trash.length === 0);
}

/* ============ 场景 3：同时有待写入 + 待删除 ============ */
console.log('\n--- 场景3：写入与删除同时进行 ---');
{
  const { w, calls, doc } = await boot();
  // 再加一场待写入的新会议
  w.state.events.push({
    id: 'ev_new', date: '2026-11-02', start: '15:00', place: 'B027',
    title: '新增的调度会', type: 'city', note: '',
    leaders: [{ name: '崔三', role: '一级调研员' }], syncedAt: null, skippedAt: null
  });
  w.saveState();

  w.openEventModal('ev_test_1');
  await flush(2);
  doc.getElementById('mDel').click();
  await flush(2);
  w.openSync(false);
  await flush(2);

  const hero = doc.querySelector('.sync-hero.live [data-act="syncDirect"]');
  T('顶部出现「立即同步（写入 + 删除）」', !!hero && /删除/.test(hero.textContent) && /写入/.test(hero.textContent),
    hero && hero.textContent);
  const beforePush = calls.filter((c) => c.path.startsWith('/api/push')).length;
  const beforeRm = calls.filter((c) => c.path.startsWith('/api/remove')).length;
  hero.click();
  await flush(16);
  T('先写后删：写入请求已发出', calls.filter((c) => c.path.startsWith('/api/push')).length === beforePush + 1);
  T('先写后删：删除请求也发出', calls.filter((c) => c.path.startsWith('/api/remove')).length === beforeRm + 1);
  T('删除队列已清空', w.state.trash.length === 0);
}

/* ============ 场景 4：未启动同步服务时给出明确指引 ============ */
console.log('\n--- 场景4：未连服务时的降级提示 ---');
{
  const { w, doc } = await boot({ offline: true });
  T('未登录状态下 BRIDGE.authed=false', w.BRIDGE.authed === false);
  w.openEventModal('ev_test_1');
  await flush(2);
  doc.getElementById('mDel').click();
  await flush(2);
  w.openSync(false);
  await flush(2);

  const hintBtn = doc.querySelector('#rmNeedBridge, #rmNeedBridge2');
  T('不再渲染一个点不动的删除按钮，而是给出提示按钮', !!hintBtn);
  T('提示按钮有绑定处理', !!hintBtn && typeof hintBtn.onclick === 'function');
  const dead = [...doc.querySelectorAll('[data-act="syncRemove"]')];
  T('未连服务时不出现直连删除按钮', dead.length === 0, '个数=' + dead.length);
  hintBtn.click();
  await flush(2);
  const toastTxt = doc.getElementById('toast') ? doc.getElementById('toast').textContent : '';
  T('点击提示按钮给出启动指引', /启动同步服务|同步服务/.test(toastTxt), toastTxt);
}

/* ============ 场景 5：没有删除需求时不出现删除区块 ============ */
console.log('\n--- 场景5：无删除需求 ---');
{
  const { w, doc } = await boot();
  w.openSync(false);
  await flush(2);
  T('没有删除记录时不显示删除区块', doc.querySelectorAll('.sync-rm').length === 0);
  T('没有删除记录时不出现删除按钮', doc.querySelectorAll('[data-act="syncRemove"]').length === 0);
  T('此场景下也没有重复 id', dupIds(doc).length === 0, dupIds(doc).join(','));
}

/* ============ 场景 6：服务是旧版本（有 features 但缺 remove） ============ */
console.log('\n--- 场景6：旧版服务（缺 remove 能力） ---');
{
  const { w, calls, doc } = await boot({ oldServer: true });
  T('能识别出服务能力缺失', w.BRIDGE.features.join(',') === 'snapshot,push');
  T('bridgeStale() 为 true', w.bridgeStale() === true);

  w.openEventModal('ev_test_1');
  await flush(2);
  doc.getElementById('mDel').click();
  await flush(2);
  w.openSync(false);
  await flush(2);

  T('面板顶部出现旧版本警告条', doc.querySelectorAll('.sync-stale').length === 1);
  T('不渲染会失败的删除按钮', doc.querySelectorAll('[data-act="syncRemove"]').length === 0);
  const restartBtn = doc.getElementById('rmRestart') || doc.getElementById('rmRestart2');
  T('给出「点这里重启」的按钮', !!restartBtn);
  if (restartBtn) {
    restartBtn.click();
    await flush(2);
    T('点击后弹出重启指引', doc.getElementById('modalTitle').textContent === '重启同步服务',
      doc.getElementById('modalTitle').textContent);
    T('指引里写明重启后无需重新登录', /不用重新登录/.test(doc.getElementById('modalBody').textContent));
  }
  T('没有贸然发起删除请求', calls.filter((c) => c.path.startsWith('/api/remove')).length === 0);
}

/* ============ 场景 7：老服务无 features 字段，点了报「未知接口」也能兜住 ============ */
console.log('\n--- 场景7：未知接口兜底 ---');
{
  const { w, calls, doc } = await boot({ oldServer: true, noFeatures: true });
  T('老服务不返回 features 时视为未知', w.BRIDGE.features === null);
  // 去掉 stale 判定，强制放行按钮，让请求真的打到老服务上
  w.openEventModal('ev_test_1');
  await flush(2);
  doc.getElementById('mDel').click();
  await flush(2);
  w.openSync(false);
  await flush(2);
  const btn = doc.querySelector('#modalFoot [data-act="syncRemove"]');
  T('未知能力时先放行删除按钮（先试）', !!btn);
  if (btn) {
    btn.click();
    await flush(12);
    T('确实打到了不存在的老接口', calls.filter((c) => c.path.startsWith('/api/remove')).length === 1);
    T('不再显示原始报错，而是弹出重启指引', doc.getElementById('modalTitle').textContent === '重启同步服务',
      doc.getElementById('modalTitle').textContent);
    T('删除记录仍在队列里（没有假装成功）', w.state.trash.length === 1, 'trash=' + w.state.trash.length);
  }
}

console.log('\n' + (fail ? `❌ 失败 ${fail} 项 / 共 ${pass + fail} 项` : `✅ 全部 ${pass} 项通过`));
process.exit(fail ? 1 : 0);
