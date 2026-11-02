#!/usr/bin/env node
// 脱敏门禁：扫描暂存区（或给定文件）中的敏感词与密钥模式。
// 数据来源：.redact.yaml 的 [sensitive] 节。
// 用法：
//   node scripts/redact-check.mjs            # 扫描 git 暂存区 + 工作区新增文件
//   node scripts/redact-check.mjs --all      # 扫描整个被跟踪文件集（脱敏审计用）
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const redactFile = path.join(ROOT, '.redact.yaml');

function loadSensitive() {
  if (!existsSync(redactFile)) return [];
  const txt = readFileSync(redactFile, 'utf8');
  const lines = txt.split(/\r?\n/);
  let inSec = false;
  const words = [];
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('[')) { inSec = line === '[sensitive]'; continue; }
    if (!inSec || !line || line.startsWith('#')) continue;
    words.push(line);
  }
  return words.filter(Boolean);
}

// 密钥/凭证模式（与 Jira 工作流管家的安全纪律一致）
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,                                  // AWS Access Key
  /gh[pousr]_[0-9A-Za-z]{20,}/,                        // GitHub token
  /xox[baprs]-[0-9A-Za-z-]{10,}/,                      // Slack token
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,        // JWT
];

function scanContent(file, content, words, hits) {
  for (const w of words) {
    if (content.includes(w)) hits.push(`${file}: 敏感词「${w}」`);
  }
  for (const re of SECRET_PATTERNS) {
    if (re.test(content)) hits.push(`${file}: 疑似密钥/凭证 (${re.source.slice(0, 30)}…)`);
  }
}

function gitFiles(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const words = loadSensitive();
  // 脱敏字典（.redact.yaml）含真实名单，属本机敏感文件，不进 Git。
  // 外部协作者 clone 后无该文件时，门禁降级为「仅扫密钥」，不阻断提交。
  if (words.length === 0) {
    console.warn('ℹ 本机缺少 .redact.yaml（真实名单不在仓库内），门禁降级为仅扫密钥。');
  }
  const all = process.argv.includes('--all');
  // 只扫文本文件，避免二进制/图片误报
  const TEXT_EXT = /\.(mjs|js|ts|html|md|json|txt|yaml|yml|css|sh|vbs|cmd|bat|py)$/i;
  // 脱敏事实来源（.redact.yaml / redact-src.mjs 含敏感词清单，是门禁自身，不算需拦截对象）
  const SKIP_SELF = /(^|[\\/])(\.redact\.yaml|redact-src\.mjs|redact-check\.mjs)$/;

  let files = [];
  if (all) {
    files = gitFiles(['ls-files']);
  } else {
    const staged = gitFiles(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
    const unstaged = gitFiles(['diff', '--name-only', '--diff-filter=ACMR']);
    const untracked = gitFiles(['ls-files', '--others', '--exclude-standard']);
    files = [...new Set([...staged, ...unstaged, ...untracked])];
  }

  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (!TEXT_EXT.test(f)) continue;
    if (SKIP_SELF.test(f)) continue;
    const fp = path.join(ROOT, f);
    if (!existsSync(fp)) continue;
    let content;
    try { content = readFileSync(fp, 'utf8'); } catch { continue; }
    scanned++;
    scanContent(f, content, words, hits);
  }

  if (hits.length > 0) {
    console.error('❌ 脱敏门禁拦截：发现以下敏感内容，请先脱敏或加入 .gitignore 后再提交：');
    for (const h of hits) console.error('   ' + h);
    process.exit(1);
  }
  console.log(`✅ 脱敏门禁通过：扫描 ${scanned} 个文件，无敏感词/密钥。`);
}

main();
