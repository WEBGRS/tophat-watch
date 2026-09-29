// Top Hat Watch service worker: alert logic for open Top Hat tabs, notifications
const DEFAULTS = {
  enabled: true,
  ntfyTopic: '',
  ntfyServer: 'https://ntfy.sh',
  sound: true,
  pushAlerts: true,
  pushCooldownSec: 90,
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
  s.known = s.known || {};
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

  const wasBaselined = !!s.baselined;
  // New entries in other sections (baseline on first scan)
  for (const it of msg.r.items) {
    if (it.kind !== 'content' || s.known[it.id]) continue;
    s.known[it.id] = Date.now();
    if (s.baselined) reasons.push('NEW: ' + it.text);
  }
  if (msg.r.sections) s.baselined = true;

  const presentingChanged = wasBaselined && msg.r.presenting && msg.r.presenting !== s.presenting;
  s.presenting = msg.r.presenting;
  st[key] = s;
  await chrome.storage.session.set({ st });
  await updateBadge(st);

  if (!c.enabled) return;
  if (presentingChanged) {
    await markAlert(msg.course);
    notify(`Top Hat presenting - ${msg.name}`, msg.r.presenting, tabId, true, true);
  }
  if (reasons.length) {
    await markAlert(msg.course);
    const what = reasons.every(r => r.startsWith('NEW: ')) ? 'new item' : 'question';
    notify(`Top Hat ${what} - ${msg.name}`, [...new Set(reasons)].join(' | ').slice(0, 300), tabId, true, true);
  }
}

async function markAlert(course) {
  const { lastAlert = {} } = await chrome.storage.session.get('lastAlert');
  lastAlert[course] = Date.now();
  await chrome.storage.session.set({ lastAlert });
}

// Any server push (WebSocket frame) from the instructor side
async function handlePush(msg, tabId) {
  const p = msg.push;
  const { pushLog = [] } = await chrome.storage.local.get('pushLog');
  pushLog.unshift({ t: Date.now(), course: msg.name, warmup: !!msg.warmup, ...p });
  await chrome.storage.local.set({ pushLog: pushLog.slice(0, 40) });
  if (msg.warmup) return;
  const c = await cfg();
  if (!c.enabled || !c.pushAlerts) return;

  // Same kind of push within cooldown stays quiet (e.g. slide flips)
  const key = `${msg.course}|${p.type}|${p.event}`;
  const { pushSeen = {} } = await chrome.storage.session.get('pushSeen');
  const now = Date.now();
  const recent = pushSeen[key] && now - pushSeen[key] < c.pushCooldownSec * 1000;
  pushSeen[key] = now;
  await chrome.storage.session.set({ pushSeen });
  if (recent) return;

  // Skip if the DOM scan already alerted for this course
  const { lastAlert = {} } = await chrome.storage.session.get('lastAlert');
  if (lastAlert[msg.course] && Date.now() - lastAlert[msg.course] < 8000) return;
  await markAlert(msg.course);
  const what = p.event ? `${p.type} / ${p.event}` : p.type;
  notify(`Top Hat push - ${msg.name}`, `Instructor pushed something (${what}). Check the tab.`, tabId, true, true);
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
    type: 'basic', iconUrl: 'icon128.png', title, message, priority: 1, requireInteraction: false,
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
        topic: c.ntfyTopic, title, message, priority: 3,
        tags: ['bell'], ...(url ? { click: url } : {}),
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
  // Delay so the DOM scan (more specific) gets to alert first
  else if (msg.type === 'push') setTimeout(() => { queue = queue.then(() => handlePush(msg, tabId)).catch(console.error); }, 3000);
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
