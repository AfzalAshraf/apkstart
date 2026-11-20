'use strict';
/**
 * Per-user `.apk` file association (`HKCU\Software\Classes` only — no UAC elevation required).
 * Saves and restores any previous `.apk` ProgID upon unregistration so uninstalling ApkStart
 * never breaks a user's prior file association.
 */
const { execFileSync } = require('child_process');

const PROGID = 'ApkStart.apk';
const EXT = '.apk';
const CLASSES = 'HKCU\\Software\\Classes';
const STORE_KEY = 'HKCU\\Software\\ApkStart';
const PREV_VALUE = 'assocPrev';

function reg(args) {
  try {
    execFileSync('reg', args, { windowsHide: true, stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

function regDefault(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], { windowsHide: true, encoding: 'utf8' });
    const line = String(out).split(/\r?\n/).find((l) => /REG_SZ/i.test(l));
    const m = line && /REG_SZ\s+(.*)$/i.exec(line);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function readPrev() {
  try {
    const out = execFileSync('reg', ['query', STORE_KEY, '/v', PREV_VALUE], { windowsHide: true, encoding: 'utf8' });
    const m = /REG_SZ\s+(.*)$/im.exec(String(out));
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function notifyShell() {
  const ps = `
$sig = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);';
try {
  $t = Add-Type -MemberDefinition $sig -Name 'ShNotify' -Namespace 'ApkStart' -PassThru -ErrorAction Stop;
  $t::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero);
} catch {}
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, stdio: 'pipe', timeout: 8000,
    });
  } catch (_) { /* Shell refresh failure is non-fatal */ }
}

function registerAssociation(exePath, iconPath, extraArgs) {
  const icon = iconPath || exePath;
  const command = `"${exePath}" ${extraArgs ? extraArgs + ' ' : ''}"%1"`;

  const prev = regDefault(`${CLASSES}\\${EXT}`);
  if (prev && prev !== PROGID) {
    reg(['add', STORE_KEY, '/v', PREV_VALUE, '/d', prev, '/f']);
  } else if (!prev) {
    try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* ignore */ }
  }

  reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', PROGID, '/f']);
  reg(['add', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/t', 'REG_NONE', '/f']);

  reg(['add', `${CLASSES}\\${PROGID}`, '/ve', '/d', 'Android Application Package', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}`, '/v', 'FriendlyTypeName', '/d', 'Android Application Package', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\DefaultIcon`, '/ve', '/d', `"${icon}",0`, '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open`, '/ve', '/d', 'Install with ApkStart', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open\\command`, '/ve', '/d', command, '/f']);

  notifyShell();
  return { ok: true, progId: PROGID, previous: prev };
}

function unregisterAssociation() {
  reg(['delete', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/f']);
  reg(['delete', `${CLASSES}\\${PROGID}`, '/f']);

  const prev = readPrev();
  const current = regDefault(`${CLASSES}\\${EXT}`);
  let restored = '';
  if (prev) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', prev, '/f']);
    restored = prev;
  } else if (current === PROGID) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', '', '/f']);
  }
  try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* ignore */ }
  notifyShell();
  return { ok: true, restored };
}

module.exports = { registerAssociation, unregisterAssociation, PROGID };
