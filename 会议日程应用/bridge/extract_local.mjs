/**
 * 纯 Node 本地文本提取（零第三方依赖）
 *
 * 为什么不用 python-docx / pypdf：
 *   WorkBuddy 升级自带 Python 时会把 site-packages 整个换掉，python-docx、pypdf、
 *   rapidocr 全没了，服务只会在用户拖文件时抛「No module named 'docx'」。
 *   docx / pdf 这两种格式用 Node 内置的 zlib 就能解开，没有任何理由去依赖外部包。
 *
 * 图片（OCR）仍然交给 Python，那是模型推算，Node 侧做不了；
 * 缺依赖时会给一句人话提示，而不是把 Python 的报错原样丢给用户。
 *
 * 红线：全程本地，不联网。
 */
import zlib from 'node:zlib';

/* ---------------- 通用 ---------------- */

function toU8(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  return new Uint8Array(buf);
}

function latin1(u8) {
  // 按字节逐个还原成「一字节一字符」的字符串，供正则扫描二进制内容
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
  }
  return s;
}

function inflate(u8, kind) {
  const opt = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  try {
    return kind === 'raw' ? zlib.inflateRawSync(u8, opt) : zlib.inflateSync(u8, opt);
  } catch (e) {
    // 有的写入器 zlib 头不规范，换另一种再试一次
    return kind === 'raw' ? zlib.inflateSync(u8, opt) : zlib.inflateRawSync(u8, opt);
  }
}

function looksLikeLegacyOffice(u8) {
  return u8.length > 8 && u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0;
}

function looksLikeZip(u8) {
  // docx / xlsx / pptx 本质是 zip，以本地文件头 PK\x03\x04 或空归档 PK\x05\x06 开头
  return u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b &&
    (u8[2] === 0x03 || u8[2] === 0x05) && u8[3] === 0x04;
}

/* ---------------- ZIP（.docx 的容器） ---------------- */

function zipOpen(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  const from = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= from; i--) {
    if (i >= 0 && dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) {
    if (looksLikeLegacyOffice(u8)) {
      throw new Error('这是 Word 97-2003 的 .doc 老格式，请用 Word 打开后「另存为 .docx」再拖进来');
    }
    throw new Error('不是有效的 .docx（文件可能损坏，或不是 Word 2007+ 格式）');
  }
  const total = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const list = [];
  for (let k = 0; k < total; k++) {
    if (off + 46 > u8.length) break;
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = Buffer.from(u8.subarray(off + 46, off + 46 + nlen)).toString('utf8');
    list.push({ name, method, csize, lho });
    off += 46 + nlen + elen + clen;
  }
  return { u8, dv, list };
}

function zipRead(zip, name) {
  const e = zip.list.find((x) => x.name === name);
  if (!e) return null;
  const off = e.lho;
  if (zip.dv.getUint32(off, true) !== 0x04034b50) return null;
  const nlen = zip.dv.getUint16(off + 26, true);
  const elen = zip.dv.getUint16(off + 28, true);
  const start = off + 30 + nlen + elen;
  let size = e.csize;
  if (!size) {
    // 长度写在数据描述符里的写入器：退化成「到下一个条目开头」
    const idx = zip.list.indexOf(e);
    const next = zip.list[idx + 1];
    size = next ? next.lho - start : zip.u8.length - start;
  }
  const data = zip.u8.subarray(start, Math.min(start + size, zip.u8.length));
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return Buffer.from(inflate(data, 'raw'));
  throw new Error('这个 .docx 用了不常见的压缩方式（method ' + e.method + '），无法解压');
}

/* ---------------- WordprocessingML → 纯文本 ---------------- */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlDecode(s) {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[a-z]+);/gi, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENT, g) ? ENT[g] : m;
  });
}

// 一段里的可见文字：按出现顺序处理 <w:t> 与制表/换行
function paraText(xml) {
  const src = xml
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, '')      // 修订里被删掉的字不要
    .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '');
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) out += xmlDecode(m[1]);
    else if (/^<w:tab/.test(m[0])) out += '\t';
    else out += '\n';
  }
  return out;
}

function cellsOfRow(trXml) {
  const cells = [];
  const tcRe = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
  let c;
  while ((c = tcRe.exec(trXml))) {
    const ps = [];
    const pRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
    let p;
    while ((p = pRe.exec(c[1]))) ps.push(paraText(p[1]));
    cells.push(ps.join(' ').replace(/[ \t\u3000]+/g, ' ').trim());
  }
  return cells;
}

