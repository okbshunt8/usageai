function updateTime() {
  const now = new Date();
  document.getElementById('updatedAt').textContent = now.toLocaleTimeString('ja-JP', {
    hour: '2-digit', minute: '2-digit'
  });
}

// Dynamic bar color: green (low usage) → yellow (medium) → red (high usage)
function applyBarColor(progressEl, trackEl, percent) {
  // Remove any existing color classes
  progressEl.className = 'progress-fill';
  trackEl.className = 'progress-track';
  if (percent >= 80) {
    progressEl.classList.add('bar-red');
    trackEl.classList.add('track-red');
  } else if (percent >= 50) {
    progressEl.classList.add('bar-yellow');
    trackEl.classList.add('track-yellow');
  } else {
    progressEl.classList.add('bar-green');
    trackEl.classList.add('track-green');
  }
}

function localizeCodexLabel(label) {
  const l = String(label).toLowerCase();
  if (l.includes('month')) return '月間制限';
  if (l.includes('week')) return '週間制限';
  if (l.includes('hour') || l.includes('5h')) return '5時間制限';
  if (l.includes('daily') || l.includes('day')) return '日次制限';
  return label;
}

function applyCodexLimit(limit, prefix) {
  const localizedLabel = localizeCodexLabel(limit.label);
  document.getElementById(`codex${prefix}Percent`).textContent = `${limit.percent.toFixed(1)}%`;
  const progressEl = document.getElementById(`codex${prefix}Progress`);
  const trackEl = progressEl.parentElement;
  progressEl.style.width = `${limit.percent}%`;
  applyBarColor(progressEl, trackEl, limit.percent);
  document.getElementById(`codex${prefix}Reset`).textContent = limit.remaining || 'リセット時刻を確認';
  document.getElementById(`codex${prefix}Time`).textContent = ` · ${limit.resetAt}`;
  document.getElementById(`codex${prefix}Heading`).textContent = localizedLabel;
  document.getElementById(`codex${prefix}Label`).textContent = localizedLabel;
  const status = document.getElementById(`codex${prefix}Status`);
  status.classList.remove('over-limit');
  if (limit.percent >= 100) {
    status.classList.add('over-limit');
    status.textContent = '制限に到達';
  } else if (limit.percent >= 80) {
    status.textContent = '残りわずか';
  } else {
    status.textContent = '利用中';
  }
}

function setCodexSlot(prefix, { label, reset } = {}) {
  document.getElementById(`codex${prefix}Heading`).textContent = label || '利用枠';
  document.getElementById(`codex${prefix}Percent`).textContent = '—%';
  document.getElementById(`codex${prefix}Progress`).style.width = '0%';
  document.getElementById(`codex${prefix}Reset`).textContent = reset || '取得中…';
  document.getElementById(`codex${prefix}Time`).textContent = '';
  document.getElementById(`codex${prefix}Status`).textContent = '確認中';
  if (label) document.getElementById(`codex${prefix}Label`).textContent = label;
}

function syncCodexLimitLayout(count) {
  const grid = document.getElementById('codexLimitGrid');
  const weeklyCard = document.getElementById('codexWeeklyCard');
  const showWeekly = count > 1;
  weeklyCard.hidden = !showWeekly;
  grid.classList.toggle('single-column', !showWeekly);
}

