/* global apkstart */
'use strict';

const $ = (sel) => document.querySelector(sel);
const api = window.apkstart;

let state = { settings: { engine: {}, display: {}, runtime: {} }, apps: [], runtime: {}, provision: {} };

function setBanner(info) {
  const bar = $('#progressBanner');
  const txt = $('#progressText');
  const spin = $('#bannerSpin');
  const wrap = $('#progressBarWrap');
  const fill = $('#progressBar');
  const cancelBtn = $('#btnCancelDeploy');

  if (!info || (!info.busy && !info.message)) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.classList.toggle('err', Boolean(info.error));
  bar.classList.toggle('ok', Boolean(info.done));
  spin.style.display = info.busy ? 'block' : 'none';
  txt.textContent = info.message || '';

  if (info.busy && typeof info.ratio === 'number' && info.ratio > 0) {
    wrap.classList.remove('hidden');
    fill.style.width = `${Math.min(100, Math.round(info.ratio * 100))}%`;
  } else {
    wrap.classList.add('hidden');
  }
  cancelBtn.classList.toggle('hidden', !(info.busy && info.kind === 'deploy'));

  if (!info.busy) {
    clearTimeout(setBanner._t);
    setBanner._t = setTimeout(() => bar.classList.add('hidden'), info.error ? 9000 : 3800);
  }
}

function renderRuntime() {
  const pill = $('#rtPill');
  const txt = $('#rtText');
  const stopBtn = $('#btnStopEngine');
  const rt = state.runtime || {};
  const eng = state.engineStatus || {};
  const prov = state.provision || {};
  const builtin = (state.settings.engine || {}).mode === 'builtin';

  pill.classList.remove('online', 'offline');
  if (rt.online) {
    pill.classList.add('online');
    txt.textContent = builtin ? `Built-In Engine Ready (${rt.serial})` : `Connected: ${rt.serial}`;
    stopBtn.classList.toggle('hidden', !builtin);
  } else if (builtin && !prov.installed) {
    pill.classList.add('offline');
    txt.textContent = 'Runtime Setup Needed (Click to Install)';
    stopBtn.classList.add('hidden');
  } else if (eng.running) {
    txt.textContent = 'Booting Android Engine...';
    stopBtn.classList.remove('hidden');
  } else {
    pill.classList.add('offline');
    txt.textContent = builtin ? 'Engine Standby (Auto-boots on app launch)' : 'Offline (Click to connect)';
    stopBtn.classList.add('hidden');
  }

  const card = $('#deployCard');
  card.classList.toggle('hidden', !(builtin && !prov.installed));
}