function tableText(tblXml) {
  const rows = [];
  const trRe = /<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g;
  let m;
  while ((m = trRe.exec(tblXml))) {
    const cells = cellsOfRow(m[1]);
    if (cells.length) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

// 找同名标签的配对位置（含嵌套）
function findClose(s, start, tag) {
  const openRe = new RegExp('<w:' + tag + '(?=[\\s>/])', 'g');
  const closeTag = '</w:' + tag + '>';
  let depth = 0;
  let i = start;
  while (i < s.length) {
    openRe.lastIndex = i;
    const o = openRe.exec(s);
    const c = s.indexOf(closeTag, i);
    if (c < 0) return -1;
    if (o && o.index < c) {
      const gt = s.indexOf('>', o.index);
      const selfClose = gt > 0 && s[gt - 1] === '/';
      if (!selfClose) depth++;
      i = gt > 0 ? gt + 1 : o.index + 1;
    } else {
      depth--;
      if (depth <= 0) return c + closeTag.length;
      i = c + closeTag.length;
    }
  }
  return -1;
}

function wmlToText(xml) {
  const out = [];
  let i = 0;
  const RE = /<w:(p|tbl)(?=[\s>/])/g;
  for (;;) {
    RE.lastIndex = i;
    const m = RE.exec(xml);
    if (!m) break;
    const tag = m[1];
    const start = m.index;
    const gt = xml.indexOf('>', start);
    if (gt < 0) break;
    if (xml[gt - 1] === '/') { i = gt + 1; continue; }   // <w:p/> 空段
    const end = findClose(xml, start, tag);
    if (end < 0) break;
    const inner = xml.slice(start, end);
    if (tag === 'tbl') out.push(tableText(inner));
    else out.push(paraText(inner));
    i = end;
  }
  return out;
}

export function docxText(buf) {
  const u8 = toU8(buf);
  const zip = zipOpen(u8);
  let xmlBuf = zipRead(zip, 'word/document.xml');
  if (!xmlBuf) {
    const alt = zip.list.find((x) => /^word\/document\d*\.xml$/.test(x.name));
    if (alt) xmlBuf = zipRead(zip, alt.name);
  }
  if (!xmlBuf) throw new Error('这个 .docx 里没有正文（word/document.xml 找不到）');
  const lines = wmlToText(xmlBuf.toString('utf8'))
    .map((s) => s.replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, ''))
    .filter((s) => s.trim() !== '');
  const text = lines.join('\n');
  if (!text.trim()) throw new Error('这个 .docx 里没有可用文字（可能整篇都是图片，需要 OCR）');
  return text;
}

/* ---------------- PDF → 纯文本 ---------------- */

function hexToStr(hex) {
  hex = String(hex || '').replace(/[^0-9A-Fa-f]/g, '');
  if (!hex) return '';
  if (hex.length <= 2) return String.fromCharCode(parseInt(hex, 16));
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    const code = parseInt(hex.substr(i, 4), 16);
    if (!Number.isNaN(code)) out += String.fromCharCode(code);
  }
  return out;
}

function mergeCMap(map, txt) {
  let m;
  const reChar = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = reChar.exec(txt))) {
    const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = pair.exec(m[1]))) {
      const code = parseInt(p[1], 16);
      if (!Number.isNaN(code)) map[code] = hexToStr(p[2]);
    }
  }
  const reRange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = reRange.exec(txt))) {
    const line = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let q;
    while ((q = line.exec(m[1]))) {
      const lo = parseInt(q[1], 16);
      const hi = parseInt(q[2], 16);
      if (Number.isNaN(lo) || Number.isNaN(hi) || hi < lo) continue;
      if (q[3]) {
        const base = hexToStr(q[3]);
        const cp = base.charCodeAt(0);
        for (let c = lo; c <= hi && c - lo < 4000; c++) map[c] = String.fromCharCode(cp + (c - lo));
      } else if (q[4]) {
        const items = q[4].match(/<([0-9A-Fa-f]+)>/g) || [];
        for (let i = 0; i < items.length; i++) map[lo + i] = hexToStr(items[i].replace(/[<>]/g, ''));
      }
    }
  }
}

