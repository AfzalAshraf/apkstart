'use strict';
/**
 * Desktop mouse -> Android touch/key mapping (`pointer.js`, pure functions, zero Electron dependency).
 *
 * Maps:
 *   - Right-click -> Android BACK (`input keyevent 4`)
 *   - Mouse wheel -> Coalesced smooth swipe (`input swipe x1 y1 x2 y2 duration`)
 *   - Side buttons (opt-in) -> BACK / FORWARD (`input keyevent 4` / `125`)
 *
 * All generated shell commands are validated by `isInputCommand` so arbitrary text
 * can never reach `AdbClient.input()`.
 */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function pointerOptions(settings) {
  const e = (settings && settings.engine) || {};
  const rightBack = e.mouseRightBack !== false;
  const wheel = ['smooth', 'native', 'off'].includes(e.mouseWheelMode)
    ? e.mouseWheelMode
    : 'smooth';
  const side = Boolean(e.mouseSideButtons);
  const priorityMode = ['balanced', 'performance', 'game'].includes(e.priorityMode)
    ? e.priorityMode
    : 'balanced';
  return {
    rightBack,
    wheel,
    side,
    priorityMode,
    enabled: rightBack || wheel === 'smooth' || side,
  };
}

function hookOptions(opts) {
  if (typeof opts === 'boolean') {
    return { enabled: opts, rightBack: false, wheel: false, side: opts };
  }
  const o = opts || {};
  const enabled = Boolean(o.enabled);
  if (!enabled) return { enabled: false, rightBack: false, wheel: false, side: false };
  return {
    enabled: true,
    rightBack: Boolean(o.rightBack),
    wheel: o.wheel === 'smooth' || o.wheel === true,
    side: Boolean(o.side),
  };
}

function wheelToSwipe({ dx = 0, dy = 0, nx = 0.5, ny = 0.5, width = 1080, height = 1920 } = {}) {
  const w = Math.max(200, Math.round(Number(width) || 1080));
  const h = Math.max(200, Math.round(Number(height) || 1920));
  const cx = Math.round(clamp(Number(nx) || 0.5, 0.12, 0.88) * w);
  const cy = Math.round(clamp(Number(ny) || 0.5, 0.22, 0.78) * h);

  const vertical = Math.abs(dy) >= Math.abs(dx);
  const raw = vertical ? Number(dy) : Number(dx);
  if (!raw || !Number.isFinite(raw)) return null;

  const notches = clamp(Math.abs(raw) / 120, 0.35, 6);
  const span = vertical ? h : w;
  const dist = Math.round(clamp(notches * span * 0.15, 72, span * 0.68));
  const half = Math.round(dist / 2);
  const duration = Math.round(clamp(105 + notches * 22, 110, 220));

  let x1 = cx, y1 = cy, x2 = cx, y2 = cy;
  if (vertical) {
    const sign = raw < 0 ? 1 : -1;
    y1 = clamp(cy + sign * half, Math.round(h * 0.08), Math.round(h * 0.92));
    y2 = clamp(cy - sign * half, Math.round(h * 0.08), Math.round(h * 0.92));
    if (Math.abs(y2 - y1) < 24) return null;
  } else {
    const sign = raw > 0 ? 1 : -1;
    x1 = clamp(cx + sign * half, Math.round(w * 0.08), Math.round(w * 0.92));
    x2 = clamp(cx - sign * half, Math.round(w * 0.08), Math.round(w * 0.92));
    if (Math.abs(x2 - x1) < 24) return null;
  }
  return { x1, y1, x2, y2, duration };
}

const SAFE_INPUT_CMD = /^input (?:keyevent \d{1,3}|swipe \d{1,5} \d{1,5} \d{1,5} \d{1,5} \d{2,4}|tap \d{1,5} \d{1,5})$/;

function swipeToCommand(s) {
  if (!s) return '';
  const cmd = `input swipe ${s.x1} ${s.y1} ${s.x2} ${s.y2} ${s.duration}`;
  return SAFE_INPUT_CMD.test(cmd) ? cmd : '';
}

function isInputCommand(cmd) {
  return typeof cmd === 'string' && SAFE_INPUT_CMD.test(cmd);
}

class WheelRouter {
  constructor({ inject, getSize, flushMs = 45 } = {}) {
    this.inject = inject;
    this.getSize = getSize || (() => ({ width: 1080, height: 1920 }));
    this.flushMs = flushMs;
    this.dx = 0;
    this.dy = 0;
    this.nx = 0.5;
    this.ny = 0.5;
    this.timer = null;
    this.busy = false;
    this.disposed = false;
  }

  push({ dx = 0, dy = 0, nx = 0.5, ny = 0.5 } = {}) {
    if (this.disposed) return;
    this.dx += Number(dx) || 0;
    this.dy += Number(dy) || 0;
    if (Number.isFinite(nx)) this.nx = nx;
    if (Number.isFinite(ny)) this.ny = ny;
    if (!this.timer && !this.busy) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
      this.timer.unref?.();
    }
  }

  async flush() {
    if (this.busy || this.disposed) return;
    const dx = this.dx; const dy = this.dy;
    const nx = this.nx; const ny = this.ny;
    this.dx = 0; this.dy = 0;
    if (!dx && !dy) return;
    this.busy = true;
    try {
      const size = (await this.getSize()) || { width: 1080, height: 1920 };
      const swipe = wheelToSwipe({ dx, dy, nx, ny, width: size.width, height: size.height });
      const cmd = swipeToCommand(swipe);
      if (cmd && this.inject) await this.inject(cmd);
    } catch (_) {
      /* Ignore gesture injection errors if runtime is temporarily restarting */
    } finally {
      this.busy = false;
      if ((this.dx || this.dy) && !this.timer && !this.disposed) {
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 16);
        this.timer.unref?.();
      }
    }
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dx = 0; this.dy = 0;
  }
}

module.exports = {
  pointerOptions,
  hookOptions,
  wheelToSwipe,
  swipeToCommand,
  isInputCommand,
  WheelRouter,
};
