/**
 * 云文档「应用状态」表 —— 跨设备共用的应用状态（与 HTTP 无关，便于单独测试）
 *
 * 为什么需要它：
 *   冲突裁决（连开/衔接、判为冲突、忽视）和外出培训记录原先只存在本机浏览器的 localStorage。
 *   换一台设备（手机、同事电脑）打开，同一批会议又冒出同样的冲突提示；培训区间也会被
 *   云文档里零散的两处「外出培训」标记重新读成两个孤立的日子。
 *   把这类「应用状态」写进云文档，任何设备打开都能读到同一份。
 *
 * 为什么不写进《会议安排》主表：
 *   主表是给人看的日历，塞进裁决记录会污染内容、也会被当会议读回来。
 *   所以另开一张工作表「应用状态」，主表一个字符都不动。
 *
 * 表结构：
 *   行 0 ：记录键 | 内容(JSON) | 更新时间
 *   行 1+：d|领导|日期|开始1|开始2   {"v":"ok"|"conflict","at":"ISO"}
 *          i|领导|日期|时刻          {"latest":毫秒或null,"at":"ISO"}
 *          t|领导|起|止|名称         {"leader","from","to","title","place","note","at","del"?}
 *
 * 合并规则：同 key 谁的 at 更新谁生效 —— 两台设备同时改也不会互相抹掉。
 */
import fs from 'node:fs';

export const STATE_SHEET_NAME = '应用状态';
export const HEAD = ['记录键', '内容(JSON)', '更新时间'];
export const NOTE = '本表由「领导会议日程」自动维护（冲突裁决 / 外出培训），请勿手工删除或修改；删了会导致手机端重复提示冲突。';

/** 值统一成 { ...payload, at }；at 用 ISO 字符串，字典序即时间序 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = String(raw.key || '').trim();
  if (!key || key.length > 200) return null;
  const v = (raw.v && typeof raw.v === 'object') ? raw.v : {};
  const out = Object.assign({}, v);
  if (!out.at) out.at = new Date(0).toISOString();
  out.at = String(out.at);
  return { key, v: out };
}

/** 两批条目按 key 合并（incoming 覆盖 base，条件是 at 不更旧） */
export function mergeEntries(base, incoming) {
  const map = new Map();
  for (const e of base || []) if (e && e.key) map.set(e.key, e);
  const changed = [];
  for (const e of incoming || []) {
    if (!e || !e.key) continue;
    const cur = map.get(e.key);
    if (!cur || String(e.v.at) >= String(cur.v.at)) {
      if (!cur || JSON.stringify(cur.v) !== JSON.stringify(e.v)) changed.push(e);
      map.set(e.key, e);
    }
  }
  return { entries: [...map.values()], changed };
}

/** 状态表里的「记录键」→ 页面认识的条目（纯函数，便于测试） */
export function entryFromRow(key, json) {
  let v = null;
  try { v = JSON.parse(json); } catch { v = null; }
  if (!v || typeof v !== 'object') return null;
  if (!v.at) v.at = new Date(0).toISOString();
  return { key, v };
}