function hasWideCode(map) {
  for (const k in map) if (+k > 255) return true;
  return false;
}

function pdfLitBytes(lit) {
  const out = [];
  for (let i = 0; i < lit.length; i++) {
    const c = lit.charAt(i);
    if (c === '\\') {
      const n = lit.charAt(++i);
      if (n === 'n') out.push(10);
      else if (n === 'r') out.push(13);
      else if (n === 't') out.push(9);
      else if (n === 'b') out.push(8);
      else if (n === 'f') out.push(12);
      else if (n === '\n' || n === '\r') { /* 续行，忽略 */ }
      else if (n >= '0' && n <= '7') {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(lit.charAt(i + 1))) oct += lit.charAt(++i);
        out.push(parseInt(oct, 8) & 255);
      } else out.push(n.charCodeAt(0) & 255);
    } else out.push(c.charCodeAt(0) & 255);
  }
  return out;
}

function pdfDecode(bytes, map) {
  const wide = hasWideCode(map);
  let out = '';
  if (wide) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      if (map[code] != null) out += map[code];
    }
  } else {
    for (let j = 0; j < bytes.length; j++) {
      const c = bytes[j];
      if (map[c] != null) out += map[c];
      else if (c >= 32 && c < 127) out += String.fromCharCode(c);
    }
  }
  return out;
}

