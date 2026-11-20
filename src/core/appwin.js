'use strict';
/**
 * Dedicated per-app host window (`AppWindow`).
 *
 * Provides a clean 38px custom title bar (`shell.html`: Rotate / Minimize / Maximize / Close)
 * and embeds the Android Emulator Qt framebuffer window directly beneath Chromium's
 * `Chrome_RenderWidgetHostHWND` child window via `WinAgent`.
 */
const path = require('path');
const { BrowserWindow, screen, nativeImage } = require('electron');

const TITLE_BAR = 38;
const PAD = 8;

function hwndInt(win) {
  const b = win.getNativeWindowHandle();
  if (b.length >= 8 && typeof b.readBigUInt64LE === 'function') {
    return Number(b.readBigUInt64LE(0));
  }
  return b.readUInt32LE(0);
}

class AppWindow {
  constructor({ agent, setOrientation, pointerConfig, onRestart }) {
    this.agent = agent;
    this.setOrientation = setOrientation || (async () => {});
    this.pointerConfig = typeof pointerConfig === 'function' ? pointerConfig : () => ({ enabled: false });
    this.onRestart = onRestart || null;
    this.win = null;
    this.pkg = null;
    this.landscape = false;
    this.embedded = false;
    this.lastEmbedError = '';
    this.portrait = { w: 540, h: 960 };
    this.state = { label: '', pkg: '', landscape: false, ready: false, tip: 'Starting...' };
    this._fitTimer = null;
    this._onCloseApp = null;
    this._suppressCloseHook = false;
    this._rotating = false;
    this.iconUrl = '';
  }

  onCloseApp(fn) { this._onCloseApp = fn; }

  get isOpen() { return Boolean(this.win && !this.win.isDestroyed()); }

  get isForeground() {
    return Boolean(this.isOpen && this.win.isVisible() && !this.win.isMinimized() && this.win.isFocused());
  }

  refreshPointer() {
    if (!this.agent) return;
    const raw = this.pointerConfig() || {};
    const game = raw.priorityMode === 'game';
    const opts = this.isForeground
      ? raw
      : { enabled: false };
    this.agent.setHook(Boolean(opts.enabled && !game), opts).catch(() => {});
  }

  open({ pkg, label, iconPath, portrait, fullscreen, landscape = false }) {
    this.pkg = pkg;
    if (portrait) this.portrait = portrait;
    this.landscape = Boolean(landscape);

    const area = screen.getPrimaryDisplay().workArea;
    const ratio = this.landscape
      ? this.portrait.h / this.portrait.w
      : this.portrait.w / this.portrait.h;
    const clientH = Math.round(area.height * 0.86) - TITLE_BAR;
    const clientW = Math.round(clientH * ratio);
    const totalH = clientH + TITLE_BAR;
    const x = area.x + Math.round((area.width - clientW) / 2);
    const y = area.y + Math.round((area.height - totalH) / 2);

    if (!this.isOpen) {
      this.embedded = false;
      this.win = new BrowserWindow({
        x, y,
        width: clientW,
        height: totalH,
        minWidth: 360,
        minHeight: 520,
        frame: false,
        show: true,
        backgroundColor: '#111317',
        title: label || 'ApkStart',
        icon: iconPath ? nativeImage.createFromPath(iconPath) : undefined,
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          spellcheck: false,
        },
      });
      this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
      this.win.on('resize', () => this.scheduleFit(2));
      this.win.on('maximize', () => this.scheduleFit(6));
      this.win.on('unmaximize', () => this.scheduleFit(6));
      this.win.on('move', () => this.scheduleFit());
      this.win.on('focus', () => this.refreshPointer());
      this.win.on('blur', () => this.refreshPointer());
      this.win.on('minimize', () => this.refreshPointer());
      this.win.on('hide', () => this.refreshPointer());
      this.win.on('closed', () => {
        const closedPkg = this.pkg;
        const suppress = this._suppressCloseHook;
        this._suppressCloseHook = false;
        this.win = null;
        this.embedded = false;
        this.agent.setHook(false).catch(() => {});
        this.agent.park().catch(() => {});
        if (!suppress && closedPkg && this._onCloseApp) {
          try { this._onCloseApp(closedPkg); } catch (_) { /* ignore */ }
        }
      });
    } else {
      this.win.setTitle(label || 'ApkStart');
      if (iconPath) this.win.setIcon(nativeImage.createFromPath(iconPath));
      if (!fullscreen && !this.win.isMaximized()) {
        this.win.setBounds({ x, y, width: clientW, height: totalH });
      }
      this.win.show();
      this.win.focus();
    }

