// Top Hat Watch service worker: alert logic for open Top Hat tabs, notifications
const DEFAULTS = {
  enabled: true,
  ntfyTopic: '',
  ntfyServer: 'https://ntfy.sh',
  sound: true,
};

// Optional gitignored overrides in local.json
async function localDefaults() {
  try { return await (await fetch(chrome.runtime.getURL('local.json'))).json(); } catch { return {}; }
}

async function cfg() {
  return { ...DEFAULTS, ...(await localDefaults()), ...(await chrome.storage.local.get(null)) };
}

// ---------- alert logic ----------

let queue = Promise.resolve();

async function handleScan(msg, tabId) {
  const c = await cfg();
  const key = `${tabId}:${msg.course}`;
  const { st = {} } = await chrome.storage.session.get('st');
  const s = st[key] || { alerted: {}, presenting: null };
  if (tabId != null) chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});

  const reasons = [];
  for (const it of msg.r.items) {
    if (!it.pending) continue;
    if (s.alerted[it.id]) continue;
    s.alerted[it.id] = Date.now();
    reasons.push((it.kind === 'attendance' ? 'ATTENDANCE: ' : '') + (it.text || 'new question'));
  }
  // Forget items no longer pending so a reopened question alerts again
  const pendingIds = new Set(msg.r.items.filter(i => i.pending).map(i => i.id));
  for (const id of Object.keys(s.alerted)) if (!pendingIds.has(id)) delete s.alerted[id];

  const presentingStarted = msg.r.presenting && !s.presenting;
  s.presenting = msg.r.presenting;
  st[key] = s;
  await chrome.storage.session.set({ st });
  await updateBadge(st);

  if (!c.enabled) return;
  if (presentingStarted) notify(`${msg.name}: presenting started`, msg.r.presenting, tabId, false, false);
  if (reasons.length) {
    notify(`Top Hat question - ${msg.name}`, [...new Set(reasons)].join(' | ').slice(0, 300), tabId, true, true);
  }
}

async function updateBadge(st) {
  const n = Object.values(st).reduce((a, s) => a + Object.keys(s.alerted).length, 0);
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
}

async function handleLogin(tabId) {
  const c = await cfg();
  if (!c.enabled) return;
  const { loginWarned } = await chrome.storage.session.get('loginWarned');
  if (loginWarned) return;
  await chrome.storage.session.set({ loginWarned: true });
  notify('Top Hat Watch: login needed', 'Sign in to Top Hat, or alerts will not work.', tabId, false, true);
}

// ---------- notifications ----------

async function notify(title, message, tabId, loud, push) {
  const c = await cfg();
  const id = await chrome.notifications.create({
    type: 'basic', iconUrl: 'icon128.png', title, message, priority: 2, requireInteraction: loud,
  });
  if (tabId != null) {
    const { clicks = {} } = await chrome.storage.session.get('clicks');
    clicks[id] = tabId;
    await chrome.storage.session.set({ clicks });
  }
  if (loud && c.sound) playSound();
  if (push && c.ntfyTopic) {
    let url;
    try { url = tabId != null ? (await chrome.tabs.get(tabId)).url : undefined; } catch { /* tab gone */ }
    fetch(c.ntfyServer, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: c.ntfyTopic, title, message, priority: loud ? 5 : 3,
        tags: ['rotating_light'], ...(url ? { click: url } : {}),
      }),
    }).catch(e => console.warn('ntfy failed', e));
  }
}

async function playSound() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Alert sound',
    });
  }
  chrome.runtime.sendMessage({ type: 'beep' });
}

chrome.notifications.onClicked.addListener(async id => {
  const { clicks = {} } = await chrome.storage.session.get('clicks');
  const tabId = clicks[id];
  chrome.notifications.clear(id);
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch { /* tab closed */ }
});

// ---------- events ----------

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab ? sender.tab.id : null;
  if (msg.type === 'scan') queue = queue.then(() => handleScan(msg, tabId)).catch(console.error);
  else if (msg.type === 'login') handleLogin(tabId);
  else if (msg.type === 'test') notify('Top Hat Watch test', 'If you see/hear this, alerts work.', null, true, true);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const { st = {} } = await chrome.storage.session.get('st');
  for (const k of Object.keys(st)) if (k.startsWith(tabId + ':')) delete st[k];
  await chrome.storage.session.set({ st });
  updateBadge(st);
});

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd !== 'toggle') return;
  const c = await cfg();
  await chrome.storage.local.set({ enabled: !c.enabled });
});

// Rescan open Top Hat tabs every 30 s (backup for throttled background tabs)
chrome.alarms.create('rescan', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'rescan') return;
  const tabs = await chrome.tabs.query({ url: 'https://app.tophat.com/e/*' });
  for (const t of tabs) {
    if (t.discarded) chrome.tabs.reload(t.id);
    else chrome.tabs.sendMessage(t.id, { type: 'rescan' }).catch(() => {});
  }
});