async function refreshCodexUsage() {
  const connectionText = document.getElementById('codexConnection').querySelector('span');
  connectionText.textContent = '取得中…';
  syncCodexLimitLayout(1);
  setCodexSlot('Session');
  setCodexSlot('Weekly');
  try {
    const usage = await window.usageApi.getCodexUsage();
    document.getElementById('codexPlan').textContent = usage.plan;
    syncCodexLimitLayout(Math.min(usage.limits.length, 2));
    const slots = ['Session', 'Weekly'];
    usage.limits.slice(0, 2).forEach((limit, i) => applyCodexLimit(limit, slots[i]));
    if (usage.limits.length > 1) {
      for (let i = usage.limits.length; i < slots.length; i += 1) {
        setCodexSlot(slots[i], { label: '—', reset: 'データなし' });
        document.getElementById(`codex${slots[i]}Status`).textContent = '—';
      }
    }
    connectionText.textContent = 'CLI 接続済み';
  } catch (error) {
    connectionText.textContent = '取得できません';
    syncCodexLimitLayout(1);
    setCodexSlot('Session', { reset: 'エラー' });
    setCodexSlot('Weekly', { reset: 'エラー' });
    document.getElementById('codexSessionStatus').textContent = '—';
    document.getElementById('codexWeeklyStatus').textContent = '—';
    console.error('codex:usage', error);
  }
}

function applyClaudeLimit(limit, prefix, statusId) {
  document.getElementById(`${prefix}Percent`).textContent = `${limit.percent.toFixed(1)}%`;
  const progressEl = document.getElementById(`${prefix}Progress`);
  const trackEl = progressEl.parentElement;
  progressEl.style.width = `${limit.percent}%`;
  applyBarColor(progressEl, trackEl, limit.percent);
  document.getElementById(`${prefix}Reset`).textContent = limit.remaining || 'リセット時刻を確認';
  document.getElementById(`${prefix}Time`).textContent = ` · ${limit.resetAt}`;
  const status = document.getElementById(statusId);
  status.classList.remove('over-limit');
  if (limit.percent >= 100) {
    status.classList.add('over-limit');
    status.textContent = '制限に到達';
  } else if (limit.percent >= 80) {
    status.textContent = '残りわずか';
  } else {
    status.textContent = '利用中';
  }
}

async function refreshClaudeUsage() {
  const connection = document.getElementById('claudeConnection');
  const connectionText = connection.querySelector('span');
  connection.classList.remove('is-error');
  connectionText.textContent = '取得中…';
  // Clear the static placeholder numbers so stale/dummy values are not mistaken
  // for real data while the async fetch is in flight.
  setClaudeLoading();
  try {
    const usage = await window.usageApi.getClaudeUsage();
    applyClaudeLimit(usage.session, 'session', 'claudeSessionStatus');
    applyClaudeLimit(usage.weekly, 'weekly', 'claudeWeeklyStatus');
    document.getElementById('claudePlan').textContent = usage.plan;
    connectionText.textContent = 'CLI 接続済み';
  } catch (error) {
    connection.classList.add('is-error');
    connectionText.textContent = '取得できません';
  }
}

function setClaudeLoading() {
  document.getElementById('claudePlan').textContent = '確認中';
  for (const prefix of ['session', 'weekly']) {
    document.getElementById(`${prefix}Percent`).textContent = '—%';
    document.getElementById(`${prefix}Progress`).style.width = '0%';
    document.getElementById(`${prefix}Reset`).textContent = '取得中…';
    document.getElementById(`${prefix}Time`).textContent = '';
  }
  document.getElementById('claudeSessionStatus').textContent = '確認中';
  document.getElementById('claudeWeeklyStatus').textContent = '確認中';
}

function setKiroLoading(reset) {
  document.getElementById('kiroPercent').textContent = '—%';
  document.getElementById('kiroProgress').style.width = '0%';
  document.getElementById('kiroReset').textContent = reset || '取得中…';
  document.getElementById('kiroTime').textContent = '';
  document.getElementById('kiroStatus').textContent = '確認中';
}

