// Top Hat Watch service worker: tab management, alert logic, notifications
const DEFAULTS = {
  on: false,
  courses: '',
  ntfyTopic: '',
  ntfyServer: 'https://ntfy.sh',
  autoStopHours: 3,
  sound: true,
  tabIds: [],
  startedAt: 0,
};

// Optional gitignored overrides in local.json
async function localDefaults() {
  try { return await (await fetch(chrome.runtime.getURL('local.json'))).json(); } catch { return {}; }
}

async function cfg() {
  return { ...DEFAULTS, ...(await localDefaults()), ...(await chrome.storage.local.get(null)) };
}

// ---------- on/off ----------

async function start() {
  const c = await cfg();
  const ids = c.courses.split(/[,\s]+/).filter(Boolean);
  const tabIds = [];
  for (const id of ids) {
    const url = `https://app.tophat.com/e/${id}/lecture`;
    const [existing] = await chrome.tabs.query({ url: url + '*' });
    const tab = existing || await chrome.tabs.create({ url, pinned: true, active: false });
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
    if (!existing) tabIds.push(tab.id);
  }
  await chrome.storage.session.set({ st: {}, loginWarned: false });
  await chrome.storage.local.set({ on: true, tabIds, startedAt: Date.now() });
  chrome.alarms.create('autostop', { delayInMinutes: c.autoStopHours * 60 });
  chrome.alarms.create('rescan', { periodInMinutes: 0.5 });
  setBadge(true);
  notify('Top Hat Watch ON', `${ids.length} course(s), auto stop in ${c.autoStopHours} h`, null, false, false);
}

async function stop(reason) {
  const c = await cfg();
  for (const id of c.tabIds) {
    try { await chrome.tabs.remove(id); } catch (e) { /* already closed */ }
  }
  await chrome.alarms.clearAll();
  await chrome.storage.local.set({ on: false, tabIds: [], startedAt: 0 });
  setBadge(false);
  notify('Top Hat Watch OFF', reason || 'stopped', null, false, false);
}

async function toggle() {
  (await cfg()).on ? await stop() : await start();
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
}

// ---------- alert logic ----------

let queue = Promise.resolve();

async function handleScan(msg) {
  const c = await cfg();
  if (!c.on) return;
  const { st = {} } = await chrome.storage.session.get('st');
  const s = st[msg.course] || { seen: {}, presenting: null, emptyGone: false };
  const reasons = [];
  for (const it of msg.r.items) {
    if (s.seen[it.id]) continue;
    s.seen[it.id] = Date.now();
    reasons.push((it.kind === 'attendance' ? 'ATTENDANCE: ' : '') + (it.text || 'new question'));
  }
  if (msg.r.emptyGone && !s.emptyGone && !msg.r.items.length) {
    reasons.push('something is live in Questions & Attendance');
  }
  if (msg.r.presenting && !s.presenting) {
    notify(`${msg.name}: presenting started`, msg.r.presenting, msg.url, false, false);
  }
  s.presenting = msg.r.presenting;
  s.emptyGone = msg.r.emptyGone;
  st[msg.course] = s;
  await chrome.storage.session.set({ st });
  if (reasons.length) {
    notify(`Top Hat question - ${msg.name}`, [...new Set(reasons)].join(' | ').slice(0, 300), msg.url, true, true);
  }
}

async function handleLogin() {
  const c = await cfg();
  if (!c.on) return;
  const { loginWarned } = await chrome.storage.session.get('loginWarned');
  if (loginWarned) return;
  await chrome.storage.session.set({ loginWarned: true });
  notify('Top Hat Watch: login needed', 'Sign in to Top Hat in the pinned tab, or alerts will not work.', null, false, true);
}

// ---------- notifications ----------

const clickUrls = {};

async function notify(title, message, url, loud, push) {
  const c = await cfg();
  const id = await chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message,
    priority: 2,
    requireInteraction: loud,
  });
  if (url) clickUrls[id] = url;
  if (loud && c.sound) playSound();
  if (push && c.ntfyTopic) {
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
  const url = clickUrls[id];
  if (!url) return;
  const [tab] = await chrome.tabs.query({ url: url.split('#')[0] + '*' });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
  chrome.notifications.clear(id);
});

// ---------- events ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'scan') queue = queue.then(() => handleScan(msg)).catch(console.error);
  else if (msg.type === 'login') handleLogin();
  else if (msg.type === 'toggle') toggle().then(() => reply(true));
  else if (msg.type === 'test') notify('Top Hat Watch test', 'If you see/hear this, alerts work.', null, true, true);
  return msg.type === 'toggle';
});

chrome.commands.onCommand.addListener(cmd => { if (cmd === 'toggle') toggle(); });

chrome.alarms.onAlarm.addListener(async a => {
  const c = await cfg();
  if (a.name === 'autostop') return stop(`auto stop after ${c.autoStopHours} h`);
  if (a.name !== 'rescan' || !c.on) return;
  // Keep watched tabs alive and rescanned
  const ids = c.courses.split(/[,\s]+/).filter(Boolean);
  for (const id of ids) {
    const url = `https://app.tophat.com/e/${id}/lecture`;
    const tabs = await chrome.tabs.query({ url: 'https://app.tophat.com/*' });
    const tab = tabs.find(t => t.url && t.url.startsWith(url));
    if (!tab) {
      if (tabs.some(t => /\/login/.test(t.url || ''))) continue;
      const t = await chrome.tabs.create({ url, pinned: true, active: false });
      await chrome.tabs.update(t.id, { autoDiscardable: false });
      await chrome.storage.local.set({ tabIds: [...c.tabIds, t.id] });
    } else if (tab.discarded || tab.status === 'unloaded') {
      chrome.tabs.reload(tab.id);
    } else {
      chrome.tabs.sendMessage(tab.id, { type: 'rescan' }).catch(() => chrome.tabs.reload(tab.id));
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  // Browser restart: previous session tabs are gone
  if ((await cfg()).on) await chrome.storage.local.set({ on: false, tabIds: [] });
  setBadge(false);
});
