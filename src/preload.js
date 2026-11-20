'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apkstart', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  pickApk: () => ipcRenderer.invoke('dialog:pickApk'),
  pickAdb: () => ipcRenderer.invoke('dialog:pickAdb'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickIso: () => ipcRenderer.invoke('dialog:pickIso'),

  installApk: (apkPath) => ipcRenderer.invoke('apk:install', apkPath),
  inspectApk: (apkPath) => ipcRenderer.invoke('apk:inspect', apkPath),
  launchApp: (pkg) => ipcRenderer.invoke('app:launch', pkg),
  stopApp: (pkg) => ipcRenderer.invoke('app:stop', pkg),
  uninstallApp: (pkg, fromDevice) => ipcRenderer.invoke('app:uninstall', pkg, fromDevice),
  createShortcut: (pkg) => ipcRenderer.invoke('app:shortcut', pkg),
  rebuildShortcuts: () => ipcRenderer.invoke('app:rebuildShortcuts'),
  clearAppData: (pkg) => ipcRenderer.invoke('app:clearData', pkg),

  ensureRuntime: () => ipcRenderer.invoke('runtime:ensure'),
  stopRuntime: () => ipcRenderer.invoke('runtime:stop'),
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  provisionStatus: () => ipcRenderer.invoke('provision:status'),
  provisionDeploy: () => ipcRenderer.invoke('provision:deploy'),
  provisionCancel: () => ipcRenderer.invoke('provision:cancel'),
  provisionReset: () => ipcRenderer.invoke('provision:reset'),
  importIso: (p) => ipcRenderer.invoke('provision:importIso', p),
  sourcesProbe: () => ipcRenderer.invoke('sources:probe'),
  layersAnalyze: () => ipcRenderer.invoke('layers:analyze'),
  layersPrune: () => ipcRenderer.invoke('layers:prune'),
  layersVerify: () => ipcRenderer.invoke('layers:verify'),

  doctorCheck: () => ipcRenderer.invoke('doctor:check'),
  doctorExport: () => ipcRenderer.invoke('doctor:export'),
  doctorSelfCheck: () => ipcRenderer.invoke('doctor:selfCheck'),
  clearLocks: () => ipcRenderer.invoke('app:clearLocks'),

  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: (asset) => ipcRenderer.invoke('update:apply', asset),
  updateCancel: () => ipcRenderer.invoke('update:cancel'),

  leftoversScan: () => ipcRenderer.invoke('leftovers:scan'),
  leftoversClean: (items) => ipcRenderer.invoke('leftovers:clean', items),
  removeSelf: (opts) => ipcRenderer.invoke('app:removeSelf', opts),

  androidStatus: () => ipcRenderer.invoke('android:status'),
  androidWifi: (on) => ipcRenderer.invoke('android:wifi', on),
  androidAirplane: (on) => ipcRenderer.invoke('android:airplane', on),
  androidVolume: (v) => ipcRenderer.invoke('android:volume', v),
  androidAnimations: (on) => ipcRenderer.invoke('android:animations', on),
  androidFontScale: (s) => ipcRenderer.invoke('android:fontScale', s),
  androidDensity: (d) => ipcRenderer.invoke('android:density', d),
  androidTune: (pkg) => ipcRenderer.invoke('android:tune', pkg),
  androidOpen: (a) => ipcRenderer.invoke('android:open', a),
  androidPermissions: (pkg) => ipcRenderer.invoke('android:permissions', pkg),
  androidGrantAll: (pkg) => ipcRenderer.invoke('android:grantAll', pkg),

  displaySet: (patch) => ipcRenderer.invoke('display:set', patch),
  displayFullscreen: () => ipcRenderer.invoke('display:fullscreen'),
  displayWindow: () => ipcRenderer.invoke('display:window'),

  shellReady: () => ipcRenderer.invoke('shell:ready'),
  shellRotate: () => ipcRenderer.invoke('shell:rotate'),
  shellMin: () => ipcRenderer.invoke('shell:min'),
  shellMax: () => ipcRenderer.invoke('shell:max'),
  shellClose: () => ipcRenderer.invoke('shell:close'),
  onShellState: (fn) => {
    const h = (_e, d) => fn(d);
    ipcRenderer.on('shell:state', h);
    return () => ipcRenderer.removeListener('shell:state', h);
  },

  shareOpenLocal: () => ipcRenderer.invoke('share:openLocal'),
  shareSyncNow: () => ipcRenderer.invoke('share:syncNow'),
  sharePushFile: () => ipcRenderer.invoke('share:pushFile'),

  registerAssociation: () => ipcRenderer.invoke('assoc:register'),
  unregisterAssociation: () => ipcRenderer.invoke('assoc:unregister'),
  openDataDir: () => ipcRenderer.invoke('app:openData'),
  openExternal: (url) => ipcRenderer.invoke('shell:external', url),
  openPath: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath),

  onProgress: (fn) => {
    const h = (_e, d) => fn(d);
    ipcRenderer.on('progress', h);
    return () => ipcRenderer.removeListener('progress', h);
  },
  onStateChange: (fn) => {
    const h = (_e, d) => fn(d);
    ipcRenderer.on('state:changed', h);
    return () => ipcRenderer.removeListener('state:changed', h);
  },
  onDeployAsk: (fn) => {
    const h = (_e, d) => fn(d);
    ipcRenderer.on('deploy:ask', h);
    return () => ipcRenderer.removeListener('deploy:ask', h);
  },
});
