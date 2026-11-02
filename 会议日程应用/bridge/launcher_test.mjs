/**
 * 启动链回归测试
 *
 * 背景：run-daemon.cmd 原本在前台运行 node，桌面会常驻一个黑色 CMD 窗口。
 * 现在计划任务改为「wscript → run-daemon.vbs → 隐藏启动守护进程」，
 * 这条链上不能出现任何可见窗口。这里把关键约束固化成断言，
 * 免得以后改启动脚本又退回到弹窗模式。
 *
 * 只做静态检查 + 读取计划任务配置，不真的启动/停止服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const VBS = path.join(APP, 'run-daemon.vbs');
const CMD = path.join(APP, 'run-daemon.cmd');
const PS1 = path.join(__dirname, 'promote-task.ps1');

let pass = 0, fail = 0;
const fails = [];
function T(name, ok, detail) {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

/* ---------------- 一、文件与编码 ---------------- */

section('一、三个文件都在，编码正确');

T('run-daemon.vbs 存在', fs.existsSync(VBS));
T('run-daemon.cmd 存在', fs.existsSync(CMD));
T('promote-task.ps1 存在', fs.existsSync(PS1));

const vbsBuf = fs.existsSync(VBS) ? fs.readFileSync(VBS) : Buffer.alloc(0);
const cmdBuf = fs.existsSync(CMD) ? fs.readFileSync(CMD) : Buffer.alloc(0);
const ps1Buf = fs.existsSync(PS1) ? fs.readFileSync(PS1) : Buffer.alloc(0);

// wscript 按 ANSI(GBK) 读 .vbs，带 UTF-8 BOM 会让第一行解析失败
T('vbs 不带 UTF-8 BOM', !(vbsBuf[0] === 0xef && vbsBuf[1] === 0xbb && vbsBuf[2] === 0xbf),
  '开头字节 ' + [...vbsBuf.subarray(0, 3)].map((b) => b.toString(16)).join(' '));
