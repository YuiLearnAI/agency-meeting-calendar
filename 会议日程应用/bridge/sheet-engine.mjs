/**
 * 云文档表格写入引擎（与 HTTP 无关，便于单独测试）
 *
 * 职责：
 *   readSheet()   —— 读整表，归一化成「日期 → 行 / 领导 → 列 / 单元格文本」
 *   push(events)  —— 按「日期找行、领导找列」追加写入，自动补日期行，写入前先比对去重
 *   snapshot()    —— 生成离线比对用的快照
 */
import fs from 'node:fs';

const WD_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function pad2(n) { return String(n).padStart(2, '0'); }

export function isoFromCell(raw) {
  const s = String(raw == null ? '' : raw).trim();
  let m = s.replace(/[年月/.]/g, '-').replace(/日|号/g, ' ').match(/(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{5})$/);
  if (m) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(m[1]) * 86400000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})/);
  if (m) return `${new Date().getFullYear()}-${pad2(m[1])}-${pad2(m[2])}`;
  return null;
}

export function weekdayOf(iso) {
  const a = iso.split('-').map(Number);
  return WD_CN[new Date(a[0], a[1] - 1, a[2]).getDay()];
}

export function dateCellText(iso) {
  const a = iso.split('-').map(Number);
  return `${a[0]}年${a[1]}月${a[2]}日`;
}

export function minutesOf(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function normCell(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000]/g, '')
    .replace(/[，,、;；:：。.！!？?（）()【】\[\]《》<>"'“”‘’\-—_/\\|~～]/g, '')
    .toLowerCase();
}

const SEG_TIME_HINT = /(?:上午|下午|中午|晚上|早上|傍晚|早晨|凌晨)?\s*\d{1,2}\s*(?:[:：]\s*\d{1,2}|[时点])/;

/** 一格/一行里可能挤了多场会（「1. 14:30…；2. 15:45…」），按分号或「编号+时间」切开，
 *  只保留自带时间的片段，不带时间的并回上一段（避免「会议；请准时参加」被误拆） */
function splitMultiMeetings(line) {
  let s = String(line || '').trim();
  if (!s) return [];
  s = s.replace(/^\s*(?:\d{1,2}\s*[.、．)）]|[（(]\d{1,2}[)）]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/, '');
  s = s.replace(/[\s。；;、]*(?:\d{1,2}\s*[.、．)）]|[①②③④⑤⑥⑦⑧⑨⑩])\s*(?=(?:上午|下午|中午|晚上|早上|傍晚|早晨|凌晨)?\s*\d{1,2}\s*[:：时点])/g, '；');
  const parts = s.split(/[；;]+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return [s];
  const out = [];
  let cur = parts[0];
  for (let i = 1; i < parts.length; i++) {
    if (SEG_TIME_HINT.test(parts[i])) { out.push(cur); cur = parts[i]; }
    else cur += '；' + parts[i];
  }
  out.push(cur);
  return out.filter((x) => String(x).trim());
}

export function cellSegments(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if (!t) continue;
    out.push(...splitMultiMeetings(t));
  }
  return out;
}

const PM_MARK = /下午|晚上|傍晚|夜间|pm/i;

export function timePresentIn(raw, start) {
  const mm = minutesOf(start);
  if (mm === null) return true;
  const h = Math.floor(mm / 60), mi = mm % 60, s = String(raw || '');
  // 24 小时制要能对上 12 小时制写法：15:00 ↔ 下午3:00 / 下午3点 / 下午3时
  const variants = [h];
  if (h > 12) variants.push(h - 12);
  for (const hh of variants) {
    if (hh !== h && !PM_MARK.test(s)) continue; // 缩成 12 小时制时必须有「下午/晚上」等标记，避免误配
    if (new RegExp(`(^|[^0-9])${hh}\\s*[:：]\\s*0?${mi}($|[^0-9])`).test(s)) return true;
    if (mi === 0 && new RegExp(`(^|[^0-9])${hh}\\s*[点时時]`).test(s)) return true;
    if (mi !== 0 && new RegExp(`(^|[^0-9])${hh}\\s*[点时時]\\s*0?${mi}`).test(s)) return true;
  }
  return false;
}