function renderDisplaySeg() {
  const mode = (state.settings.display && state.settings.display.mode) || 'window';
  document.querySelectorAll('#dispSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

function renderProvisionBox() {
  const p = state.provision || {};
  const box = $('#provBox');
  if (!box) return;
  const check = (ok) => (ok ? '✅' : '⬜');
  const modeNote = p.installed
    ? (p.mode === 'emulator'
      ? 'Google Android Emulator (WHPX Hardware Virtualization)'
      : 'QEMU + Android-x86')
    : 'Not installed';
  box.innerHTML = `
    <div><b>Status:</b> ${modeNote} ${state.bundledRuntime ? '(Bundled Offline Runtime)' : ''}</div>
    <div class="prov-items">
      <span>${check(p.adb)} ADB Bridge</span>
      <span>${check(p.emulator || p.qemu)} Virtualization Engine</span>
      <span>${check(p.systemImage || p.iso)} Android System Image</span>
    </div>
    <div class="prov-dir">Runtime directory: ${escapeHtml(p.runtimeDir || '')}</div>
  `;
}

function renderApps() {
  const q = ($('#searchInput').value || '').trim().toLowerCase();
  const list = (state.apps || []).filter((a) => !q
    || (a.label || '').toLowerCase().includes(q)
    || (a.package || '').toLowerCase().includes(q));

  $('#appCount').textContent = String((state.apps || []).length);
  const grid = $('#appGrid');
  grid.innerHTML = '';
  $('#emptyState').classList.toggle('hidden', (state.apps || []).length > 0);

  for (const app of list) {
    const card = document.createElement('div');
    card.className = 'card';
    const iconPath = app.iconPng || app.iconPath;
    const iconHtml = iconPath
      ? `<img src="file:///${iconPath.replace(/\\/g, '/')}?t=${encodeURIComponent(app.installedAt || '')}" alt="" />`
      : '<div class="fallback-ico">▶</div>';
    const orientBadge = app.preferLandscape ? '<span class="tag">Landscape</span>' : '';
    const splitBadge = (app.bundleKind && app.bundleKind !== 'apk')
      ? `<span class="tag">${escapeHtml(app.bundleKind.toUpperCase())}</span>`
      : '';

    card.innerHTML = `
      <div class="card-top">
        <div class="app-ico">${iconHtml}</div>
        <div class="app-meta">
          <div class="app-name" title="${escapeHtml(app.label)}">${escapeHtml(app.label)} ${orientBadge} ${splitBadge}</div>
          <div class="app-pkg" title="${escapeHtml(app.package)}">${escapeHtml(app.package)}</div>
          <div class="app-ver">v${escapeHtml(app.versionName || '1.0')}${app.abis && app.abis.length ? ' · ' + escapeHtml(app.abis.join(', ')) : ''}</div>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn primary sm act-run">▶ Launch</button>
        <button class="btn ghost sm act-shortcut" title="Create or reveal Desktop shortcut">Shortcut</button>
        <button class="btn ghost sm act-stop" title="Force-stop running app">Stop</button>
        <button class="btn ghost sm danger act-del" title="Uninstall app">Uninstall</button>
      </div>
    `;
    card.querySelector('.act-run').addEventListener('click', () => api.launchApp(app.package));
    card.querySelector('.act-shortcut').addEventListener('click', async () => {
      const r = await api.createShortcut(app.package);
      if (r && r.ok) {
        const warn = r.warnings && r.warnings.length ? ` (${r.warnings.join('; ')})` : '';
        setBanner({ message: `Shortcut created: ${r.path}${warn}`, done: true });
      } else {
        setBanner({ message: `Failed to create shortcut: ${(r && r.error) || 'Unknown error'}`, error: true });
      }
    });
    card.querySelector('.act-stop').addEventListener('click', async () => {
      await api.stopApp(app.package);
      setBanner({ message: `Stopped ${app.label}`, done: true });
    });
    card.querySelector('.act-del').addEventListener('click', async () => {
      if (!confirm(`Uninstall "${app.label}" and remove its desktop shortcut?`)) return;
      const r = await api.uninstallApp(app.package, true);
      state.apps = r.apps;
      renderApps();
      setBanner({ message: `Uninstalled ${app.label}`, done: true });
    });
    grid.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function refresh() {
  state = await api.getState();
  $('#verText').textContent = state.version ? `v${state.version}` : '';
  renderRuntime();
  renderDisplaySeg();
  renderApps();
  renderProvisionBox();
}

async function pickAndInstall() {
  const p = await api.pickApk();
  if (p) await api.installApk(p);
}

async function setDisplayMode(mode) {
  state.settings.display = { ...(state.settings.display || {}), mode };
  renderDisplaySeg();
  await api.displaySet({ mode });
  setBanner({
    message: mode === 'fullscreen' ? 'Switched to Fullscreen mode' : 'Switched to Windowed mode',
    done: true,
  });
}

// ---------------------------------------------------------------------------
// Settings Dialog
// ---------------------------------------------------------------------------
function openSettings(initialTab) {
  const s = state.settings;
  const e = s.engine || {};
  const d = s.display || {};
  const r = s.runtime || {};

  $('#setEngineMode').value = e.mode || 'builtin';
  $('#setResourceMode').value = e.resourceMode || 'balanced';
  $('#setRenderSize').value = e.renderSize || 'auto';
  $('#setMem').value = e.memoryMB || 0;
  $('#setCores').value = e.cores || 0;
  $('#setDataGB').value = e.dataPartitionGB || 0;
  $('#setFastDns').checked = e.fastDns !== false;
  $('#setKeepSnap').checked = e.keepSnapshot !== false;
  $('#setLiteMode').checked = e.liteMode !== false;
  $('#setPriorityMode').value = e.priorityMode || 'balanced';
  $('#setDeepTrim').value = e.deepTrim ? 'on' : 'off';
  $('#setPrewarm').checked = e.prewarm !== false;
  $('#setAudio').checked = e.audio !== false;
  $('#setIdleShutdown').value = String(Number(e.idleShutdownMinutes) || 0);
  $('#setMouseRightBack').checked = e.mouseRightBack !== false;
  $('#setMouseWheelMode').value = e.mouseWheelMode || 'smooth';
  $('#setMouseSide').value = e.mouseSideButtons ? 'on' : 'off';
  $('#setFreeform').checked = Boolean(e.freeformWindows);
  $('#setAutoDeploy').checked = Boolean(s.autoDeploy);
  $('#setPackUrl').value = r.runtimePackUrl || '';
  $('#setSourcePref').value = r.sourcePreference || 'auto';
  $('#setDlConn').value = String(r.downloadConnections || 8);
  $('#setCompatImg').checked = r.compatImage !== false;
  $('#setAutoMirror').checked = r.autoMirror !== false;
  $('#setMirrorPrefix').value = r.mirrorPrefix || '';
  $('#setGiteeToken').value = r.giteeToken || '';
  $('#setAdb').value = s.adbPath || '';
  $('#setDevice').value = s.device || '';

  $('#setDispMode').value = d.mode || 'window';
  $('#setPortrait').value = d.portrait || '540x960';
  $('#setDensity').value = d.density || 0;
  $('#setLandscape').checked = Boolean(d.landscape);

  $('#setSharedDir').value = s.sharedDir || '';
  $('#setAutoStart').checked = Boolean(s.autoStart);
  $('#setShortcut').checked = Boolean(s.createShortcutOnInstall);
  $('#setStartMenu').checked = Boolean(s.createStartMenuShortcut);
  $('#setShortcutDir').value = s.shortcutDir || '';

  $('#dataDirNote').textContent = `Data directory: ${state.dataDir}`;
  const vLbl = $('#curVerLabel');
  if (vLbl) vLbl.textContent = `v${state.version || ''}`;
  renderProvisionBox();
  toggleAttachGroup();
  populateAndroidAppPicker();
  if (initialTab) switchTab(initialTab);
  $('#settingsDialog').showModal();
}

function populateAndroidAppPicker() {
  const sel = $('#andAppPick');
  if (!sel) return;
  const apps = state.apps || [];
  sel.innerHTML = apps.length
    ? apps.map((a) => `<option value="${escapeHtml(a.package)}">${escapeHtml(a.label)} (${escapeHtml(a.package)})</option>`).join('')
    : '<option value="">(No Android apps installed yet)</option>';
}

async function loadAndroidStatus() {
  const hint = $('#andHint');
  if (!hint) return;
  hint.textContent = 'Reading Android guest settings (starts engine automatically if needed)...';
  const r = await api.androidStatus();
  if (!r || !r.ok) {
    hint.textContent = `Unable to query Android guest: ${(r && r.error) || 'Engine not ready'}`;
    return;
  }
  $('#andWifi').checked = Boolean(r.wifi);
  $('#andAir').checked = Boolean(r.airplane);
  $('#andNoAnim').checked = Boolean(r.animationsOff);
  if (Number.isFinite(r.volume)) {
    $('#andVol').value = r.volume;
    $('#andVolVal').textContent = r.volume;
  }
  const f = [0.85, 1, 1.15, 1.3].reduce((a, b) => (Math.abs(b - r.fontScale) < Math.abs(a - r.fontScale) ? b : a), 1);
  $('#andFont').value = String(f);
  hint.textContent = `Connected · Android SDK ${r.sdk || '?'} · DPI ${r.density || 'Auto'}`;
}

function switchTab(name) {
  document.querySelectorAll('#settingsTabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab-pane').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.pane !== name);
  });
  if (name === 'doctor') runDoctor();
  if (name === 'android') loadAndroidStatus();
}

async function runDoctor() {
  const box = $('#doctorList');
  if (!box) return;
  box.innerHTML = '<div class="hint">Checking hardware virtualization &amp; runtime environment...</div>';
  const rep = await api.doctorCheck();
  renderDoctorItems(rep.items);
  refreshLayers();
}

function renderDoctorItems(items) {
  const box = $('#doctorList');
  if (!box) return;
  const icon = { ok: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' };
  box.innerHTML = (items || []).map((it) => `
    <div class="doc-item doc-${it.level}">
      <div class="doc-head">${icon[it.level] || '•'} <b>${escapeHtml(it.title)}</b></div>
      <div class="doc-detail">${escapeHtml(it.detail || '')}</div>
      ${it.fix ? `<div class="doc-fix">💡 ${escapeHtml(it.fix)}</div>` : ''}
    </div>
  `).join('');
}

async function runSelfCheck() {
  const box = $('#doctorList');
  if (box) box.innerHTML = '<div class="hint">Running comprehensive health self-check...</div>';
  const r = await api.doctorSelfCheck();
  renderDoctorItems(r.checks || []);
  setBanner({
    message: r.ok
      ? `All health checks passed (${r.elapsedMs} ms)`
      : 'Items requiring attention found — review details in Diagnostics',
    done: r.ok,
    error: !r.ok,
  });
}

const fmtMB = (n) => `${((n || 0) / 1048576).toFixed(1)} MB`;

async function refreshLayers() {
  const box = $('#layerBox');
  if (!box) return;
  const s = await api.layersAnalyze();
  if (!s.totalBytes) {
    box.textContent = 'Built-in Android runtime not installed yet — nothing to slim.';
    return;
  }
  const cats = s.categories.map((c) => `${escapeHtml(c.label)} ${fmtMB(c.bytes)}`).join(' · ');
  box.innerHTML = `
    <div><b>Runtime footprint:</b> ${fmtMB(s.totalBytes)} · <b>Safely reclaimable:</b> ${fmtMB(s.reclaimableBytes)} (${s.pruneCount} item(s))</div>
    ${cats ? `<div class="prov-dir">${cats}</div>` : '<div class="prov-dir">Already slim — no redundant SDK symbols or caches found.</div>'}
  `;
}

function toggleAttachGroup() {
  const mode = $('#setEngineMode').value;
  $('#attachGroup').style.opacity = mode === 'attach' ? '1' : '0.45';
}

function collectSettingsPatch() {
  return {
    adbPath: $('#setAdb').value.trim(),
    device: $('#setDevice').value.trim(),
    engine: {
      mode: $('#setEngineMode').value,
      resourceMode: $('#setResourceMode').value,
      renderSize: $('#setRenderSize').value,
      memoryMB: Number($('#setMem').value) || 0,
      cores: Number($('#setCores').value) || 0,
      dataPartitionGB: Number($('#setDataGB').value) || 0,
      fastDns: $('#setFastDns').checked,
      keepSnapshot: $('#setKeepSnap').checked,
      liteMode: $('#setLiteMode').checked,
      priorityMode: $('#setPriorityMode').value,
      deepTrim: $('#setDeepTrim').value === 'on',
      prewarm: $('#setPrewarm').checked,
      audio: $('#setAudio').checked,
      idleShutdownMinutes: Number($('#setIdleShutdown').value) || 0,
      mouseRightBack: $('#setMouseRightBack').checked,
      mouseWheelMode: $('#setMouseWheelMode').value,
      mouseSideButtons: $('#setMouseSide').value === 'on',
      freeformWindows: $('#setFreeform').checked,
    },
    display: {
      mode: $('#setDispMode').value,
      portrait: $('#setPortrait').value,
      density: Number($('#setDensity').value) || 0,
      landscape: $('#setLandscape').checked,
    },
    runtime: {
      runtimePackUrl: $('#setPackUrl').value.trim(),
      sourcePreference: $('#setSourcePref').value,
      downloadConnections: Number($('#setDlConn').value) || 8,
      compatImage: $('#setCompatImg').checked,
      autoMirror: $('#setAutoMirror').checked,
      mirrorPrefix: $('#setMirrorPrefix').value.trim(),
      giteeToken: $('#setGiteeToken').value.trim(),
    },
    autoDeploy: $('#setAutoDeploy').checked,
    autoStart: $('#setAutoStart').checked,
    createShortcutOnInstall: $('#setShortcut').checked,
    createStartMenuShortcut: $('#setStartMenu').checked,
    shortcutDir: $('#setShortcutDir').value.trim(),
    sharedDir: $('#setSharedDir').value.trim(),
  };
}

// ---------------------------------------------------------------------------
// Event Wiring
// ---------------------------------------------------------------------------
function bindEvents() {
  $('#btnInstall').addEventListener('click', pickAndInstall);
  $('#btnShare').addEventListener('click', () => api.shareOpenLocal());
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#btnCloseSettings').addEventListener('click', () => $('#settingsDialog').close());
  $('#btnCancelSettings').addEventListener('click', () => $('#settingsDialog').close());

  $('#settingsTabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });
  $('#setEngineMode').addEventListener('change', toggleAttachGroup);

  $('#dispSeg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-mode]');
    if (b) setDisplayMode(b.dataset.mode);
  });

  $('#rtPill').addEventListener('click', async () => {
    if ((state.settings.engine || {}).mode === 'builtin' && !(state.provision || {}).installed) {
      await api.provisionDeploy();
      await refresh();
      return;
    }
    setBanner({ message: 'Starting Android engine...', busy: true });
    const r = await api.ensureRuntime();
    await refresh();
    setBanner(r.ok
      ? { message: `Android engine ready (${r.serial})`, done: true }
      : { message: r.error || 'Failed to start Android engine', error: true });
  });

  $('#btnStopEngine').addEventListener('click', async () => {
    await api.stopRuntime();
    await refresh();
    setBanner({ message: 'Android engine stopped', done: true });
  });

  $('#btnDeployNow').addEventListener('click', async () => {
    await api.provisionDeploy();
    await refresh();
  });
  $('#btnCancelDeploy').addEventListener('click', () => api.provisionCancel());

  const importIsoFlow = async () => {
    const p = await api.pickIso();
    if (!p) return;
    await api.importIso(p);
    await refresh();
  };
  $('#btnImportIso').addEventListener('click', importIsoFlow);
  $('#btnPickIso').addEventListener('click', importIsoFlow);
  $('#btnRedploy').addEventListener('click', async () => {
    await api.saveSettings(collectSettingsPatch());
    $('#settingsDialog').close();
    await api.provisionDeploy();
    await refresh();
  });
  $('#btnProbeSrc').addEventListener('click', async () => {
    const box = $('#probeBox');
    box.classList.remove('hidden');
    box.textContent = 'Benchmarking download mirrors (ADB / Emulator / Android System Image)...';
    await api.saveSettings(collectSettingsPatch());
    const rows = await api.sourcesProbe();
    if (!Array.isArray(rows)) {
      box.innerHTML = Object.entries(rows || {}).map(([name, value]) => (
        `<div class="probe-row"><span>${escapeHtml(name)}</span><span>${escapeHtml(value)}</span></div>`
      )).join('') || 'No source probe results are available.';
      return;
    }
    box.innerHTML = rows.map((g) => {
      const items = (g.list || []).map((c) => {
        const tag = c.ok
          ? `✅ ${c.latencyMs || 0}ms · ${((c.speedBps || 0) / 1024).toFixed(0)} KB/s`
          : `❌ ${escapeHtml(c.error || 'Unreachable')}`;
        return `<div class="probe-row"><span>${escapeHtml(c.name)}</span><span>${tag}</span></div>`;
      }).join('');
      return `<div class="probe-grp"><b>${escapeHtml(g.label)}</b>${items}</div>`;
    }).join('');
  });
  $('#btnRunDoctor').addEventListener('click', runDoctor);
  $('#btnSelfCheck').addEventListener('click', runSelfCheck);
  $('#btnClearLocks').addEventListener('click', async () => {
    const r = await api.clearLocks();
    if (!r.ok) { setBanner({ message: r.error, error: true }); return; }
    setBanner({ message: `Cleared ${r.cleared} stale lock file(s)`, done: true });
    runDoctor();
  });
  $('#btnExportDiag').addEventListener('click', async () => {
    const r = await api.doctorExport();
    if (r && r.ok) setBanner({ message: `Diagnostic report saved to Desktop: ${r.path}`, done: true });
  });
  $('#btnOpenLogs').addEventListener('click', () => api.openDataDir());
  $('#btnAnalyzeLayers').addEventListener('click', refreshLayers);
  $('#btnPruneLayers').addEventListener('click', async () => {
    const r = await api.layersPrune();
    if (!r.ok) { setBanner({ message: r.error, error: true }); return; }
    await refreshLayers();
    setBanner({ message: `Reclaimed ${fmtMB(r.freedBytes)} (${r.removed.length} item(s) removed)`, done: true });
  });
  $('#btnResetRuntime').addEventListener('click', async () => {
    if (!confirm('Reset the built-in Android runtime and remove downloaded runtime components?')) return;
    await api.provisionReset();
    await refresh();
  });

  // Quickbar actions
  $('#btnSendFile').addEventListener('click', async () => {
    const r = await api.sharePushFile();
    if (r && r.ok) setBanner({ message: `Sent ${r.sent.length} file(s) to Android Shared Folder`, done: true });
  });
  $('#btnSyncShare').addEventListener('click', async () => {
    setBanner({ message: 'Syncing shared folder...', busy: true });
    await api.shareSyncNow();
    setBanner({ message: 'Shared folder synchronized', done: true });
  });
  const assocFlow = async () => {
    await api.registerAssociation();
    setBanner({ message: 'Associated .apk files — double-clicking any .apk now installs & runs with ApkStart', done: true });
  };
  $('#btnAssoc').addEventListener('click', assocFlow);
  $('#btnAssocIn').addEventListener('click', assocFlow);
  $('#btnUnassoc').addEventListener('click', async () => {
    await api.unregisterAssociation();
    setBanner({ message: 'Removed .apk file association', done: true });
  });

  const rebuildFlow = async () => {
    const n = await api.rebuildShortcuts();
    setBanner({ message: `Rebuilt shortcuts for ${n.length} installed app(s)`, done: true });
  };
  $('#btnRebuildShortcutsTop').addEventListener('click', rebuildFlow);
  $('#btnRebuildShortcuts').addEventListener('click', rebuildFlow);

  // Settings form helpers
  $('#btnBrowseAdb').addEventListener('click', async () => {
    const p = await api.pickAdb();
    if (p) $('#setAdb').value = p;
  });
  $('#btnBrowseShare').addEventListener('click', async () => {
    const p = await api.pickFolder();
    if (p) $('#setSharedDir').value = p;
  });
  $('#btnOpenShare').addEventListener('click', () => api.shareOpenLocal());
  $('#btnBrowseShortcutDir').addEventListener('click', async () => {
    const p = await api.pickFolder();
    if (p) $('#setShortcutDir').value = p;
  });
  $('#btnApplyDisplay').addEventListener('click', async () => {
    const patch = collectSettingsPatch().display;
    await api.displaySet(patch);
    await refresh();
    setBanner({ message: 'Display settings applied', done: true });
  });

  $('#btnSaveSettings').addEventListener('click', async () => {
    state.settings = await api.saveSettings(collectSettingsPatch());
    $('#settingsDialog').close();
    await refresh();
    setBanner({ message: 'Preferences saved', done: true });
  });

  $('#searchInput').addEventListener('input', renderApps);

  // Drag & drop (.apk / .apks / .xapk)
  const dz = $('#dropzone');
  $('#dzPick').addEventListener('click', (e) => { e.preventDefault(); pickAndInstall(); });
  dz.addEventListener('click', (e) => { if (e.target.id !== 'dzPick') pickAndInstall(); });

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => {
    stop(e); dz.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => {
    stop(e); dz.classList.remove('over');
  }));
  window.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])]
      .filter((f) => /\.(apk|apks|xapk)$/i.test(f.name) && f.path);
    if (!files.length) {
      setBanner({ message: 'Please drop an Android package (.apk, .apks, or .xapk)', error: true });
      return;
    }
    for (const f of files) await api.installApk(f.path);
  });

  // Android Guest System controls
  $('#btnAndRefresh').addEventListener('click', loadAndroidStatus);
  $('#andWifi').addEventListener('change', (e) => api.androidWifi(e.target.checked));
  $('#andAir').addEventListener('change', (e) => api.androidAirplane(e.target.checked));
  $('#andNoAnim').addEventListener('change', (e) => api.androidAnimations(!e.target.checked));
  $('#andVol').addEventListener('input', (e) => { $('#andVolVal').textContent = e.target.value; });
  $('#andVol').addEventListener('change', (e) => api.androidVolume(Number(e.target.value)));
  $('#andFont').addEventListener('change', (e) => api.androidFontScale(Number(e.target.value)));
  $('#btnAndTune').addEventListener('click', async () => {
    const pkg = $('#andAppPick').value || undefined;
    setBanner({ message: 'Applying Android guest smoothness optimizations...', busy: true });
    await api.androidTune(pkg);
    await loadAndroidStatus();
    setBanner({ message: 'Disabled guest animations, raised cache limit & whitelisted app from Doze', done: true });
  });
  document.querySelectorAll('.and-open').forEach((b) => {
    b.addEventListener('click', async () => {
      $('#settingsDialog').close();
      setBanner({ message: 'Opening Android System Settings...', busy: true });
      await api.androidOpen(b.dataset.act);
      setBanner({ message: 'Opened in App Window', done: true });
    });
  });
  $('#btnAndGrantAll').addEventListener('click', async () => {
    const pkg = $('#andAppPick').value;
    if (!pkg) return;
    const r = await api.androidGrantAll(pkg);
    setBanner({ message: `Granted ${r.granted || 0} runtime permission(s) to ${pkg}`, done: true });
  });
  $('#btnAndClearApp').addEventListener('click', async () => {
    const pkg = $('#andAppPick').value;
    if (!pkg) return;
    if (!confirm(`Clear all app data and sign-in state for "${pkg}"?`)) return;
    await api.clearAppData(pkg);
    setBanner({ message: `Cleared app data for ${pkg}`, done: true });
  });

  // Software Updater
  let pendingUpdateAsset = null;
  $('#btnCheckUpdate').addEventListener('click', async () => {
    const box = $('#updateBox');
    const applyBtn = $('#btnApplyUpdate');
    applyBtn.classList.add('hidden');
    box.textContent = 'Checking release channels for updates...';
    const r = await api.updateCheck();
    if (!r || !r.ok) {
      box.textContent = `Update check failed: ${(r && r.error) || 'Network unavailable'}`;
      return;
    }
    if (!r.hasUpdate) {
      box.innerHTML = `✅ You are running the latest version <b>v${escapeHtml(r.current)}</b> (via ${escapeHtml(r.source)})`;
      return;
    }
    pendingUpdateAsset = r.preferredAsset;
    const sizeTxt = pendingUpdateAsset && pendingUpdateAsset.size
      ? ` (${(pendingUpdateAsset.size / 1048576).toFixed(1)} MB)`
      : '';
    box.innerHTML = `
      <div>🎉 New release available: <b>v${escapeHtml(r.latest)}</b> (Current: v${escapeHtml(r.current)} · Source: ${escapeHtml(r.source)})${sizeTxt}</div>
      <div class="prov-dir" style="white-space:pre-line;max-height:90px;overflow:auto">${escapeHtml((r.notes || '').slice(0, 500))}</div>
    `;
    if (pendingUpdateAsset) applyBtn.classList.remove('hidden');
  });
  $('#btnApplyUpdate').addEventListener('click', async () => {
    if (!pendingUpdateAsset) return;
    if (!confirm('ApkStart will download the update, close running Android apps, and restart automatically. Installed apps and user data are preserved. Continue?')) return;
    $('#settingsDialog').close();
    await api.updateApply(pendingUpdateAsset);
  });

  // Leftovers & Clean Uninstall
  let foundLeftovers = [];
  $('#btnScanLeftovers').addEventListener('click', async () => {
    const box = $('#leftoversBox');
    const cleanBtn = $('#btnCleanLeftovers');
    box.textContent = 'Scanning for legacy leftovers...';
    const r = await api.leftoversScan();
    foundLeftovers = r.items || [];
    if (!foundLeftovers.length) {
      cleanBtn.classList.add('hidden');
      box.textContent = '✅ Clean — no orphaned directories, snapshots, or registry entries found.';
      return;
    }
    cleanBtn.classList.remove('hidden');
    const rows = foundLeftovers.map((it) => `<div>• [${escapeHtml(it.kind)}] ${escapeHtml(it.path)} <span class="prov-dir">(${escapeHtml(it.note)}${it.size ? ' · ' + fmtMB(it.size) : ''})</span></div>`).join('');
    box.innerHTML = `<div>Found <b>${foundLeftovers.length}</b> leftover item(s) totaling <b>${fmtMB(r.totalBytes)}</b>:</div>${rows}`;
  });
  $('#btnCleanLeftovers').addEventListener('click', async () => {
    if (!foundLeftovers.length) return;
    if (!confirm(`Permanently remove ${foundLeftovers.length} leftover item(s)? Your current ApkStart version and app data will NOT be touched.`)) return;
    const r = await api.leftoversClean(foundLeftovers);
    $('#btnCleanLeftovers').classList.add('hidden');
    const failTxt = r.failed && r.failed.length ? `; ${r.failed.length} item(s) could not be deleted (possibly locked)` : '';
    $('#leftoversBox').textContent = `Cleaned ${r.removed.length} item(s), freed ${fmtMB(r.freedBytes)}${failTxt}`;
    foundLeftovers = [];
  });
  $('#btnRemoveSelf').addEventListener('click', async () => {
    const wipe = confirm(
      'Uninstall ApkStart from this PC?\n\nClick "OK" to also delete downloaded Android runtime & installed app data (%APPDATA%\\apkstart).\nClick "Cancel" to abort.',
    );
    if (!wipe) return;
    const r = await api.removeSelf({ wipeData: true });
    if (r && !r.ok) setBanner({ message: r.error, error: true });
  });

  api.onProgress((info) => setBanner(info));
  api.onStateChange(() => refresh());
  api.onDeployAsk(() => {
    $('#deployCard').classList.remove('hidden');
  });

  bindWelcome();
}