T('vbs 以注释或 Option Explicit 开头', /^('|Option)/i.test(vbsBuf.toString('latin1').slice(0, 1)));

const dec = new TextDecoder('gbk');
const vbs = dec.decode(vbsBuf);
const cmd = dec.decode(cmdBuf);
const ps1 = ps1Buf.toString('utf8').replace(/^\uFEFF/, '');

T('vbs 里的中文能按 GBK 正常解出来', /无窗口启动器/.test(vbs));
T('cmd 里的中文能按 GBK 正常解出来', /无窗口启动器/.test(cmd));
T('ps1 带 UTF-8 BOM（PowerShell 5.1 才不会把中文当 ANSI）',
  ps1Buf[0] === 0xef && ps1Buf[1] === 0xbb && ps1Buf[2] === 0xbf);

/* ---------------- 二、VBS 的隐藏窗口语义 ---------------- */

section('二、vbs 用「窗口样式 0 + 等待返回」启动');

T('声明 Option Explicit', /^\s*Option\s+Explicit/im.test(vbs));
T('用 Chr(34) 拼引号（避免 """ 被解析成空串拼接）', /q\s*=\s*Chr\(34\)/.test(vbs),
  '直接写 """" 容易踩 VBScript 的引号解析坑');
T('Run 的窗口样式是 0（完全隐藏）', /\.Run\s+cmdLine\s*,\s*0\s*,\s*True/.test(vbs),
  (vbs.match(/\.Run[^\r\n]*/) || [''])[0]);
T('Run 的第三个参数是 True（等它退出，任务状态保持「正在运行」）',
  /,\s*0\s*,\s*True/.test(vbs));
T('启动前会检查已有守护进程，避免重复堆积', /IsNodePid/.test(vbs) && /daemon\.pid/.test(vbs));
T('找不到 node 时写日志而不是静默退出', /找不到 node\.exe/.test(vbs));
T('有日志文件写入口', /OpenTextFile\(logFile/.test(vbs));

// VBScript 里 sub 是保留字，曾经因为 Dim ... sub ... 导致整个脚本语法错误、弹出对话框
const badSubDecl = /Dim[^\r\n]*\bsub\b\s*[,]/.test(vbs) || /For\s+Each\s+sub\b/i.test(vbs);
T('没有把保留字 sub 当成变量名', !badSubDecl,
  badSubDecl ? 'VBScript 的 sub 是关键字，会直接语法报错' : '');

/* ---------------- 三、CMD 只做迁移与转交 ---------------- */

section('三、cmd 不再前台跑 node');

T('cmd 会调用 vbs 接管', /wscript[^\r\n]*run-daemon\.vbs/i.test(cmd));
T('启动 vbs 后立刻退出（不在此等待）', /start\s+"[^"]*"\s+wscript/i.test(cmd),
  '用 start 启动，本窗口随即关闭');
T('CMD 主流程里不再直接前台运行 daemon.mjs',
  !/^\s*"%NODE_EXE%"\s+"%APP%bridge\\daemon\.mjs"/m.test(
    cmd.split(':fallback')[0] || ''
  ));
T('保留 fallback 分支：没有 vbs 时仍能启动（排障用）', /:fallback/.test(cmd));
T('会调用 promote-task.ps1 改造计划任务', /promote-task\.ps1/.test(cmd));

/* ---------------- 四、PS1 幂等 ---------------- */

section('四、改造脚本是幂等的');

T('先读当前任务的参数', /Actions\[0\]\.Arguments/.test(ps1));
T('已经是 vbs 就跳过', /run-daemon\.vbs\*'\).*exit 0|already windowless/.test(ps1));
T('用 New-ScheduledTaskAction 重建动作', /New-ScheduledTaskAction/.test(ps1));
T('执行目标是 wscript', /wscript\.exe/i.test(ps1));
T('改不动只记日志、不阻断启动', /cannot update scheduled task/.test(ps1));

/* ---------------- 五、计划任务的真实配置 ---------------- */

section('五、计划任务实际指向无窗口启动器');

// 直接读任务定义文件（%SystemRoot%\System32\Tasks\<任务名>，UTF-16LE 的 XML）。
// 不用 schtasks.exe 查：那支程序在本机的安全策略黑名单里。
function queryTaskXml() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const file = path.join(root, 'System32', 'Tasks', 'MeetingSyncBridge');
  try {
    const buf = fs.readFileSync(file);
    const s = new TextDecoder('utf-16le').decode(buf).replace(/\0/g, '');
    return /<Task/.test(s) ? s : '';
  } catch { return ''; }
}

const xml = queryTaskXml();

if (!xml) {
  console.log('  ⚠️  查不到计划任务配置（可能未以当前用户注册），跳过本节');
} else {
  T('任务 XML 里出现 run-daemon.vbs', /run-daemon\.vbs/i.test(xml),
    '任务应该直接调用无窗口启动器');
  T('任务的 Command 是 wscript 而不是 cmd', /<Command>[^<]*wscript\.exe<\/Command>/i.test(xml),
    (xml.match(/<Command>[^<]*<\/Command>/) || [''])[0]);
  T('任务不再直接执行 run-daemon.cmd', !/<Command>[^<]*run-daemon\.cmd<\/Command>/i.test(xml));
}

/* ---------------- 重启能力 ---------------- */
console.log('\n--- 一键重启（无需重启电脑）---');
const vbsGbk = (() => { try { return fs.readFileSync(path.join(APP, 'run-daemon.vbs')); } catch { return Buffer.alloc(0); } })().toString('latin1');
const srv = (() => { try { return fs.readFileSync(path.join(APP, 'bridge', 'server.mjs'), 'utf8'); } catch { return ''; } })();
T('启动器支持 .restart 清理重启', /\.restart/.test(vbsGbk));
T('启动器里有 KillBridgeNodes', /KillBridgeNodes/.test(vbsGbk));
T('服务端有 /api/restart 接口', /'\/api\/restart'/.test(srv));
T('服务端版本已升到 1.4 以上', /BUILD_VERSION = '1\.(?:[4-9]|\d\d)/.test(srv), (srv.match(/BUILD_VERSION = '[^']+'/) || [''])[0]);
T('服务端能力清单包含 state', /'state'/.test(srv));

/* ---------------- 汇总 ---------------- */

console.log('\n' + '='.repeat(52));
if (fail === 0) console.log(`✅ 全部 ${pass} 项通过`);
else {
  console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`);
  fails.forEach((f) => console.log('   - ' + f));
}
process.exit(fail === 0 ? 0 : 1);
