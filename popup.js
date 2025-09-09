// popup.js — manages preset templates and status display
(() => {
  "use strict";

  // ----- helpers -----
  const $ = (id) => document.getElementById(id);
  const storage = chrome.storage.local;
  const getPresets = () => new Promise((resolve) => storage.get({ presets: {} }, resolve));
  const setPresets = (presets) => new Promise((resolve) => storage.set({ presets }, resolve));

  const presetSelect = $("presets");
  const nameInput = $("presetNameNew");
  const saveBtn = $("saveNewBtn");
  const updateBtn = $("updateBtn");
  const fillBtn = $("fillBtn");
  const delBtn = $("delBtn");

  // ----- status wiring -----
  const statusText = $("statusText");
  const statusBadge = $("statusBadge");

  function setStatus(ok) {
    if (ok) {
      statusText.textContent = 'זוהה טופס PDF';
      statusBadge.textContent = '✅';
    } else {
      statusText.textContent = 'לא זוהה PDF בדף';
      statusBadge.textContent = '❌';
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "PDF_DETECTED") setStatus(!!msg.present);
  });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'PING_PDF_STATUS' }, (resp) => {
      if (resp && 'present' in resp) setStatus(!!resp.present);
    });
  });

  // ----- preset helpers -----
  async function collectSnapshot() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return resolve(null);
        chrome.tabs.sendMessage(tabs[0].id, { cmd: 'COLLECT_SNAPSHOT' }, (resp) => {
          resolve(resp && resp.ok ? resp.snapshot.fields || [] : null);
        });
      });
    });
  }

  async function loadPresets() {
    const { presets } = await getPresets();
    presetSelect.innerHTML = '';
    Object.keys(presets).forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      presetSelect.appendChild(opt);
    });
    const has = presetSelect.options.length > 0;
    presetSelect.disabled = !has;
    updateBtn.disabled = !has;
    fillBtn.disabled = !has;
    delBtn.style.display = has ? 'inline-block' : 'none';
  }

  // ----- actions -----
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const fields = await collectSnapshot();
    if (!fields) return;
    const { presets } = await getPresets();
    presets[name] = fields;
    await setPresets(presets);
    await loadPresets();
    presetSelect.value = name;
    nameInput.value = '';
  });

  updateBtn.addEventListener('click', async () => {
    const name = presetSelect.value;
    if (!name) return;
    const fields = await collectSnapshot();
    if (!fields) return;
    const { presets } = await getPresets();
    presets[name] = fields;
    await setPresets(presets);
  });

  fillBtn.addEventListener('click', async () => {
    const name = presetSelect.value;
    if (!name) return;
    const { presets } = await getPresets();
    const fields = presets[name];
    if (!fields) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { cmd: 'APPLY_PRESET', entries: fields });
    });
  });

  delBtn.addEventListener('click', async () => {
    const name = presetSelect.value;
    if (!name) return;
    const { presets } = await getPresets();
    delete presets[name];
    await setPresets(presets);
    await loadPresets();
  });

  presetSelect.addEventListener('change', () => {
    delBtn.style.display = presetSelect.value ? 'inline-block' : 'none';
  });

  loadPresets();
})();
