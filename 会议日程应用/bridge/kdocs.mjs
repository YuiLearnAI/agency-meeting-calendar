/**
 * 金山文档（kdocs）MCP 客户端 —— 供本地桥接服务调用
 *
 * 认证方式：WPS 设备授权（浏览器点一次「同意」），换回一个 Bearer Token，
 * 之后所有工具调用都靠它。Token 缓存在本机 bridge/.auth.json，
 * 只在 Node 进程里读取，不会出现在页面、日志或对话中。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MCP_URL = process.env.KDOCS_MCP_URL || 'https://mcp-center.wps.cn/skill_hub/mcp';
const EXCHANGE_URL = process.env.KDOCS_EXCHANGE_URL || 'https://api.wps.cn/office/v5/ai/skill_hub/wps_auth/exchange';
const AUTH_PAGE = 'https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=';
const SKILL_VERSION = '1.6.14';
const PROTOCOL = '2025-03-26';

export class KdocsError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    this.extra = extra || null;
  }
}

export class Kdocs {
  constructor(storePath) {
    this.storePath = storePath;
    this.token = '';
    this.expiresAt = 0;
    this.sessionId = '';
    this.pending = null; // 进行中的授权 {code, state, startedAt}
    this._load();
  }

  /* ---------------- Token 持久化 ---------------- */

  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      if (j && j.token) {
        this.token = String(j.token);
        this.expiresAt = Number(j.expiresAt) || 0;
      }
    } catch { /* 首次运行没有缓存，忽略 */ }
  }

  _save() {
    const body = JSON.stringify({ token: this.token, expiresAt: this.expiresAt, savedAt: new Date().toISOString() });
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, body, { encoding: 'utf8', mode: 0o600 });
  }

  authed() {
    if (!this.token) return false;
    if (this.expiresAt && Date.now() > this.expiresAt) return false;
    return true;
  }

  expiresLabel() {
    if (!this.expiresAt) return '';
    return new Date(this.expiresAt).toISOString();
  }

  /* ---------------- 设备授权 ---------------- */

  startLogin() {
    const code = crypto.randomUUID().toLowerCase();
    this.pending = { code, state: 'pending', startedAt: Date.now() };
    return { url: AUTH_PAGE + encodeURIComponent(code), code };
  }

  /** 轮询一次授权结果；返回 'pending' | 'ok' | 'denied' | 'cancelled' | 'error' */
  async pollLogin() {
    if (!this.pending) return 'idle';
    if (this.pending.state !== 'pending') return this.pending.state;
    if (Date.now() - this.pending.startedAt > 300000) {
      this.pending.state = 'timeout';
      return 'timeout';
    }
    let resp;
    try {
      resp = await postJson(EXCHANGE_URL, { code: this.pending.code });
    } catch {
      return 'pending'; // 网络抖动，继续等
    }
    const rc = String(resp && (resp.code !== undefined && resp.code !== null ? resp.code : ''));
    const tok = (resp && resp.data && resp.data.token) || (resp && resp.token) || '';
    const exp = Number((resp && resp.data && resp.data.expires_in) || (resp && resp.expires_in) || 0);
    if (rc === '200' && tok) {
      this.token = String(tok).replace(/^Bearer\s+/i, '').trim();
      this.expiresAt = Date.now() + (exp > 0 ? exp * 1000 : 30 * 864e5) - 60000;
      this._save();
      this.sessionId = '';
      this.pending.state = 'ok';
      return 'ok';
    }
    if (rc === '403') { this.pending.state = 'denied'; return 'denied'; }
    if (rc === '409') { this.pending.state = 'cancelled'; return 'cancelled'; }
    if (rc && !/^(202|5\d\d)$/.test(rc)) { this.pending.state = 'error'; this.pending.message = '授权返回码 ' + rc; return 'error'; }
    return 'pending';
  }

  /* ---------------- MCP 底层 ---------------- */

  _headers(extra) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Request-Source': 'workbuddy',
      'X-Skill-Version': SKILL_VERSION,
    };
    if (this.authed()) h.Authorization = 'Bearer ' + this.token;
    return Object.assign(h, extra || {});
  }

  async _openSession() {
    if (this.sessionId) return this.sessionId;
    const r = await fetch(MCP_URL, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'meeting-sync-bridge', version: '1.0.0' } },
      }),
    });
    const sid = r.headers.get('mcp-session-id') || '';
    await r.text();
    if (!sid) throw new KdocsError('MCP_NO_SESSION', '无法与金山文档网关建立会话');
    await fetch(MCP_URL, {
      method: 'POST',
      headers: this._headers({ 'mcp-session-id': sid }),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).then((x) => x.text());
    this.sessionId = sid;
    return sid;
  }

  static parseBody(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (t[0] === '{' || t[0] === '[') {
      try { return JSON.parse(t); } catch { return null; }
    }
    // SSE: 取最后一个 data: 行
    const lines = t.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    for (let i = lines.length - 1; i >= 0; i--) {
      const payload = lines[i].slice(5).trim();
      if (!payload) continue;
      try { return JSON.parse(payload); } catch { /* 继续 */ }
    }
    return null;
  }

  async call(name, args) {
    if (!this.authed()) throw new KdocsError('NO_AUTH', '尚未登录金山文档');
    const sid = await this._openSession();
    const r = await fetch(MCP_URL, {
      method: 'POST',
      headers: this._headers({ 'mcp-session-id': sid }),
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 100000, method: 'tools/call', params: { name, arguments: args } }),
    });
    const json = Kdocs.parseBody(await r.text());
    if (!json) throw new KdocsError('MCP_BAD_BODY', '网关返回无法解析');
    if (json.error) {
      this.sessionId = '';
      throw new KdocsError('MCP_ERROR', json.error.message || '网关错误', json.error);
    }
    const content = (json.result && json.result.content) || [];
    const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('');
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = { code: 0, data: text }; }
    if (payload && payload.code !== undefined && ![0, 200, '0', '200'].includes(payload.code)) {
      const msg = payload.message || payload.msg || ('错误码 ' + payload.code);
      if (/认证|登录|token/i.test(String(msg))) {
        this.token = ''; this._save(); this.sessionId = '';
        throw new KdocsError('NO_AUTH', '登录已失效，请重新登录金山文档');
      }
      throw new KdocsError('KDOCS_' + payload.code, msg, payload);
    }
    return payload || {};
  }
}

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.text()).then((t) => (t ? JSON.parse(t) : {}));
}