function pdfDecodeHex(hex, map) {
  hex = hex.replace(/[^0-9A-Fa-f]/g, '');
  const bytes = [];
  for (let i = 0; i + 2 <= hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  return pdfDecode(bytes, map);
}

// 内容流 → 按 Y 坐标聚行（PDF 里换行靠定位，不靠换行符）
function pdfContentText(s, resolveMap) {
  const lines = [];
  let cur = '';
  let y = 0;
  let leading = 0;
  let lastY = null;
  let fontName = null;

  function pushText(txt) {
    if (!txt) return;
    if (lastY === null) lastY = y;
    if (Math.abs(y - lastY) > 2) {
      if (cur) lines.push(cur);
      cur = '';
      lastY = y;
    }
    cur += txt;
  }
  function decodeItem(it) {
    if (!it) return '';
    const mp = resolveMap(fontName) || {};
    if (it.t === 'lit') return pdfDecode(pdfLitBytes(it.v), mp);
    if (it.t === 'hex') return pdfDecodeHex(it.v, mp);
    return '';
  }

  const stack = [];
  const n = s.length;
  let i = 0;

  function handleOp(op) {
    const nums = [];
    const items = [];
    let name = null;
    for (const it of stack) {
      if (it.t === 'num') nums.push(it.v);
      else if (it.t === 'lit' || it.t === 'hex') items.push(it);
      else if (it.t === 'name') name = it.v;
    }
    if (op === 'BT') { y = 0; leading = 0; }
    else if (op === 'Tm') { if (nums.length >= 6) y = nums[5]; }
    else if (op === 'Td') { if (nums.length >= 2) y += nums[1]; }
    else if (op === 'TD') { if (nums.length >= 2) { y += nums[1]; leading = -nums[1]; } }
    else if (op === 'T*') { y -= leading; }
    else if (op === 'TL') { if (nums.length) leading = nums[0]; }
    else if (op === 'Tf') { if (name) fontName = name; }
    else if (op === 'Tj' || op === "'" || op === '"' || op === 'TJ') {
      if (op === "'" || op === '"') y -= leading;
      for (const it of items) pushText(decodeItem(it));
    }
  }

  while (i < n) {
    const ch = s.charAt(i);
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0') { i++; continue; }
    if (ch === '%') { while (i < n && s.charAt(i) !== '\n') i++; continue; }
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      const buf = [];
      while (j < n && depth > 0) {
        const c = s.charAt(j);
        if (c === '\\') { buf.push(c); buf.push(s.charAt(j + 1)); j += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) break; }
        buf.push(c);
        j++;
      }
      stack.push({ t: 'lit', v: buf.join('') });
      i = j + 1;
      continue;
    }
    if (ch === '<') {
      if (s.charAt(i + 1) === '<') { i += 2; continue; }
      const e = s.indexOf('>', i);
      if (e < 0) break;
      stack.push({ t: 'hex', v: s.slice(i + 1, e) });
      i = e + 1;
      continue;
    }
    if (ch === '>') { i += s.charAt(i + 1) === '>' ? 2 : 1; continue; }
    if (ch === '[' || ch === ']') { i++; continue; }
    if (ch === '/') {
      let j = i + 1;
      while (j < n && !/[\s/[\]<>()]/.test(s.charAt(j))) j++;
      stack.push({ t: 'name', v: s.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) {
      let j = i;
      while (j < n && /[0-9+\-.]/.test(s.charAt(j))) j++;
      const num = parseFloat(s.slice(i, j));
      stack.push({ t: 'num', v: Number.isNaN(num) ? 0 : num });
      i = j;
      continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '*' || ch === "'" || ch === '"') {
      let j = i;
      while (j < n && /[A-Za-z0-9*'"]/.test(s.charAt(j))) j++;
      handleOp(s.slice(i, j));
      stack.length = 0;
      i = j;
      continue;
    }
    i++;
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

export function pdfText(buf) {
  const s = latin1(toU8(buf));
  const jobs = [];
  const reObj = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = reObj.exec(s))) {
    const start = m.index;
    const eObj = s.indexOf('endobj', start);
    if (eObj < 0) break;
    let dictAll = s.slice(start, eObj);
    let bytes = null;
    const sIdx = dictAll.indexOf('stream');
    if (sIdx >= 0 && dictAll.indexOf('endstream') !== sIdx) {
      let ds = start + sIdx + 6;
      if (s.charAt(ds) === '\r') ds++;
      if (s.charAt(ds) === '\n') ds++;
      const de = s.indexOf('endstream', ds) >= 0 ? s.indexOf('endstream', ds) : eObj;
      const raw = s.slice(ds, de);
      bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 255;
      dictAll = dictAll.slice(0, sIdx);
    }
    jobs.push({ num: +m[1], dict: dictAll, bytes });
    reObj.lastIndex = eObj + 6;
  }
  if (!jobs.length) throw new Error('不是有效的 PDF，或文件内容无法读取');

  // 字体表：资源名 → 字体对象号；字体对象 → ToUnicode 对象号
  const resToFont = {};
  const fontToCmap = {};
  for (const j of jobs) {
    if (!j.dict) continue;
    const re = /\/Font\s*<<([\s\S]*?)>>/g;
    let fm;
    while ((fm = re.exec(j.dict))) {
      const reRef = /\/([^\s/[\]<>()]+)\s+(\d+)\s+0\s+R/g;
      let rr;
      while ((rr = reRef.exec(fm[1]))) resToFont[rr[1]] = +rr[2];
    }
    if (/\/Type\s*\/Font/.test(j.dict)) {
      const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(j.dict);
      if (tu) fontToCmap[j.num] = +tu[1];
    }
  }

  const cmapByObj = {};
  const streams = [];
  const seen = {};
  jobs.forEach((j) => {
    if (!j.bytes || !j.bytes.length) return;
    let b = j.bytes;
    if (/FlateDecode/.test(j.dict)) {
      try { b = inflate(b, 'deflate'); } catch { try { b = inflate(b, 'raw'); } catch { return; } }
    }
    const t = latin1(b);
    if (t.indexOf('beginbfchar') >= 0 || t.indexOf('beginbfrange') >= 0) {
      const mp = {};
      mergeCMap(mp, t);
      cmapByObj[j.num] = mp;
      return;
    }
    if (t.indexOf('BT') >= 0 && (t.indexOf('Tj') >= 0 || t.indexOf('TJ') >= 0)) {
      const key = t.length + '|' + t.slice(0, 160);
      if (seen[key]) return;             // 同一内容流被重复引用时只取一次
      seen[key] = 1;
      streams.push(t);
    }
  });
  if (!streams.length) {
    // 整页是图片（扫描件）时根本不会有字体和内容流，别误导用户「编码取不出来」
    const hasImg = /\/Subtype\s*\/Image/.test(s) || /\/Image/.test(s);
    throw new Error(hasImg
      ? '这个 PDF 是扫描件（整页都是图片），取不到文字。请截图后粘贴进来识别，或用 Word 打开另存为 .docx'
      : '这个 PDF 里没有找到文字内容（可能是空白文件或已损坏）');
  }

  const objs = Object.keys(cmapByObj);
  const merged = {};
  objs.forEach((k) => Object.assign(merged, cmapByObj[k]));
  const single = objs.length === 1 ? cmapByObj[objs[0]] : null;

  function resolveMap(name) {
    if (name && resToFont[name] != null) {
      const co = fontToCmap[resToFont[name]];
      if (co != null && cmapByObj[co]) return cmapByObj[co];
    }
    return single || merged;
  }

  let out = '';
  for (const st of streams) out += pdfContentText(st, resolveMap) + '\n';
  out = out.replace(/[ \t]+\n/g, '\n');

  // 有些 PDF 把同一行画两遍（描边/阴影），去掉紧邻的重复行
  const raw = out.split('\n');
  const dedup = [];
  for (const ln of raw) {
    if (ln && dedup.length && dedup[dedup.length - 1] === ln) continue;
    dedup.push(ln);
  }
  out = dedup.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const cjk = (out.match(/[\u4e00-\u9fa5]/g) || []).length;
  const ctrl = (out.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g) || []).length;
  if (!out || (cjk === 0 && ctrl > 3)) {
    throw new Error('这个 PDF 的文字是嵌入编码，取不出来。请用 Word 打开后复制文字，或另存为 .docx 再拖进来');
  }
  return out;
}

/* ---------------- 统一入口 ---------------- */

export const LOCAL_EXTS = ['.docx', '.pdf', '.doc'];

/** 图片扩展名：只有这些才交给 Python 做离线 OCR */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif', '.tif', '.tiff'];

/** 这个扩展名能否由 Node 直接解析（不需要 Python） */
export function canParseLocally(filename) {
  const ext = (filename.match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
  return LOCAL_EXTS.includes(ext);
}

/** 是否图片（走 Python OCR） */
export function isImageExt(filename) {
  const ext = (filename.match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

/**
 * 已知但本程序无法本地解析的文本类格式 → 直接给一句人话，不要丢给 OCR。
 * 返回 null 表示「不归我管，按正常流程处理」（目前不会返回 null）。
 */
export function unsupportedHint(filename) {
  const ext = (filename.match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
  const MAP = {
    '.wps': 'WPS 文字专属格式',
    '.et': 'WPS 表格专属格式',
    '.dps': 'WPS 演示专属格式',
    '.ofd': '国产版式文件（.ofd）',
    '.rtf': '富文本格式（.rtf）',
    '.xls': 'Excel 97-2003 表格',
    '.xlsx': 'Excel 表格',
    '.csv': 'CSV 表格',
    '.ppt': 'PowerPoint 97-2003 演示',
    '.pptx': 'PowerPoint 演示',
    '.txt': '纯文本文件',
  };
  if (MAP[ext]) {
    return `这是${MAP[ext]}，本程序只解析会议通知（Word / PDF），请另存为 .docx 或打印成 .pdf 后再导入`;
  }
  if (!ext) return '这个文件没有扩展名，请确认是 .docx 或 .pdf 后重命名再导入';
  return `这个文件类型（${ext}）程序不支持，请转成 .docx 或 .pdf 再拖进来`;
}

/**
 * 解析老版 Word（.doc / Word 97-2003，OLE 复合文档）。
 * 交给 word-extractor（纯 JS，能正确处理 WPS 写的不完全标准的 OLE）。
 * 直接吃 Buffer，不落临时文件。返回正文纯文本。
 */
export async function docText(buf) {
  let WordExtractor;
  try {
    const mod = await import('word-extractor');
    WordExtractor = mod.default || mod;
  } catch (e) {
    throw new Error('本机缺少 .doc 解析组件（word-extractor），请在「会议日程应用」目录执行：npm install word-extractor');
  }
  const doc = await new WordExtractor().extract(buf);
  return doc.getBody();
}

/**
 * 解析 docx / pdf / doc。返回纯文本；失败抛 Error（message 是给用户看的中文）。
 * 其它格式返回 null，交给调用方去走 Python。
 */
export async function parseLocalFile(buf, filename) {
  const ext = (filename.match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
  if (ext === '.docx') return docxText(buf);
  if (ext === '.pdf') return pdfText(buf);
  if (ext === '.doc') {
    // 有的文件其实是 docx 被改了扩展名，按 zip 试一次
    if (looksLikeZip(toU8(buf))) return docxText(buf);
    // 真正的 .doc（OLE 复合文档）交给 word-extractor
    return docText(buf);
  }
  return null;
}
