'use strict';
/**
 * Android guest resolution, orientation, and screen-density controller (`DisplayController`).
 *
 * Coordinates Android `wm size`, `wm density`, `accelerometer_rotation`, `user_rotation`,
 * and immersive navigation/status bar policies so apps look native in both windowed portrait
 * and fullscreen/landscape desktop layouts.
 */
function parseSize(spec) {
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(String(spec || '').trim());
  if (!m) return { w: 540, h: 960 };
  return { w: Number(m[1]), h: Number(m[2]) };
}

function autoDensity(w, h) {
  const shortSide = Math.min(w, h);
  if (shortSide <= 600) return 240;
  if (shortSide <= 800) return 320;
  if (shortSide <= 1200) return 420;
  return 480;
}

function sizeFor(_mode, spec) {
  return parseSize(spec);
}

function densityFor(w, h, requested = 0) {
  const value = Number(requested);
  return Number.isFinite(value) && value > 0 ? value : autoDensity(w, h);
}

function defaultBounds(area = {}) {
  const x0 = Number(area.x) || 0;
  const y0 = Number(area.y) || 0;
  const areaW = Number(area.w || area.width) || 1920;
  const areaH = Number(area.h || area.height) || 1080;
  const h = Math.min(areaH, 900);
  const w = Math.min(areaW, Math.round(h * 9 / 16));
  return {
    x: x0 + Math.round((areaW - w) / 2),
    y: y0 + Math.round((areaH - h) / 2),
    w,
    h,
  };
}

function fullscreenBounds(spec, area = {}) {
  const { w: baseW, h: baseH } = parseSize(spec);
  const x0 = Number(area.x) || 0;
  const y0 = Number(area.y) || 0;
  const areaW = Number(area.w || area.width) || 1920;
  const areaH = Number(area.h || area.height) || 1080;
  const h = areaH;
  const w = Math.min(areaW, Math.round(h * baseW / baseH));
  return { x: x0 + Math.round((areaW - w) / 2), y: y0, w, h };
}

class DisplayController {
  constructor(getClient, getSettings, windowCtl) {
    this.getClient = getClient;
    this.getSettings = getSettings;
    this.windowCtl = windowCtl;
    this.appliedKey = '';
  }

  primaryScreenSize() {
    try {
      const d = require('electron').screen.getPrimaryDisplay();
      const sf = d.scaleFactor || 1;
      return {
        w: Math.round(d.size.width * sf),
        h: Math.round(d.size.height * sf),
        workW: d.workAreaSize.width,
        workH: d.workAreaSize.height,
        scale: sf,
      };
    } catch (_) {
      return { w: 1920, h: 1080, workW: 1920, workH: 1040, scale: 1 };
    }
  }

  targetForMode(mode, appRecord) {
    const s = this.getSettings();
    const disp = s.display || {};
    const wantLandscape = disp.landscape || (appRecord && appRecord.preferLandscape);

    if (mode === 'fullscreen') {
      const scr = this.primaryScreenSize();
      return {
        mode: 'fullscreen',
        w: scr.w,
        h: scr.h,
        density: disp.density || autoDensity(scr.w, scr.h),
        rotation: scr.w >= scr.h ? 1 : 0,
        immersive: true,
      };
    }

    const base = parseSize(disp.portrait || '540x960');
    const w = wantLandscape ? Math.max(base.w, base.h) : Math.min(base.w, base.h);
    const h = wantLandscape ? Math.min(base.w, base.h) : Math.max(base.w, base.h);
    return {
      mode: 'window',
      w,
      h,
      density: disp.density || autoDensity(w, h),
      rotation: wantLandscape ? 1 : 0,
      immersive: false,
    };
  }

  async apply(modeOverride, appRecord, { force = false } = {}) {
    const client = await this.getClient();
    if (!client) return { ok: false, reason: 'no-client' };
    const s = this.getSettings();
    const mode = modeOverride || (s.display && s.display.mode) || 'window';
    const t = this.targetForMode(mode, appRecord);
    const key = `${t.mode}:${t.w}x${t.h}@${t.density}:r${t.rotation}:i${t.immersive ? 1 : 0}`;

    if (force || key !== this.appliedKey) {
      const cmds = [
        `wm size ${t.w}x${t.h}`,
        `wm density ${t.density}`,
        'settings put system accelerometer_rotation 0',
        `settings put system user_rotation ${t.rotation}`,
        t.immersive
          ? 'settings put global policy_control immersive.full=*'
          : 'settings put global policy_control null',
      ];
      for (const c of cmds) {
        try { await client.shell(c, { timeout: 8000 }); } catch (_) { /* ignore */ }
      }
      this.appliedKey = key;
    }

    if (this.windowCtl && this.windowCtl.available()) {
      setTimeout(() => {
        if (t.mode === 'fullscreen') {
          this.windowCtl.fullscreen().catch(() => {});
        } else {
          const scr = this.primaryScreenSize();
          const ratio = t.w / t.h;
          const winH = Math.min(Math.round(scr.workH * 0.88), t.h);
          const winW = Math.round(winH * ratio);
          this.windowCtl.windowed(winW, winH).catch(() => {});
        }
      }, 350);
    }

    return { ok: true, target: t };
  }

  async reset() {
    const client = await this.getClient();
    if (!client) return;
    this.appliedKey = '';
    for (const c of [
      'wm size reset',
      'wm density reset',
      'settings put global policy_control null',
      'settings put system accelerometer_rotation 1',
    ]) {
      try { await client.shell(c, { timeout: 6000 }); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = {
  DisplayController,
  parseSize,
  autoDensity,
  sizeFor,
  densityFor,
  defaultBounds,
  fullscreenBounds,
};
