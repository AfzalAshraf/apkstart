'use strict';
/**
 * Android guest system settings controller (`AndroidSettings`).
 *
 * Exposes Wi-Fi, Airplane Mode, Media Volume (scaled 0-100% <-> Android STREAM_MUSIC 0..max),
 * System Animations, Font Scale, Display Density (DPI), 1-Click Smoothness Tuning, and
 * Runtime Permissions directly inside ApkStart Settings without needing root or Android Launcher.
 */
const { assertSafePkg, shQuote } = require('./adb');

const SAFE_PERM = /^[A-Za-z0-9_.]+$/;

const ACTIONS = {
  settings: 'android.settings.SETTINGS',
  wifi: 'android.settings.WIFI_SETTINGS',
  display: 'android.settings.DISPLAY_SETTINGS',
  sound: 'android.settings.SOUND_SETTINGS',
  locale: 'android.settings.LOCALE_SETTINGS',
  date: 'android.settings.DATE_SETTINGS',
  apps: 'android.settings.APPLICATION_SETTINGS',
  storage: 'android.settings.INTERNAL_STORAGE_SETTINGS',
  battery: 'android.settings.BATTERY_SAVER_SETTINGS',
  cast: 'android.settings.CAST_SETTINGS',
  dev: 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS',
};

class AndroidSettings {
  constructor(runtime) { this.runtime = runtime; }

  async client() {
    const rt = await this.runtime.ensure();
    if (!rt.ok) throw new Error(rt.error || 'Android runtime is not ready');
    return rt.client;
  }

  async _sh(commands) {
    const c = await this.client();
    const script = commands.map((x) => `${x}; `).join('');
    return c.shell(script, { timeout: 20000 });
  }

  async status() {
    const out = await this._sh([
      'echo "wifi=$(settings get global wifi_on)"',
      'echo "air=$(settings get global airplane_mode_on)"',
      'echo "font=$(settings get system font_scale)"',
      'echo "density=$(wm density | tail -n1 | tr -dc \'0-9\')"',
      'echo "animw=$(settings get global window_animation_scale)"',
      'echo "sdk=$(getprop ro.build.version.sdk)"',
      'echo "volcur=$(dumpsys audio | grep -m1 -A6 \'^- STREAM_MUSIC:\' | grep -o \'streamVolume:[0-9]*\\|Current:[^\\n]*\' | head -1)"',
      'echo "volmax=$(dumpsys audio | grep -m1 -A4 \'^- STREAM_MUSIC:\' | grep -o \'Max: *[0-9]*\' | head -1 | tr -dc \'0-9\')"',
    ]);
    const get = (k) => {
      const m = new RegExp(`${k}=([^\\r\\n]*)`).exec(String(out));
      return m ? m[1].trim() : '';
    };
    const anim = get('animw');
    const maxIdx = Math.max(1, Number(get('volmax')) || 15);
    const curRaw = get('volcur');
    let curIdx = Number((/streamVolume:(\d+)/.exec(curRaw) || [])[1]);
    if (!Number.isFinite(curIdx)) {
      const m2 = /(?:\(speaker\)|default|2):\s*(\d+)/i.exec(curRaw) || /(\d+)\s*$/.exec(curRaw);
      curIdx = m2 ? Number(m2[1]) : Math.round(maxIdx * 0.6);
    }
    const volumePct = Math.max(0, Math.min(100, Math.round((curIdx / maxIdx) * 100)));

    return {
      wifi: get('wifi') === '1',
      airplane: get('air') === '1',
      fontScale: Number(get('font')) || 1,
      density: Number(get('density')) || 0,
      volume: volumePct,
      volumeIndex: curIdx,
      volumeMax: maxIdx,
      animationsOff: anim === '0.0' || anim === '0',
      sdk: Number(get('sdk')) || 0,
    };
  }

  async setWifi(on) {
    await this._sh([`svc wifi ${on ? 'enable' : 'disable'}`]);
    return { ok: true };
  }

  async setAirplane(on) {
    const v = on ? 1 : 0;
    await this._sh([
      `settings put global airplane_mode_on ${v}`,
      `am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${on ? 'true' : 'false'}`,
      `svc wifi ${on ? 'disable' : 'enable'}`,
      `svc data ${on ? 'disable' : 'enable'}`,
    ]);
    return { ok: true };
  }

  /**
   * Set Android STREAM_MUSIC (stream 3) volume from a 0..100 UI percentage.
   * Uses `cmd media_session volume` (Android 11-14+) with fallback to `media volume` (Android 9-10).
   */
  async setVolume(percent) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const maxOut = await this._sh([
      'dumpsys audio | grep -m1 -A4 \'^- STREAM_MUSIC:\' | grep -o \'Max: *[0-9]*\' | head -1 | tr -dc \'0-9\'',
    ]).catch(() => '');
    const maxIdx = Math.max(1, Number(String(maxOut || '').trim()) || 15);
    const idx = Math.max(0, Math.min(maxIdx, Math.round((pct / 100) * maxIdx)));
    await this._sh([
      `(cmd media_session volume --stream 3 --set ${idx} 2>/dev/null || media volume --stream 3 --set ${idx} 2>/dev/null || true)`,
    ]);
    return { ok: true, volume: pct, volumeIndex: idx, volumeMax: maxIdx };
  }

  async setAnimations(on) {
    const v = on ? '1' : '0';
    await this._sh([
      `settings put global window_animation_scale ${v}`,
      `settings put global transition_animation_scale ${v}`,
      `settings put global animator_duration_scale ${v}`,
    ]);
    return { ok: true, animationsOff: !on };
  }

  async setFontScale(scale) {
    const v = Math.max(0.85, Math.min(1.3, Number(scale) || 1)).toFixed(2);
    await this._sh([`settings put system font_scale ${v}`]);
    return { ok: true, fontScale: Number(v) };
  }

  async setDensity(dpi) {
    const v = Math.max(120, Math.min(640, Math.round(Number(dpi) || 0)));
    if (!v) return { ok: false };
    await this._sh([`wm density ${v}`]);
    return { ok: true, density: v };
  }

  async tune({ pkg } = {}) {
    const cmds = [
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put global activity_manager_constants max_cached_processes=32',
    ];
    if (pkg) {
      const safe = assertSafePkg(pkg);
      cmds.push(`dumpsys deviceidle whitelist +${shQuote(safe)}`);
    }
    await this._sh(cmds);
    return { ok: true };
  }

  async open(action) {
    const a = ACTIONS[action] || ACTIONS.settings;
    const c = await this.client();
    await c.shell(`am start -a ${a}`, { timeout: 15000 });
    return { ok: true };
  }

  async permissions(pkg) {
    const safe = assertSafePkg(pkg);
    const c = await this.client();
    const dump = await c.shell(`dumpsys package ${shQuote(safe)}`, { timeout: 20000 });
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const rows = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break;
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m) rows.push({ name: m[1], granted: m[2] === 'true' });
    }
    return rows;
  }

  async grantAll(pkg) {
    const safe = assertSafePkg(pkg);
    const c = await this.client();
    const rows = await this.permissions(safe);
    const denied = rows.filter((r) => !r.granted && SAFE_PERM.test(r.name)).map((r) => r.name);
    for (const p of denied) {
      // eslint-disable-next-line no-await-in-loop
      await c.shell(`pm grant ${shQuote(safe)} ${shQuote(p)}`, { timeout: 8000 }).catch(() => {});
    }
    return { ok: true, granted: denied.length };
  }
}

module.exports = { AndroidSettings, ACTIONS };