async function refreshKiroUsage() {
  const connectionText = document.getElementById('kiroConnection').querySelector('span');
  connectionText.textContent = '取得中…';
  setKiroLoading();
  try {
    const usage = await window.usageApi.getKiroUsage();
    document.getElementById('kiroPlan').textContent = usage.plan;
    document.getElementById('kiroPercent').textContent = `${usage.percent.toFixed(1)}%`;
    const kiroProgressEl = document.getElementById('kiroProgress');
    kiroProgressEl.style.width = `${usage.percent}%`;
    applyBarColor(kiroProgressEl, kiroProgressEl.parentElement, usage.percent);
    document.getElementById('kiroReset').textContent = usage.remaining || 'リセット時刻を確認';
    const detail = `${usage.used} / ${usage.limit}${usage.resetAt ? ` · ${usage.resetAt}` : ''}`;
    document.getElementById('kiroTime').textContent = ` · ${detail}`;
    const status = document.getElementById('kiroStatus');
    status.classList.remove('over-limit');
    if (usage.percent >= 100) {
      status.classList.add('over-limit');
      status.textContent = '制限に到達';
    } else if (usage.percent >= 80) {
      status.textContent = '残りわずか';
    } else {
      status.textContent = '利用中';
    }
    connectionText.textContent = 'CLI 接続済み';
  } catch (error) {
    connectionText.textContent = '取得できません';
    setKiroLoading('エラー');
    document.getElementById('kiroStatus').textContent = '—';
    console.error('kiro:usage', error);
  }
}

function localizeAgyLabel(label) {
  const l = String(label).toLowerCase();
  if (l.includes('five hour') || l.includes('5h') || l.includes('5 hour')) return '5時間制限';
  if (l.includes('weekly') || l.includes('week')) return '週間制限';
  if (l.includes('daily') || l.includes('day')) return '日次制限';
  if (l.includes('month')) return '月間制限';
  return label;
}

function applyAgyLimit(limit, slotId) {
  document.getElementById(`agy${slotId}Percent`).textContent = `${limit.percent.toFixed(1)}%`;
  const progressEl = document.getElementById(`agy${slotId}Progress`);
  const trackEl = progressEl.parentElement;
  progressEl.style.width = `${limit.percent}%`;
  applyBarColor(progressEl, trackEl, limit.percent);
  document.getElementById(`agy${slotId}Reset`).textContent = limit.remaining || 'リセット時刻を確認';
  document.getElementById(`agy${slotId}Time`).textContent = limit.resetAt && !/quota available/i.test(limit.resetAt) ? ` · ${limit.resetAt}` : '';
  document.getElementById(`agy${slotId}Label`).textContent = localizeAgyLabel(limit.label);
  const status = document.getElementById(`agy${slotId}Status`);
  status.classList.remove('over-limit');
  if (limit.percent >= 100) {
    status.classList.add('over-limit');
    status.textContent = '制限に到達';
  } else if (limit.percent >= 80) {
    status.textContent = '残りわずか';
  } else {
    status.textContent = '利用中';
  }
}

function setAgySlot(slotId, { label, reset } = {}) {
  document.getElementById(`agy${slotId}Percent`).textContent = '—%';
  document.getElementById(`agy${slotId}Progress`).style.width = '0%';
  document.getElementById(`agy${slotId}Reset`).textContent = reset || '取得中…';
  document.getElementById(`agy${slotId}Time`).textContent = '';
  document.getElementById(`agy${slotId}Status`).textContent = '確認中';
  if (label) document.getElementById(`agy${slotId}Label`).textContent = label;
}

const AGY_SLOTS = ['GeminiHour', 'GeminiWeek', 'ClaudeHour', 'ClaudeWeek'];

function setAgyLoading() {
  document.getElementById('agyPlan').textContent = '確認中';
  AGY_SLOTS.forEach((s) => setAgySlot(s));
}

