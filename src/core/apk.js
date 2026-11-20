'use strict';
/**
 * High-level APK metadata extractor (zero external dependencies).
 *
 * Uses `ZipFile` random-access reads so multi-GB game APKs never load into RAM;
 * only `AndroidManifest.xml`, `resources.arsc`, and the chosen launcher icon are read.
 */
const fs = require('fs');
const { ZipFile } = require('./zip');
const { parseAxml, attrValue, findFirst, findAll } = require('./axml');
const { ResTable } = require('./arsc');

function isRef(v) {
  return v && typeof v === 'object' && v.type === 'ref';
}

function activityCandidates(appNode) {
  if (!appNode) return [];
  return [
    ...(appNode.children || []).filter((child) => child.name === 'activity'),
    ...(appNode.children || []).filter((child) => child.name === 'activity-alias'),
  ];
}

function findLauncherActivity(appNode, pkg) {
  if (!appNode) return null;
  const candidates = activityCandidates(appNode);

  const qualify = (name) => {
    if (!name) return null;
    if (name.startsWith('.')) return pkg + name;
    if (!name.includes('.')) return `${pkg}.${name}`;
    return name;
  };

  for (const act of candidates) {
    const filters = act.children.filter((c) => c.name === 'intent-filter');
    for (const f of filters) {
      const actions = f.children.filter((c) => c.name === 'action').map((a) => attrValue(a, 'name'));
      const cats = f.children.filter((c) => c.name === 'category').map((a) => attrValue(a, 'name'));
      const isMain = actions.includes('android.intent.action.MAIN');
      const isLauncher = cats.includes('android.intent.category.LAUNCHER')
        || cats.includes('android.intent.category.LEANBACK_LAUNCHER');
      if (isMain && isLauncher) {
        // IMPORTANT: When an <activity-alias> declares MAIN + LAUNCHER, the alias itself
        // is the exported launch component; its `targetActivity` is frequently `exported="false"`
        // and launching `targetActivity` directly throws SecurityException!
        const name = attrValue(act, 'name');
        return qualify(name);
      }
    }
  }
  const first = candidates[0];
  return first ? qualify(attrValue(first, 'name')) : null;
}

function resolveAdaptiveIcon(zip, res, xmlPath) {
  const raw = zip.read(xmlPath);
  if (!raw) return [];
  let tree;
  try { tree = parseAxml(raw); } catch (_) { return []; }
  const out = [];
  for (const tag of ['foreground', 'monochrome', 'background']) {
    for (const node of findAll(tree, tag)) {
      const dr = attrValue(node, 'drawable');
      if (isRef(dr) && res) out.push(...res.resolveIconPaths(dr.id));
      else if (typeof dr === 'string') out.push(dr);
    }
  }
  return out;
}

function extractIcon(zip, res, iconAttr) {
  let paths = [];
  if (isRef(iconAttr) && res) {
    paths = res.resolveIconPaths(iconAttr.id);
  } else if (typeof iconAttr === 'string') {
    paths = [iconAttr];
  }

  for (const p of paths) {
    if (/\.(png|webp|jpg)$/i.test(p) && zip.has(p)) {
      return { data: zip.read(p), path: p };
    }
  }
  for (const p of paths) {
    if (/\.xml$/i.test(p) && zip.has(p)) {
      for (const sub of resolveAdaptiveIcon(zip, res, p)) {
        if (/\.(png|webp|jpg)$/i.test(sub) && zip.has(sub)) {
          return { data: zip.read(sub), path: sub };
        }
      }
    }
  }
  const guess = zip.names()
    .filter((n) => /^res\/(mipmap|drawable)[^/]*\/ic_launcher[^/]*\.(png|webp)$/i.test(n))
    .sort((a, b) => b.length - a.length);
  if (guess.length) return { data: zip.read(guess[0]), path: guess[0] };
  return null;
}

function parseApkZip(zip, sizeBytes = 0) {
  const manifestRaw = zip.read('AndroidManifest.xml');
  if (!manifestRaw) throw new Error('APK archive is missing AndroidManifest.xml');
  const root = parseAxml(manifestRaw);

  let res = null;
  if (zip.has('resources.arsc')) {
    try { res = new ResTable(zip.read('resources.arsc')); } catch (_) { res = null; }
  }

  const resolveStr = (v) => {
    if (typeof v === 'string') return v;
    if (isRef(v) && res) return res.resolveString(v.id);
    return null;
  };

  const pkg = attrValue(root, 'package', null) || '';
  const versionCode = Number(attrValue(root, 'versionCode') ?? 0);
  const rawVerName = attrValue(root, 'versionName');
  const versionName = String(resolveStr(rawVerName) ?? (typeof rawVerName === 'number' ? rawVerName : '')).trim() || '1.0';

  const sdk = findFirst(root, 'uses-sdk');
  const minSdk = sdk ? Number(attrValue(sdk, 'minSdkVersion') ?? 0) : 0;
  const targetSdk = sdk ? Number(attrValue(sdk, 'targetSdkVersion') ?? 0) : 0;

  const app = findFirst(root, 'application');
  const label = resolveStr(app && attrValue(app, 'label')) || pkg.split('.').pop() || 'App';
  const iconAttr = app ? (attrValue(app, 'roundIcon') ?? attrValue(app, 'icon')) : null;
  const icon = extractIcon(zip, res, iconAttr);

  const launchActivity = findLauncherActivity(app, pkg);

  const abis = new Set();
  for (const name of zip.names()) {
    const m = /^lib\/([^/]+)\/[^/]+\.so$/.exec(name);
    if (m) abis.add(m[1]);
  }

  const permissions = findAll(root, 'uses-permission')
    .map((n) => attrValue(n, 'name'))
    .filter(Boolean);

  return {
    package: pkg,
    label,
    versionName,
    versionCode,
    minSdk,
    targetSdk,
    launchActivity,
    abis: [...abis],
    permissions,
    iconPng: icon ? icon.data : null,
    iconFile: icon ? icon.path : null,
    sizeBytes,
  };
}

function parseApk(filePath) {
  const zip = new ZipFile(filePath);
  try {
    return { ...parseApkZip(zip, zip.size), filePath };
  } finally {
    zip.close();
  }
}

function quickCheck(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(4);
    const n = fs.readSync(fd, head, 0, 4, 0);
    return n === 4 && head[0] === 0x50 && head[1] === 0x4b;
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

module.exports = { parseApk, parseApkZip, quickCheck };
