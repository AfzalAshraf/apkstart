'use strict';
/**
 * Fallback Win32 controller for emulator windows that cannot be embedded.
 * Requests are sent as UTF-8 JSON files because Windows PowerShell argument
 * parsing is not reliable for arbitrary Unicode window titles or paths.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'win', 'windowctl.ps1');

class WindowController {
  constructor() {
    this.lastMode = null;
  }

  available() {
    return process.platform === 'win32' && fs.existsSync(SCRIPT);
  }

  _call(payload) {
    if (!this.available()) return Promise.resolve({ ok: false, skipped: true });
    const jsonPath = path.join(os.tmpdir(), `apkstart-windowctl-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');
    } catch (error) {
      return Promise.resolve({ ok: false, error: error.message });
    }
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, jsonPath,
      ], { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (error, stdout) => {
        try { fs.rmSync(jsonPath, { force: true }); } catch (_) { /* ignore */ }
        if (error) return resolve({ ok: false, error: error.message });
        const text = String(stdout || '');
        const result = { ok: /(?:^|\r?\n)OK=1(?:\r?\n|$)/.test(text), raw: text.trim() };
        for (const [key, name] of [['x', 'X'], ['y', 'Y'], ['w', 'W'], ['h', 'H'], ['maximized', 'MAX']]) {
          const match = new RegExp(`(?:^|\\r?\\n)${name}=(-?\\d+)`).exec(text);
          if (match) result[key] = name === 'MAX' ? match[1] === '1' : Number(match[1]);
        }
        resolve(result);
      });
    });
  }

  run(mode, width = 0, height = 0) {
    const action = mode === 'windowed' ? 'window' : mode;
    const payload = { action, pid: 0 };
    if (Number(width) > 0 && Number(height) > 0) {
      payload.bounds = { x: 0, y: 0, w: Math.round(width), h: Math.round(height) };
    }
    return this._call(payload).then((result) => {
      if (result.ok) this.lastMode = action;
      return result;
    });
  }

  present({ pid = 0, title = '', icon = '', bounds, fullscreen = false } = {}) {
    return this._call({
      action: fullscreen ? 'fullscreen' : 'window',
      pid,
      title,
      icon,
      bounds: bounds || undefined,
    });
  }

  async getBounds(pid = 0) {
    const targetPid = typeof pid === 'object' && pid ? pid.pid || 0 : pid;
    const result = await this._call({ action: 'get', pid: Number(targetPid) || 0 });
    if (!result.ok) return null;
    return {
      x: result.x || 0,
      y: result.y || 0,
      width: result.w || 0,
      height: result.h || 0,
      maximized: Boolean(result.maximized),
    };
  }

  fullscreen() { return this.run('fullscreen'); }
  windowed(width, height) { return this.run('window', width, height); }
  restore() { return this.run('window'); }
  hide() { return this._call({ action: 'hide', pid: 0 }); }
  show() { return this._call({ action: 'focus', pid: 0 }); }
}

const defaultController = new WindowController();

module.exports = {
  WindowController,
  SCRIPT,
  present: (...args) => defaultController.present(...args),
  getBounds: (...args) => defaultController.getBounds(...args),
};
