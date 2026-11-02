#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地文件文本提取脚本（会议日程解析辅助）
红线要求：全程本地完成，不联网。

用法：
  python extract_file.py <文件路径> [--type docx|pdf|image]

输出（stdout）：纯文本，供前端解析。错误时输出到 stderr 并返回非零码。

支持：
  - Word  .docx  → python-docx 提取段落与表格文本
  - PDF   .pdf   → pypdf 逐页提取文本
  - 图片  .png/.jpg/.jpeg/.bmp/.webp → rapidocr 离线 OCR（本地模型）
"""
import sys
import os

# 强制 stdout/stderr 使用 UTF-8 输出，避免 Windows 默认 GBK 编码导致特殊字符
# （如 ▶、生僻字）写入时抛 UnicodeEncodeError。
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

def extract_docx(path):
    import docx
    doc = docx.Document(path)
    parts = []
    # 段落
    for p in doc.paragraphs:
        t = (p.text or '').strip()
        if t:
            parts.append(t)
    # 表格（会议通知常是表格形式）
    for tbl in doc.tables:
        for row in tbl.rows:
            cells = []
            for c in row.cells:
                ct = (c.text or '').strip()
                if ct:
                    cells.append(ct)
            line = ' | '.join(cells)
            if line.strip():
                parts.append(line)
    return '\n'.join(parts)

def extract_pdf(path):
    from pypdf import PdfReader
    reader = PdfReader(path)
    parts = []
    for page in reader.pages:
        t = page.extract_text() or ''
        if t.strip():
            parts.append(t.strip())
    return '\n'.join(parts)

def extract_image(path):
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
    result, _ = engine(path)
    lines = []
    if result:
        for item in result:
            # item: [box, text, score]
            txt = item[1] if isinstance(item, (list, tuple)) else ''
            if txt:
                lines.append(str(txt))
    return '\n'.join(lines)

def main():
    if len(sys.argv) < 2:
        print('缺少文件路径参数', file=sys.stderr)
        return 2
    path = sys.argv[1]
    ftype = sys.argv[sys.argv.index('--type') + 1] if '--type' in sys.argv else None
    if not os.path.exists(path):
        print('文件不存在：' + path, file=sys.stderr)
        return 3

    ext = os.path.splitext(path)[1].lower()
    if ftype is None:
        ftype = ext.lstrip('.')

    try:
        if ftype in ('docx', 'doc', 'wps'):
            text = extract_docx(path)
        elif ftype == 'pdf':
            text = extract_pdf(path)
        elif ftype in ('png', 'jpg', 'jpeg', 'bmp', 'webp', 'image'):
            text = extract_image(path)
        else:
            print('不支持的文件类型：' + ftype, file=sys.stderr)
            return 4
    except Exception as e:
        print('提取失败：' + str(e), file=sys.stderr)
        return 5

    if not text or not text.strip():
        print('未提取到文字内容（可能是扫描件/纯图片 PDF，建议转成图片后用粘贴图片方式识别）', file=sys.stderr)
        return 6

    sys.stdout.write(text)

if __name__ == '__main__':
    sys.exit(main())