function bigrams(s) {
  const t = normCell(s), out = {};
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); out[g] = (out[g] || 0) + 1; }
  if (t.length === 1) out[t] = 1;
  return out;
}

export function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  const ka = Object.keys(A), kb = Object.keys(B);
  if (!ka.length || !kb.length) return 0;
  let inter = 0;
  ka.forEach((k) => { if (B[k]) inter += Math.min(A[k], B[k]); });
  const total = ka.reduce((s, k) => s + A[k], 0) + kb.reduce((s, k) => s + B[k], 0);
  return (2 * inter) / total;
}

/** 单元格里是否已经登记过这场会：名称命中 + 时间命中（单元格没写时间时只比名称） */
export function cellHasEvent(cellText, item) {
  const title = String((item && item.title) || '').trim();
  const nt = normCell(title);
  if (!nt) return false;
  const whole = String(cellText || '');
  const segs = cellSegments(whole);
  // 一格只登记一场时，允许拿整格文本兜底比对时间（旧写法可能把时间写得很散）
  // 一格挤了多场时必须严格按场次比，否则「第一场的时间 + 第二场的名字」会被误判成同一场
  const single = segs.length <= 1;
  const timeRe = /\d{1,2}\s*[:：]\s*\d{1,2}|\d{1,2}\s*[点时]/;
  for (const seg of segs) {
    const ns = normCell(seg);
    if (!ns) continue;
    const nameHit = ns.includes(nt) || nt.includes(ns) || dice(seg, title) >= 0.68;
    if (!nameHit) continue;
    if (!item.start) return true;
    if (!timeRe.test(seg)) return true;
    if (timePresentIn(seg, item.start) || (single && timePresentIn(whole, item.start))) return true;
  }
  return false;
}

/** 在一个单元格的多段内容里，挑出「该删掉的那一段」的下标；挑不到回 -1 */
export function pickSegIndex(segs, item) {
  const cands = [];
  for (let i = 0; i < segs.length; i++) {
    if (!segs[i]) continue;
    if (cellHasEvent(segs[i], { title: item.title, start: item.start })) cands.push(i);
  }
  if (!cands.length) return -1;
  if (cands.length === 1) return cands[0];
  // 同一格里名称时间都相似时有多个候选：优先地点也对得上的那一段
  if (item.place) {
    const p = normCell(item.place);
    const exact = cands.filter((i) => normCell(segs[i]).includes(p));
    if (exact.length) return exact[0];
  }
  return cands[0];
}

/**
 * 在一格里挑出「这场会的旧版本」该是哪一段：
 *   ① 用「改之前的开始时间」（oldStart）精确命中 —— 改时间后旧段只能这样认出来
 *   ② 用本次的开始时间命中
 *   ③ 整格只有一段同名 → 就是它（例如当初只写了会名，没写时间）
 * 都不满足返回 -1：宁可另起一条，也不要把同格另一场同类会议顶掉。
 */
export function pickOldSeg(segs, item) {
  const byTime = pickSegIndex(segs, {
    title: item.title,
    start: item.oldStart || item.start,
    place: item.oldPlace || item.place,
  });
  if (byTime >= 0) return byTime;
  const hits = [];
  for (let i = 0; i < segs.length; i++) {
    if (cellHasEvent(segs[i], { title: item.title })) hits.push(i);
  }
  return hits.length === 1 ? hits[0] : -1;
}

// 内容指纹：页面轮询时用它判断「云文档到底有没有变」，没变就完全不打扰页面
function hashOf(cols, cells) {
  let s = (cols || []).join('\u0001');
  const keys = Object.keys(cells || {}).sort();
  for (const k of keys) s += '\u0002' + k + '\u0003' + cells[k];
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + s.length.toString(36);
}