const DOUYIN_URL = 'https://v.douyin.com/9TIIxVCANig/';

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function openWelcome(manual = false) {
  const dlg = $('#welcomeDialog');
  if (!dlg) return;
  const w = (state.settings && state.settings.welcome) || {};
  $('#chkWelcomeDisable').checked = Boolean(w.disabled);
  if (!dlg.open) dlg.showModal();
  if (!manual) {
    const next = { welcome: { ...w, lastDate: todayKey() } };
    api.saveSettings(next).then((s) => { state.settings = s; }).catch(() => {});
  }
}

async function closeWelcome() {
  const dlg = $('#welcomeDialog');
  if (dlg && dlg.open) dlg.close();
  const disabled = Boolean($('#chkWelcomeDisable').checked);
  const w = (state.settings && state.settings.welcome) || {};
  if (Boolean(w.disabled) !== disabled) {
    state.settings = await api.saveSettings({ welcome: { ...w, disabled, lastDate: todayKey() } });
  }
}

function maybeShowDailyWelcome() {
  const w = (state.settings && state.settings.welcome) || {};
  if (w.disabled) return;
  if (w.lastDate === todayKey()) return;
  openWelcome(false);
}

function bindWelcome() {
  const dlg = $('#welcomeDialog');
  if (!dlg) return;
  $('#btnWelcomeClose').addEventListener('click', closeWelcome);
  $('#btnWelcomeOk').addEventListener('click', closeWelcome);
  $('#btnWelcomeLink').addEventListener('click', (e) => api.openExternal(e.currentTarget.dataset.url || DOUYIN_URL));
  $('#btnCommunity').addEventListener('click', () => openWelcome(true));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeWelcome(); });
}

bindEvents();
refresh().then(() => maybeShowDailyWelcome());
