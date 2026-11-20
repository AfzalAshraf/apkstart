'use strict';
/**
 * Desktop Freeform multi-window helper (`container.js`).
 *
 * Queries Android freeform windowing capability and generates `am start` flags
 * (`--windowingMode 5 --bounds l t r b` on Android 9+) so desktop-friendly Android apps
 * can run side-by-side inside a shared Android session.
 */

const WINDOWING_MODE_FULLSCREEN = 1;
const WINDOWING_MODE_FREEFORM = 5;

function parseSdk(text) {
  const n = parseInt(String(text || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function probeFreeform(client) {
  if (!client) return { supported: false, enabled: false, sdk: 0 };
  try {
    const sdk = parseSdk(await client.shell('getprop ro.build.version.sdk', { timeout: 6000 }));
    if (sdk < 24) return { supported: false, enabled: false, sdk };
    const setting = String(await client.shell(
      'settings get global enable_freeform_support', { timeout: 6000 },
    )).trim();
    const feat = String(await client.shell(
      'pm list features 2>/dev/null | grep -i freeform || true', { timeout: 8000 },
    ));
    const hasFeature = /android\.software\.freeform_window_management/i.test(feat);
    return {
      supported: sdk >= 28 || hasFeature,
      enabled: setting === '1' || hasFeature,
      sdk,
      hasFeature,
    };
  } catch (e) {
    return { supported: false, enabled: false, sdk: 0, error: e.message };
  }
}

async function setFreeform(client, on) {
  const v = on ? '1' : '0';
  await client.shell(
    `settings put global enable_freeform_support ${v}; `
    + `settings put global force_resizable_activities ${v}`,
    { timeout: 10000 },
  );
  return probeFreeform(client);
}

function launchArgs({ freeform = false, bounds = null, sdk = 30 } = {}) {
  if (!freeform || sdk < 28) return [];
  const out = ['--windowingMode', String(WINDOWING_MODE_FREEFORM)];
  if (bounds && [bounds.l, bounds.t, bounds.r, bounds.b].every(Number.isFinite)) {
    const l = Math.max(0, Math.round(bounds.l));
    const t = Math.max(0, Math.round(bounds.t));
    const r = Math.max(l + 200, Math.round(bounds.r));
    const b = Math.max(t + 200, Math.round(bounds.b));
    out.push('--bounds', String(l), String(t), String(r), String(b));
  }
  return out;
}

function defaultBounds({ width = 1080, height = 1920, slot = 0 } = {}) {
  const w = Math.max(360, Math.round(width));
  const h = Math.max(480, Math.round(height));
  const boxW = Math.round(w * 0.78);
  const boxH = Math.round(h * 0.78);
  const step = 36;
  const k = Math.max(0, slot | 0) % 5;
  const l = Math.min(w - boxW, Math.round((w - boxW) / 2) + (k - 2) * step);
  const t = Math.min(h - boxH, Math.round((h - boxH) / 2) + (k - 2) * step);
  return {
    l: Math.max(0, l),
    t: Math.max(0, t),
    r: Math.max(0, l) + boxW,
    b: Math.max(0, t) + boxH,
  };
}

// Session trimming is deliberately allow-list based. Core Android, Google Play
// services, and the foreground package are never stopped or disabled.
const NEVER_TRIM = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.providers.settings',
  'com.android.providers.media',
  'com.google.android.gms',
  'com.google.android.gsf',
];
const OPTIONAL_SYSTEM = [
  'com.android.vending',
  'com.google.android.youtube',
  'com.google.android.apps.photos',
  'com.android.printspooler',
  'com.google.android.onetimeinitializer',
];
const SAFE_PACKAGE = /^(?:[A-Za-z][A-Za-z0-9_]*\.)+[A-Za-z][A-Za-z0-9_]*$/;

function isSystemPackage(pkg) {
  const name = String(pkg || '').trim().toLowerCase();
  if (!name) return true;
  return name === 'android'
    || name.startsWith('com.android.')
    || name.startsWith('com.google.android.');
}

function buildSessionCommands({ pkg = '', installed = [], deep = false } = {}) {
  const foreground = String(pkg || '').trim();
  const safeInstalled = [...new Set((Array.isArray(installed) ? installed : [])
    .map((name) => String(name || '').trim())
    .filter((name) => SAFE_PACKAGE.test(name) && name !== foreground && !isSystemPackage(name)))];
  const stopped = safeInstalled;
  const disabled = deep ? OPTIONAL_SYSTEM.filter((name) => !NEVER_TRIM.includes(name)) : [];
  const commands = [
    ...stopped.map((name) => `am force-stop ${name}`),
    ...disabled.map((name) => `pm disable-user --user 0 ${name}`),
  ];
  return { commands, stopped, disabled };
}

function buildRestoreCommands() {
  return OPTIONAL_SYSTEM
    .filter((name) => !NEVER_TRIM.includes(name))
    .map((name) => `pm enable ${name}`);
}

function buildIdleCommands() {
  return [
    'am kill-all',
    'cmd deviceidle force-idle',
  ];
}

function nextSessionState(active = [], action, pkg) {
  const current = [...new Set((Array.isArray(active) ? active : []).filter(Boolean))];
  const target = String(pkg || '');
  let next = current;
  if (action === 'open' && target) next = [...current.filter((name) => name !== target), target];
  else if (action === 'close' && target) next = current.filter((name) => name !== target);
  const foreground = next.length ? next[next.length - 1] : null;
  return { active: next, hasApp: next.length > 0, idle: next.length === 0, foreground };
}

module.exports = {
  WINDOWING_MODE_FULLSCREEN,
  WINDOWING_MODE_FREEFORM,
  probeFreeform,
  setFreeform,
  launchArgs,
  defaultBounds,
  NEVER_TRIM,
  OPTIONAL_SYSTEM,
  isSystemPackage,
  buildSessionCommands,
  buildRestoreCommands,
  buildIdleCommands,
  nextSessionState,
};