export function createEngine({ kd, sheet, snapshotPath, colRange = 9 }) {
  let lastHash = '';   // 上一次已知（已落盘/已告知页面）的云文档内容指纹

  async function readSheet() {
    const info = await kd.call('sheet.get_sheets_info', { file_id: sheet.fileId });
    const sheets = (((info.data || {}).detail || {}).sheetsInfo) || [];
    const sh = sheets[0];
    if (!sh) throw new Error('云文档里没有可用的工作表');
    const sheetId = sh.sheetId;
    const lastRow = Number(sh.rowTo) || 0;
    const rowTo = Math.min(Math.max(lastRow + 30, 40), 4000);
    const res = await kd.call('sheet.get_range_data', {
      file_id: sheet.fileId, worksheet_id: sheetId,
      range: { rowFrom: 0, rowTo, colFrom: 0, colTo: colRange },
    });
    const list = (((res.data || {}).detail || {}).rangeData) || [];

    const grid = new Map();
    let maxRow = 0;
    for (const c of list) {
      const txt = c.cellText == null ? '' : String(c.cellText).trim();
      if (!txt) continue;
      grid.set(`${c.rowFrom}|${c.colFrom}`, txt);
      if (c.rowFrom > maxRow) maxRow = c.rowFrom;
    }

    const cols = [];
    const colOf = {};
    for (let col = 2; col <= colRange; col++) {
      const t = grid.get(`0|${col}`) || '';
      const name = t.split(/[，,（(、\s]/)[0].trim();
      if (!name) continue;
      cols.push(name);
      colOf[name] = col;
    }

    const rowsByDate = {};
    const dateByRow = {};
    for (let r = 1; r <= maxRow; r++) {
      const raw = grid.get(`${r}|0`);
      if (!raw) continue;
      const iso = isoFromCell(raw);
      if (!iso) continue;
      rowsByDate[iso] = r;
      dateByRow[r] = iso;
    }

    const cells = {};
    for (const [key, txt] of grid) {
      const [rs, cs] = key.split('|').map(Number);
      if (rs === 0 || cs < 2) continue;
      const iso = dateByRow[rs];
      const name = cols[cs - 2];
      if (!iso || !name) continue;
      cells[`${iso}|${name}`] = txt;
    }

    return { sheetId, cols, colOf, rowsByDate, dateByRow, cells, maxRow, lastRow };
  }

  function snapshotOf(sh) {
    const dates = new Set();
    let n = 0;
    for (const k of Object.keys(sh.cells)) {
      if (!String(sh.cells[k] || '').trim()) continue;
      n++; dates.add(k.split('|')[0]);
    }
    return {
      at: new Date().toISOString(), cols: sh.cols, cells: sh.cells, source: 'file',
      days: dates.size, entries: n, hash: hashOf(sh.cols, sh.cells),
    };
  }

  function writeSnapshotFile(snap) {
    if (snap && snap.hash) lastHash = snap.hash;
    if (!snapshotPath) return false;
    const head = '// 由本地同步服务从金山文档《会议安排》回读生成，用于离线去重与历史导入\n'
      + `// 生成时间 ${snap.at}；共 ${snap.days} 个日期、${snap.entries} 处登记\n`;
    const body = `window.__DOC_SNAPSHOT__ = ${JSON.stringify(
      { at: snap.at, cols: snap.cols, cells: snap.cells, source: 'file' }, null, 1)};\n`;
    try {
      fs.writeFileSync(snapshotPath, head + body, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  async function push(rawItems, opts) {
    const ignoreExisting = !!(opts && opts.ignoreExisting);
    const items = (rawItems || []).map((it) => ({
      date: String(it.date || '').trim(),
      leader: String(it.leader || '').trim(),
      text: String(it.text || '').trim(),
      title: String(it.title || '').trim(),
      start: String(it.start || '').trim(),
      place: String(it.place || '').trim(),
      oldStart: String(it.oldStart || '').trim(),
      oldPlace: String(it.oldPlace || '').trim(),
      updated: !!it.updated,
    })).filter((it) => it.date && it.leader && it.text);

    const before = await readSheet();
    const result = { written: [], duplicates: [], skipped: [], rowsCreated: [], replaced: [] };

    const todo = [];
    for (const it of items) {
      const col = before.colOf[it.leader];
      if (col == null) {
        result.skipped.push({ ...it, reason: `云文档表格中没有「${it.leader}」这一列` });
        continue;
      }
      const exist = before.cells[`${it.date}|${it.leader}`] || '';
      if (!ignoreExisting && exist && cellHasEvent(exist, it)) {
        // 同一场会已经在格子里：内容一模一样才算重复；
        // 时间/地点改过的（或是页面标了 updated 的）→ 把原来那一段替换掉，
        // 绝不能追加成两条（否则「改了时间地点云文档不动」或「新旧并存」）。
        const segs = cellSegments(exist);
        const idx = pickOldSeg(segs, it);
        const same = idx >= 0 && normCell(segs[idx]) === normCell(it.text);
        if (same) {
          result.duplicates.push({ ...it, existing: exist });
          continue;
        }
        if (idx >= 0) {
          todo.push({ ...it, col, existing: exist, replaceIdx: idx });
          continue;
        }
      } else if (!ignoreExisting && exist) {
        // 按「名称 + 新时间」认不出这场会（改过时间），但格子里可能躺着它的旧版本
        const segs = cellSegments(exist);
        const idx = pickOldSeg(segs, it);
        if (idx >= 0) {
          todo.push({ ...it, col, existing: exist, replaceIdx: idx });
          continue;
        }
      }
      todo.push({ ...it, col, existing: exist, replaceIdx: -1 });
    }
    if (!todo.length) {
      return { ...result, snapshot: snapshotOf(before), sheetId: before.sheetId };
    }

    const needDates = [...new Set(todo.map((x) => x.date))].sort();
    const rowOf = { ...before.rowsByDate };
    let maxRow = before.maxRow;
    for (const d of needDates) {
      if (rowOf[d] != null) continue;
      let insertAt = maxRow + 1;
      for (const iso of Object.keys(rowOf)) {
        if (iso > d && rowOf[iso] < insertAt) insertAt = rowOf[iso];
      }
      await kd.call('sheet.insert_rows_cols', {
        file_id: sheet.fileId, worksheet_id: before.sheetId,
        type: 'row', row_from: insertAt, row_to: insertAt,
      });
      for (const iso of Object.keys(rowOf)) {
        if (rowOf[iso] >= insertAt) rowOf[iso] += 1;
      }
      rowOf[d] = insertAt;
      maxRow = Math.max(maxRow, insertAt);
      result.rowsCreated.push(d);
    }

    const writes = [];
    for (const d of needDates) {
      const r = rowOf[d];
      writes.push({ row_from: r, row_to: r, col_from: 0, col_to: 0, op_type: 'cell_operation_type_formula', formula: dateCellText(d) });
      writes.push({ row_from: r, row_to: r, col_from: 1, col_to: 1, op_type: 'cell_operation_type_formula', formula: weekdayOf(d) });
    }
    for (const it of todo) {
      const r = rowOf[it.date];
      let cell;
      if (it.replaceIdx != null && it.replaceIdx >= 0) {
        // 就地替换那一场会：同格其它会议原样保留，换行/分号风格也不改
        const segs = cellSegments(it.existing);
        segs[it.replaceIdx] = it.text;
        cell = segs.join(/\r?\n/.test(it.existing) ? '\n' : '；');
        result.replaced.push({ date: it.date, leader: it.leader, text: it.text, old: cellSegments(it.existing)[it.replaceIdx] || '' });
      } else {
        const old = it.existing && it.existing.trim() ? it.existing.replace(/\s+$/, '') : '';
        cell = old ? `${old}\n${it.text}` : it.text;
      }
      writes.push({ row_from: r, row_to: r, col_from: it.col, col_to: it.col, op_type: 'cell_operation_type_formula', formula: cell });
      result.written.push({ date: it.date, leader: it.leader, text: it.text, appended: !(it.replaceIdx >= 0) && !!it.existing, row: r });
    }
    await kd.call('sheet.range_data_batch_update', {
      file_id: sheet.fileId, worksheet_id: before.sheetId, range_data: writes,
    });

    const after = await readSheet();
    const snap = snapshotOf(after);
    writeSnapshotFile(snap);
    return { ...result, snapshot: snap, sheetId: after.sheetId };
  }

  async function pull() {
    const sh = await readSheet();
    const snap = snapshotOf(sh);
    // 内容没变就不重写快照文件（轮询几十秒一次，别一直写盘）
    const changed = snap.hash !== lastHash;
    if (changed) writeSnapshotFile(snap);
    return { snapshot: snap, changed, sheetId: sh.sheetId, saved: !!snapshotPath };
  }

  /**
   * 从云文档里撤掉指定登记（网页上删掉/改过的会议）。
   * 只删命中「名称 + 时间」的那一段，同格里的其它会议原样保留；整格空了就写空清掉。
   */
  async function remove(rawItems) {
    const items = (rawItems || [])
      .filter((it) => it && typeof it === 'object')
      .map((it) => ({
        date: String(it.date || '').trim(),
        leader: String(it.leader || '').trim(),
        title: String(it.title || '').trim(),
        start: String(it.start || '').trim(),
        place: String(it.place || '').trim(),
      })).filter((it) => it.date && it.leader && it.title);

    const before = await readSheet();
    const result = { removed: [], notFound: [], emptied: [] };
    if (!items.length) {
      return { ...result, snapshot: snapshotOf(before), sheetId: before.sheetId };
    }

    const work = new Map();
    const order = [];
    for (const it of items) {
      const col = before.colOf[it.leader];
      if (col == null) {
        result.notFound.push({ ...it, reason: `云文档表格中没有「${it.leader}」这一列` });
        continue;
      }
      const row = before.rowsByDate[it.date];
      if (row == null) {
        result.notFound.push({ ...it, reason: '云文档表格里没有这个日期行' });
        continue;
      }
      const key = `${row}|${col}`;
      let w = work.get(key);
      if (!w) {
        const rawCell = before.cells[`${it.date}|${it.leader}`] || '';
        w = { row, col, date: it.date, leader: it.leader, segs: cellSegments(rawCell), orig: cellSegments(rawCell), touched: 0, multiLine: /\r?\n/.test(rawCell) };
        work.set(key, w);
        order.push(key);
      }
      const idx = pickSegIndex(w.segs, it);
      if (idx < 0) {
        result.notFound.push({ ...it, reason: '云文档里找不到这条登记的原文' });
        continue;
      }
      w.segs[idx] = null; // 置空但保留位置，避免同格多条时下标错乱
      w.touched++;
      result.removed.push({ date: it.date, leader: it.leader, text: w.orig[idx] || it.title });
    }

    const writes = [];
    for (const key of order) {
      const w = work.get(key);
      if (!w.touched) continue; // 这一格一条都没匹配上，别去动它
      const kept = w.segs.filter((s) => s !== null && String(s).trim());
      // 原来是多行的还按多行写回，原来是一行用分号排的就别给人改成多行
      const text = kept.join(w.multiLine ? '\n' : '；');
      if (!text) result.emptied.push({ date: w.date, leader: w.leader });
      writes.push({
        row_from: w.row, row_to: w.row, col_from: w.col, col_to: w.col,
        op_type: 'cell_operation_type_formula', formula: text,
      });
    }
    if (!writes.length) {
      return { ...result, snapshot: snapshotOf(before), sheetId: before.sheetId };
    }

    await kd.call('sheet.range_data_batch_update', {
      file_id: sheet.fileId, worksheet_id: before.sheetId, range_data: writes,
    });

    const after = await readSheet();
    const snap = snapshotOf(after);
    writeSnapshotFile(snap);
    return { ...result, snapshot: snap, sheetId: after.sheetId };
  }

  return { readSheet, snapshotOf, writeSnapshotFile, push, remove, pull };
}
