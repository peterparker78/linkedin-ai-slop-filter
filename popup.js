const DEFAULTS = {
  enabled: true,
  highThreshold: 55,
  lowThreshold: 25,
  model: 'qwen2.5:3b',
  claudeApiKey: '',
  hideAds: true,
};

const $ = (id) => document.getElementById(id);

chrome.storage.local.get(DEFAULTS, (settings) => {
  $('enabled').checked = settings.enabled;
  $('hideAds').checked = settings.hideAds;
  $('highThreshold').value = settings.highThreshold;
  $('lowThreshold').value = settings.lowThreshold;
  $('claudeApiKey').value = settings.claudeApiKey;

  chrome.runtime.sendMessage({ type: 'ollamaStatus' }, (status) => {
    const dot = $('ollamaDot');
    const text = $('ollamaText');
    const modelSelect = $('model');
    if (status && status.running) {
      dot.className = 'dot on';
      text.textContent = 'running';
      const models = status.models.length ? status.models : [settings.model];
      for (const name of models) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        modelSelect.append(opt);
      }
      if (!models.includes(settings.model)) {
        const opt = document.createElement('option');
        opt.value = settings.model;
        opt.textContent = `${settings.model} (not pulled)`;
        modelSelect.append(opt);
      }
      modelSelect.value = settings.model;
    } else {
      dot.className = 'dot off';
      text.textContent = 'not running';
      const opt = document.createElement('option');
      opt.value = settings.model;
      opt.textContent = settings.model;
      modelSelect.append(opt);
      modelSelect.value = settings.model;
    }
  });
});

chrome.storage.session.get({ hiddenCount: 0 }, ({ hiddenCount }) => {
  $('hiddenCount').textContent = hiddenCount;
});

$('enabled').addEventListener('change', (e) => {
  chrome.storage.local.set({ enabled: e.target.checked });
});

$('hideAds').addEventListener('change', (e) => {
  chrome.storage.local.set({ hideAds: e.target.checked });
});

function setHiddenItemsCount(n) {
  $('resetHidden').textContent = `Show hidden items (${n})`;
  $('resetHidden').disabled = n === 0;
}

chrome.storage.local.get({ hiddenItems: [] }, ({ hiddenItems }) => {
  setHiddenItemsCount(hiddenItems.length);
});

$('pick').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { type: 'pickMode' }, () => {
    if (chrome.runtime.lastError) {
      // Not a LinkedIn tab, or the tab predates an extension reload.
      $('pickNote').textContent = 'Refresh the LinkedIn tab, then retry';
      return;
    }
    window.close();
  });
});

$('resetHidden').addEventListener('click', () => {
  chrome.storage.local.set({ hiddenItems: [] });
  setHiddenItemsCount(0);
});

$('model').addEventListener('change', (e) => {
  chrome.storage.local.set({ model: e.target.value });
});

$('claudeApiKey').addEventListener('change', (e) => {
  chrome.storage.local.set({ claudeApiKey: e.target.value.trim() });
});

for (const id of ['highThreshold', 'lowThreshold']) {
  $(id).addEventListener('change', (e) => {
    const value = Number(e.target.value);
    if (Number.isFinite(value)) chrome.storage.local.set({ [id]: value });
  });
}