async function refreshAgyUsage() {
  const connectionText = document.getElementById('agyConnection').querySelector('span');
  connectionText.textContent = '取得中…';
  setAgyLoading();
  try {
    const usage = await window.usageApi.getAgyUsage();
    document.getElementById('agyPlan').textContent = usage.plan;
    // Map limits to the 4 fixed slots based on group + type.
    // Limits come sorted: [Gemini Five Hour, Gemini Weekly, Claude/GPT Five Hour, Claude/GPT Weekly]
    const slotMap = [
      { slot: 'GeminiHour', match: (l) => !/claude|gpt/i.test(l.label) && /hour/i.test(l.label) },
      { slot: 'GeminiWeek', match: (l) => !/claude|gpt/i.test(l.label) && /week/i.test(l.label) },
      { slot: 'ClaudeHour', match: (l) => /claude|gpt/i.test(l.label) && /hour/i.test(l.label) },
      { slot: 'ClaudeWeek', match: (l) => /claude|gpt/i.test(l.label) && /week/i.test(l.label) }
    ];
    for (const { slot, match } of slotMap) {
      const limit = usage.limits.find(match);
      if (limit) {
        applyAgyLimit(limit, slot);
      } else {
        setAgySlot(slot, { label: '—', reset: 'データなし' });
        document.getElementById(`agy${slot}Status`).textContent = '—';
      }
    }
    connectionText.textContent = 'CLI 接続済み';
  } catch (error) {
    connectionText.textContent = '取得できません';
    AGY_SLOTS.forEach((s) => {
      setAgySlot(s, { reset: 'エラー' });
      document.getElementById(`agy${s}Status`).textContent = '—';
    });
    console.error('agy:usage', error);
  }
}

const PROVIDER_META = {
  claude: { name: 'Claude', sub: 'Anthropic' },
  codex: { name: 'Codex', sub: 'OpenAI' },
  kiro: { name: 'Kiro', sub: 'AWS' },
  agy: { name: 'Gemini', sub: 'Google (Antigravity CLI)' }
};

const PROVIDER_USAGE_URLS = {
  claude: 'https://claude.ai/new#settings/usage',
  codex: 'https://chatgpt.com/codex/cloud/settings/analytics#usage',
  agy: 'https://gemini.google.com/usage?hl=ja',
  kiro: 'https://app.kiro.dev/settings/account'
};

// Attach click handlers to usage link buttons
document.querySelectorAll('.usage-link-button[data-provider-link]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const provider = btn.dataset.providerLink;
    const url = PROVIDER_USAGE_URLS[provider];
    if (url) window.usageApi.openExternal(url);
  });
});

let currentSettings = null;

// --- Settings Modal ---
const settingsButton = document.getElementById('settingsButton');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsClose = document.getElementById('settingsClose');
const settingsList = document.getElementById('settingsList');
const settingsSave = document.getElementById('settingsSave');

function renderSettingsList(providers) {
  settingsList.textContent = '';
  providers.forEach((p) => {
    const meta = PROVIDER_META[p.id] || { name: p.id, sub: '' };
    const li = document.createElement('li');
    li.className = 'settings-item';
    li.draggable = true;
    li.dataset.id = p.id;

    // Built with DOM calls rather than innerHTML: the fallback label is the
    // provider id, which comes from settings.json on disk.
    const grip = document.createElement('span');
    grip.className = 'settings-grip';
    grip.textContent = '⠿';

    const label = document.createElement('span');
    label.className = 'settings-item-label';
    label.textContent = meta.name;
    const sub = document.createElement('span');
    sub.className = 'settings-item-sub';
    sub.textContent = meta.sub;
    label.appendChild(sub);

    const toggle = document.createElement('button');
    toggle.className = p.enabled ? 'settings-toggle active' : 'settings-toggle';
    toggle.setAttribute('aria-label', '表示切替');

    li.append(grip, label, toggle);
    // Toggle
    toggle.addEventListener('click', (e) => {
      e.currentTarget.classList.toggle('active');
    });
    // Drag events
    li.addEventListener('dragstart', (e) => {
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.id);
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      // Compared as a plain value instead of built into a CSS selector string.
      const draggedEl = Array.from(settingsList.children).find((el) => el.dataset.id === draggedId);
      if (draggedEl && draggedEl !== li) {
        settingsList.insertBefore(draggedEl, li);
      }
    });
    settingsList.appendChild(li);
  });
}

function openSettings() {
  renderSettingsList(currentSettings.providers);
  settingsOverlay.classList.remove('hidden');
  settingsOverlay.setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
  settingsOverlay.setAttribute('aria-hidden', 'true');
}

