'use strict';
(() => {
  const titleEl = document.getElementById('title');
  const iconEl = document.getElementById('appIcon');
  const bootIconEl = document.getElementById('bootIcon');
  const bootNameEl = document.getElementById('bootName');
  const tipEl = document.getElementById('tip');
  const bootEl = document.getElementById('boot');
  const btnRotate = document.getElementById('btnRotate');
  const orientText = document.getElementById('orientText');

  function applyState(s) {
    if (!s) return;
    if (s.label) {
      titleEl.textContent = s.label;
      bootNameEl.textContent = s.label;
      document.title = s.label;
    }
    if (s.iconUrl) {
      iconEl.src = s.iconUrl;
      iconEl.style.display = 'block';
      bootIconEl.src = s.iconUrl;
    }
    if ('tip' in s && s.tip) tipEl.textContent = s.tip;
    if ('ready' in s) {
      if (s.ready) bootEl.classList.add('hide');
      else bootEl.classList.remove('hide');
    }
    if ('landscape' in s) {
      btnRotate.classList.toggle('on', Boolean(s.landscape));
      orientText.textContent = s.landscape ? 'Portrait' : 'Landscape';
    }
  }

  btnRotate.addEventListener('click', () => window.apkstart.shellRotate());
  document.getElementById('btnMin').addEventListener('click', () => window.apkstart.shellMin());
  document.getElementById('btnMax').addEventListener('click', () => window.apkstart.shellMax());
  document.getElementById('btnClose').addEventListener('click', () => window.apkstart.shellClose());

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      window.apkstart.shellRotate();
    }
  });

  window.apkstart.onShellState(applyState);
  window.apkstart.shellReady().then(applyState);
})();
