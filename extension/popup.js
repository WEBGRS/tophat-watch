// Popup: pause switch, watched tabs, settings
const DEFAULTS = { enabled: true, ntfyTopic: '', sound: true };
const $ = id => document.getElementById(id);

async function render() {
  let local = {};
  try { local = await (await fetch(chrome.runtime.getURL('local.json'))).json(); } catch {}
  const c = { ...DEFAULTS, ...local, ...(await chrome.storage.local.get(null)) };
  $('toggle').className = c.enabled ? 'on' : 'off';
  $('toggle').textContent = c.enabled ? 'Watching - click to pause' : 'Paused - click to resume';
  const tabs = await chrome.tabs.query({ url: 'https://app.tophat.com/e/*' });
  const ul = $('tabs');
  ul.textContent = '';
  for (const t of tabs) {
    const li = document.createElement('li');
    const lecture = /\/e\/\d+\/lecture/.test(t.url);
    li.textContent = (t.title || t.url).replace(/\s*\|\s*Top Hat$/, '') + (lecture ? '' : '  (not Classroom tab)');
    ul.appendChild(li);
  }
  $('status').textContent = tabs.length
    ? `Watching ${tabs.length} open Top Hat tab(s). Shortcut: Alt+Shift+W`
    : 'No Top Hat course tab open. Open a course\'s Classroom tab to watch it.';
  $('ntfyTopic').value = c.ntfyTopic;
  $('sound').checked = c.sound;
}

$('toggle').onclick = async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  await chrome.storage.local.set({ enabled: enabled === false });
  render();
};
$('test').onclick = () => chrome.runtime.sendMessage({ type: 'test' });
$('ntfyTopic').onchange = () => chrome.storage.local.set({ ntfyTopic: $('ntfyTopic').value.trim() });
$('sound').onchange = () => chrome.storage.local.set({ sound: $('sound').checked });
render();