async function saveSettingsFromUI() {
  const items = settingsList.querySelectorAll('.settings-item');
  const providers = Array.from(items).map((li) => ({
    id: li.dataset.id,
    enabled: li.querySelector('.settings-toggle').classList.contains('active')
  }));
  // Spread the existing settings so saving the provider list does not drop
  // zoomLevel / windowBounds (the main process now persists only known keys).
  currentSettings = { ...currentSettings, providers };
  await window.usageApi.saveSettings(currentSettings);
  closeSettings();
  applySettings();
  // Re-fetch only newly enabled providers
  refreshAll();
}

settingsButton.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });
settingsSave.addEventListener('click', saveSettingsFromUI);

// --- Apply settings: reorder DOM + show/hide ---
function applySettings() {
  if (!currentSettings) return;
  const stack = document.querySelector('.provider-stack');
  const sections = {};
  stack.querySelectorAll('[data-provider]').forEach((el) => { sections[el.dataset.provider] = el; });

  let enabledCount = 0;
  for (const p of currentSettings.providers) {
    const el = sections[p.id];
    if (!el) continue;
    if (p.enabled) {
      el.style.display = '';
      stack.appendChild(el); // reorder by appending in order
      enabledCount += 1;
    } else {
      el.style.display = 'none';
    }
  }
  // (provider count removed from UI)
}

// --- Refresh logic respecting settings ---
const REFRESH_MAP = {
  claude: refreshClaudeUsage,
  codex: refreshCodexUsage,
  kiro: refreshKiroUsage,
  agy: refreshAgyUsage
};

function refreshAll() {
  const tasks = currentSettings.providers
    .filter((p) => p.enabled)
    .map((p) => REFRESH_MAP[p.id]?.());
  return Promise.all(tasks);
}

const button = document.getElementById('refreshButton');
button.addEventListener('click', async () => {
  button.disabled = true;
  button.classList.add('spinning');
  button.querySelector('span').textContent = '更新中…';
  await Promise.all([refreshAll(), new Promise((resolve) => setTimeout(resolve, 650))]);
  updateTime();
  button.disabled = false;
  button.classList.remove('spinning');
  button.querySelector('span').textContent = '最新情報に更新';
});

async function init() {
  updateTime();
  // Load settings
  currentSettings = await window.usageApi.loadSettings();
  applySettings();
  restoreZoom();
  // Fetch usage for enabled providers only
  await refreshAll();
  updateTime();
}

// --- Zoom (Ctrl+Scroll / Ctrl+Plus/Minus) ---
let zoomLevel = 100;
const ZOOM_STEP = 10;
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;

function applyZoom() {
  document.body.style.zoom = `${zoomLevel}%`;
  // Persist zoom level
  if (currentSettings) {
    currentSettings.zoomLevel = zoomLevel;
    window.usageApi.saveSettings(currentSettings);
  }
}

function restoreZoom() {
  if (currentSettings && currentSettings.zoomLevel) {
    zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, currentSettings.zoomLevel));
    document.body.style.zoom = `${zoomLevel}%`;
  }
}

window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (e.deltaY < 0) {
    zoomLevel = Math.min(ZOOM_MAX, zoomLevel + ZOOM_STEP);
  } else {
    zoomLevel = Math.max(ZOOM_MIN, zoomLevel - ZOOM_STEP);
  }
  applyZoom();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return;
  if (e.key === '+' || e.key === '=' || e.code === 'Equal') {
    e.preventDefault();
    zoomLevel = Math.min(ZOOM_MAX, zoomLevel + ZOOM_STEP);
    applyZoom();
  } else if (e.key === '-' || e.code === 'Minus') {
    e.preventDefault();
    zoomLevel = Math.max(ZOOM_MIN, zoomLevel - ZOOM_STEP);
    applyZoom();
  } else if (e.key === '0' || e.code === 'Digit0') {
    e.preventDefault();
    zoomLevel = 100;
    applyZoom();
  }
});

init();
