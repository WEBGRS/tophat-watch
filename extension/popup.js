// Popup: on/off switch and settings
const DEFAULTS = { on: false, courses: '', ntfyTopic: '', autoStopHours: 3, sound: true, startedAt: 0 };
const $ = id => document.getElementById(id);

async function render() {
  let local = {};
  try { local = await (await fetch(chrome.runtime.getURL('local.json'))).json(); } catch {}
  const c = { ...DEFAULTS, ...local, ...(await chrome.storage.local.get(null)) };
  $('toggle').className = c.on ? 'on' : 'off';
  $('toggle').textContent = c.on ? 'Stop watching' : 'Start watching';
  if (c.on) {
    const end = new Date(c.startedAt + c.autoStopHours * 3600e3);
    $('status').textContent = `Watching since ${new Date(c.startedAt).toLocaleTimeString()}, auto stop ${end.toLocaleTimeString()}`;
  } else {
    $('status').textContent = 'Off. Shortcut: Alt+Shift+W';
  }
  $('courses').value = c.courses;
  $('ntfyTopic').value = c.ntfyTopic;
  $('autoStopHours').value = c.autoStopHours;
  $('sound').checked = c.sound;
}

$('toggle').onclick = async () => {
  $('toggle').disabled = true;
  await chrome.runtime.sendMessage({ type: 'toggle' });
  $('toggle').disabled = false;
  render();
};
$('test').onclick = () => chrome.runtime.sendMessage({ type: 'test' });
for (const id of ['courses', 'ntfyTopic', 'autoStopHours']) {
  $(id).onchange = () => chrome.storage.local.set({ [id]: id === 'autoStopHours' ? Number($(id).value) || 3 : $(id).value.trim() });
}
$('sound').onchange = () => chrome.storage.local.set({ sound: $('sound').checked });
render();
