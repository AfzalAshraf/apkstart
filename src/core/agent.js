'use strict';
/**
 * Node client for the persistent Win32 PowerShell + C# P/Invoke window agent (`win/agent.ps1`).
 *
 * All Win32 operations (re-parenting the Android Emulator Qt window into our BrowserWindow,
 * hiding stray console/toolbar windows, injecting Ctrl+Left/Right rotation, and running the
 * foreground-scoped `WH_MOUSE_LL` pointer hook) execute inside a single long-lived helper
 * communicating over newline-delimited JSON on `127.0.0.1`.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const EventEmitter = require('events');

const SCRIPT = path.join(__dirname, 'win', 'agent.ps1');

class WinAgent extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.port = 0;
    this.ready = null;
    this.pending = [];
    this.rxBuf = '';
    this.hooked = false;
    this.hookConfig = { right: 0, wheel: 0, side: 0 };
    this.disposed = false;
  }

  available() {
    return process.platform === 'win32' && fs.existsSync(SCRIPT);
  }

  ensure() {
    if (!this.available() || this.disposed) return Promise.resolve(false);
    if (this.ready) return this.ready;
    this.ready = this._start().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  _start() {
    return new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', SCRIPT,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = proc;

      let settled = false;
      const fail = (why) => {
        if (settled) return;
        settled = true;
        this._cleanup();
        reject(new Error(`WinAgent failed to start: ${why}`));
      };

      const timer = setTimeout(() => fail('startup-timeout'), 12000);
      let out = '';
      proc.stdout.on('data', (b) => {
        out += b.toString('utf8');
        const m = /PORT=(\d+)/.exec(out);
        if (!m || settled) return;
        this.port = Number(m[1]);
        const sock = net.createConnection({ host: '127.0.0.1', port: this.port }, () => {
          clearTimeout(timer);
          settled = true;
          this.sock = sock;
          this._wireSocket(sock);
          resolve(true);
        });
        sock.on('error', (e) => fail(e.message));
      });
      proc.on('exit', (code) => {
        fail(`exit-${code}`);
        this._cleanup();
        this.emit('exit', code);
      });
      proc.on('error', (e) => fail(e.message));
    });
  }

  _wireSocket(sock) {
    sock.on('data', (b) => {
      this.rxBuf += b.toString('utf8');
      let nl;
      while ((nl = this.rxBuf.indexOf('\n')) >= 0) {
        const line = this.rxBuf.slice(0, nl).trim();
        this.rxBuf = this.rxBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.ev) {
          this.emit(msg.ev, msg);
          this.emit('event', msg);
        } else {
          const w = this.pending.shift();
          if (w) { clearTimeout(w.timer); w.resolve(msg); }
        }
      }
    });
    sock.on('close', () => this._cleanup());
    sock.on('error', () => this._cleanup());
  }

  _cleanup() {
    while (this.pending.length) {
      const w = this.pending.shift();
      clearTimeout(w.timer);
      w.reject(new Error('agent-closed'));
    }
    try { this.sock?.destroy(); } catch (_) { /* ignore */ }
    this.sock = null;
    this.ready = null;
    this.hooked = false;
    this.hookConfig = { right: 0, wheel: 0, side: 0 };
  }

  async call(obj, timeout = 8000) {
    if (!this.available()) return { ok: false, skipped: true };
    await this.ensure();
    if (!this.sock) return { ok: false, error: 'no-socket' };
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        resolve({ ok: false, error: 'timeout' });
      }, timeout);
      this.pending.push(entry);
      try {
        this.sock.write(JSON.stringify(obj) + '\n');
      } catch (e) {
        clearTimeout(entry.timer);
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(e);
      }
    });
  }

  embed(hostHwnd, rect, clipTop = 0) {
    return this.call({ cmd: 'embed', host: Number(hostHwnd), ...rect, clipTop }, 6000);
  }
  fit(rect, clipTop = 0) {
    return this.call({ cmd: 'fit', ...rect, clipTop }, 3000);
  }
  rotate(dir = 'right') {
    return this.call({ cmd: 'rotate', dir }, 6000);
  }
  hide() { return this.call({ cmd: 'hide' }, 3000); }
  show() { return this.call({ cmd: 'show' }, 3000); }
  detach() { return this.call({ cmd: 'detach' }, 3000); }
  park() { return this.call({ cmd: 'park' }, 3000); }
  setPerformanceMode(on) { return this.call({ cmd: 'perf', on: on ? 1 : 0 }, 3000); }
  probe() { return this.call({ cmd: 'probe' }, 3000); }
  consoles() { return this.call({ cmd: 'consoles' }, 4000); }
  windows(includeHidden = false) { return this.call({ cmd: 'windows', all: includeHidden ? 1 : 0 }, 4000); }
  bootHide(on = true) { return this.call({ cmd: 'boothide', on: on ? 1 : 0 }, 3000); }

  scope(dirs, appPid = process.pid) {
    const clean = (Array.isArray(dirs) ? dirs : [dirs])
      .map((d) => String(d || '').trim())
      .filter(Boolean)
      .join(';');
    return this.call({ cmd: 'scope', dirs: clean, pid: Number(appPid) || 0 }, 3000);
  }

  /**
   * Install or remove the foreground-scoped `WH_MOUSE_LL` pointer hook idempotently.
   * Calling `setHook(false)` when no agent process is running does NOT spawn PowerShell.
   */
  async setHook(on, opts = {}) {
    const want = !!on;
    const cfg = want ? {
      right: opts.rightBack ? 1 : 0,
      wheel: (opts.wheel === true || opts.wheel === 'smooth') ? 1 : 0,
      side: opts.side ? 1 : 0,
    } : { right: 0, wheel: 0, side: 0 };

    if (!want && !this.hooked) return { ok: true, hooked: false, noop: true };
    const sameCfg = this.hookConfig
      && this.hookConfig.right === cfg.right
      && this.hookConfig.wheel === cfg.wheel
      && this.hookConfig.side === cfg.side;
    if (want && this.hooked && sameCfg) return { ok: true, hooked: true, noop: true };

    const r = await this.call({ cmd: 'hook', on: want ? 1 : 0, ...cfg }, 4000);
    if (r && r.ok) {
      this.hooked = want && r.hooked !== false;
      this.hookConfig = cfg;
    }
    return r;
  }

  hook(on) { return this.setHook(on, { side: !!on }); }

  dispose() {
    this.disposed = true;
    try {
      if (this.sock) {
        this.sock.write('{"cmd":"park"}\n{"cmd":"hook","on":0}\n{"cmd":"quit"}\n');
      }
    } catch (_) { /* ignore */ }
    setTimeout(() => {
      try { this.proc?.kill(); } catch (_) { /* ignore */ }
      this._cleanup();
    }, 350).unref?.();
  }
}

module.exports = { WinAgent, SCRIPT };