export function createAppState({ kd, sheet, idCachePath, ttl = 15000 }) {
  let sid = 0;
  let cache = null;        // { at, entries, rowOf, sheetId, lastRow }

  function loadIdCache() {
    if (!idCachePath) return;
    try {
      const j = JSON.parse(fs.readFileSync(idCachePath, 'utf8'));
      if (j && j.sheetId) sid = Number(j.sheetId) || 0;
    } catch { /* 首次运行没有缓存 */ }
  }
  function saveIdCache() {
    if (!idCachePath) return;
    if (saveIdCache.last === sid) return;
    saveIdCache.last = sid;
    try { fs.writeFileSync(idCachePath, JSON.stringify({ sheetId: sid, at: new Date().toISOString() }), 'utf8'); } catch { /* 落盘失败不影响同步 */ }
  }
  saveIdCache.last = 0;
  loadIdCache();

  async function listSheets() {
    const info = await kd.call('sheet.get_sheets_info', { file_id: sheet.fileId });
    return (((info.data || {}).detail || {}).sheetsInfo) || [];
  }

  /** 找到（必要时创建）「应用状态」工作表，返回 { sheetId, lastRow } */
  async function ensureSheet(create) {
    const list = await listSheets();
    const hit = list.find((s) => String(s.sheetName || '').trim() === STATE_SHEET_NAME);
    if (hit) {
      sid = Number(hit.sheetId) || sid;
      saveIdCache();
      return { sheetId: hit.sheetId, lastRow: Number(hit.rowTo) || 0 };
    }
    if (!create) return null;
    await kd.call('sheet.add_sheet', { file_id: sheet.fileId, name: STATE_SHEET_NAME, end: true });
    const list2 = await listSheets();
    const hit2 = list2.find((s) => String(s.sheetName || '').trim() === STATE_SHEET_NAME);
    if (!hit2) throw new Error('无法在云文档里创建「应用状态」工作表（可能没有编辑权限）');
    sid = Number(hit2.sheetId) || 0;
    saveIdCache();
    return { sheetId: hit2.sheetId, lastRow: Number(hit2.rowTo) || 0 };
  }

  async function readSheet(create) {
    const sh = await ensureSheet(create !== false);
    if (!sh) return { entries: [], rowOf: new Map(), sheetId: 0, lastRow: 0 };
    const rowTo = Math.min(Math.max((Number(sh.lastRow) || 0) + 20, 60), 4000);
    const res = await kd.call('sheet.get_range_data', {
      file_id: sheet.fileId, worksheet_id: sh.sheetId,
      range: { rowFrom: 0, rowTo, colFrom: 0, colTo: 2 },
    });
    const list = (((res.data || {}).detail || {}).rangeData) || [];
    const grid = new Map();
    for (const c of list) {
      const txt = c.cellText == null ? '' : String(c.cellText).trim();
      if (!txt) continue;
      grid.set(`${c.rowFrom}|${c.colFrom}`, txt);
    }
    const entries = [];
    const rowOf = new Map();
    for (let r = 1; r <= rowTo; r++) {
      const key = grid.get(`${r}|0`);
      if (!key) continue;
      const e = entryFromRow(key, grid.get(`${r}|1`) || 'null');
      if (!e) continue;
      rowOf.set(key, r);
      entries.push(e);
    }
    return { entries, rowOf, sheetId: sh.sheetId, lastRow: Number(sh.lastRow) || 0, headRow: grid.has('0|0') };
  }

  async function read(opts) {
    const force = !!(opts && opts.force);
    if (!force && cache && Date.now() - cache.at < ttl) {
      return { entries: cache.entries, sheetId: cache.sheetId, cached: true };
    }
    const cur = await readSheet(true);
    cache = { at: Date.now(), entries: cur.entries, rowOf: cur.rowOf, sheetId: cur.sheetId, lastRow: cur.lastRow };
    return { entries: cur.entries, sheetId: cur.sheetId, cached: false };
  }

  /** 把一批条目写进状态表；返回合并后的全量条目 */
  async function write(rawEntries, opts) {
    const incoming = (rawEntries || []).map(normalizeEntry).filter(Boolean);
    const cur = await readSheet(true);        // 写之前一定重读：不能拿旧缓存判断谁更新
    const { entries, changed } = mergeEntries(cur.entries, incoming);
    cache = { at: Date.now(), entries, rowOf: cur.rowOf, sheetId: cur.sheetId, lastRow: cur.lastRow };
    if (!changed.length) return { entries, written: 0, sheetId: cur.sheetId };

    const writes = [];
    if (!cur.headRow) {
      for (let c = 0; c < HEAD.length; c++) {
        writes.push({ row_from: 0, row_to: 0, col_from: c, col_to: c, op_type: 'cell_operation_type_formula', formula: HEAD[c] });
      }
      writes.push({ row_from: 0, row_to: 0, col_from: 3, col_to: 3, op_type: 'cell_operation_type_formula', formula: NOTE });
    }
    let nextRow = 1;
    for (const r of cur.rowOf.values()) if (r >= nextRow) nextRow = r + 1;
    const plan = changed.map((e) => ({ e, row: cur.rowOf.has(e.key) ? cur.rowOf.get(e.key) : nextRow++ }));
    // 超出已用行时先一次性把行插出来（插入会整体下移，必须写在 batch 之前，不能边插边写）
    const maxRow = plan.reduce((m, p) => Math.max(m, p.row), 0);
    if (maxRow > cur.lastRow) {
      const from = cur.lastRow + 1;
      try {
        await kd.call('sheet.insert_rows_cols', {
          file_id: sheet.fileId, worksheet_id: cur.sheetId,
          type: 'row', row_from: from, row_to: maxRow,
        });
      } catch { /* 表格自带空行够用时忽略 */ }
    }
    for (const p of plan) {
      const r = p.row;
      writes.push({ row_from: r, row_to: r, col_from: 0, col_to: 0, op_type: 'cell_operation_type_formula', formula: p.e.key });
      writes.push({ row_from: r, row_to: r, col_from: 1, col_to: 1, op_type: 'cell_operation_type_formula', formula: JSON.stringify(p.e.v) });
      writes.push({ row_from: r, row_to: r, col_from: 2, col_to: 2, op_type: 'cell_operation_type_formula', formula: String(p.e.v.at) });
    }
    await kd.call('sheet.range_data_batch_update', {
      file_id: sheet.fileId, worksheet_id: cur.sheetId, range_data: writes,
    });
    return { entries, written: changed.length, sheetId: cur.sheetId };
  }

  return { read, write, ensureSheet, clearCache() { cache = null; } };
}