    if (fullscreen) this.win.maximize();
    this.setState({ label: label || pkg, pkg, ready: this.embedded, landscape: this.landscape });
    this.refreshPointer();
    return this.win;
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    if ('landscape' in patch) this.landscape = Boolean(patch.landscape);
    if (this.isOpen) {
      this.win.webContents.send('shell:state', { ...this.state, iconUrl: this.iconUrl });
    }
  }

  setIcon(iconPath) {
    this.iconUrl = iconPath
      ? `file:///${iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
      : '';
    if (this.isOpen) {
      this.win.webContents.send('shell:state', { ...this.state, iconUrl: this.iconUrl });
    }
  }

  _contentDip() {
    if (!this.isOpen) return { w: 0, h: 0 };
    const [cw, ch] = this.win.getContentSize();
    return { w: cw, h: Math.max(100, ch - TITLE_BAR) };
  }

  _viewportRect() {
    if (!this.isOpen) return { x: 0, y: 0, w: 0, h: 0, clipTop: 0 };
    const b = this.win.getBounds();
    const sf = screen.getDisplayMatching(b).scaleFactor || 1;
    const { w: cw, h: availH } = this._contentDip();
    const topPx = Math.round(TITLE_BAR * sf);
    const padPx = Math.round(PAD * sf);
    const boxW = Math.round(cw * sf);
    const boxH = Math.round(availH * sf);
    return {
      x: -padPx,
      y: topPx - padPx,
      w: boxW + padPx * 2,
      h: boxH + padPx * 2,
      clipTop: 0,
    };
  }

  async embed({ timeoutMs = 15000 } = {}) {
    if (!this.isOpen) { this.lastEmbedError = 'window-closed'; return false; }
    const host = hwndInt(this.win);
    const deadline = Date.now() + timeoutMs;
    let lastReply = null;
    while (Date.now() < deadline && this.isOpen) {
      const p = await this.agent.probe();
      lastReply = p;
      if (p && p.emu) {
        const v = this._viewportRect();
        const r = await this.agent.embed(host, { x: v.x, y: v.y, w: v.w, h: v.h }, v.clipTop);
        lastReply = r;
        if (r && r.ok) {
          this.embedded = true;
          this.lastEmbedError = '';
          this.setState({ ready: true, tip: '' });
          this.scheduleFit(6);
          return true;
        }
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    this.lastEmbedError = `timeout reply=${JSON.stringify(lastReply)}`;
    return false;
  }

  scheduleFit(burst = 1) {
    clearTimeout(this._fitTimer);
    if (!this.embedded || !this.isOpen) return;
    const run = () => {
      if (!this.embedded || !this.isOpen) return;
      const v = this._viewportRect();
      this.agent.fit({ x: v.x, y: v.y, w: v.w, h: v.h }, v.clipTop).catch(() => {});
    };
    this._fitTimer = setTimeout(run, 16);
    if (burst > 1) {
      const delays = [90, 220, 450, 800, 1400].slice(0, burst - 1);
      for (const ms of delays) setTimeout(run, ms).unref?.();
    }
  }

  async rotate(onRestart) {
    if (!this.isOpen || this._rotating) return;
    this._rotating = true;
    const next = !this.landscape;
    this.landscape = next;
    try {
      if (!this.win.isMaximized()) {
        const b = this.win.getBounds();
        const area = screen.getDisplayMatching(b).workArea;
        const oldW = b.width;
        const oldH = b.height - TITLE_BAR;
        let w = Math.min(area.width - 24, Math.max(420, oldH));
        let h = Math.min(area.height - 24, Math.max(360, oldW) + TITLE_BAR);
        if (next) w = Math.max(w, Math.round((h - TITLE_BAR) * 16 / 10));
        const x = Math.max(area.x, Math.min(area.x + area.width - w, b.x + Math.round((b.width - w) / 2)));
        const y = Math.max(area.y, Math.min(area.y + area.height - h, b.y + Math.round((b.height - h) / 2)));
        this.win.setBounds({ x, y, width: w, height: h });
      }
      this.setState({
        landscape: next,
        tip: next
          ? 'Switching to landscape (restarting Android runtime, ~30-60s)...'
          : 'Switching to portrait (restarting Android runtime, ~30-60s)...',
        ready: false,
      });
      const restartFn = typeof onRestart === 'function' ? onRestart : this.onRestart;
      if (typeof restartFn === 'function') {
        await restartFn(next);
      } else {
        await this.setOrientation(next);
      }
      this.setState({ landscape: next, tip: '', ready: true });
      this.scheduleFit(6);
    } finally {
      this._rotating = false;
    }
  }

  async setLandscape(want) {
    if (!this.isOpen) { this.landscape = !!want; return; }
    if (Boolean(want) === Boolean(this.landscape)) {
      this.scheduleFit();
      return;
    }
    return this.rotate(this.onRestart);
  }

  close({ keepApp = false } = {}) {
    if (keepApp) this._suppressCloseHook = true;
    try { this.agent.park(); } catch (_) { /* ignore */ }
    if (this.isOpen) this.win.close();
  }
}

module.exports = { AppWindow, TITLE_BAR };
