// Scans the Top Hat Classroom tab (/e/<id>/lecture) and reports to background
(() => {
  const LECTURE = /^\/e\/(\d+)\/lecture/;

  function scan() {
    const items = [];
    const push = (id, text, kind) =>
      items.push({ id, text: (text || '').trim().replace(/\s*\n\s*/g, ' / ').slice(0, 200), kind });
    let sections = 0, presenting = null;
    document.querySelectorAll('[class*="StudentContentTreestyles__Section-"]').forEach(sec => {
      const title = ((sec.querySelector('[class*="SectionTitle"]') || {}).innerText || '').trim();
      let lis = [...sec.querySelectorAll('[class*="SectionList"] > li')];
      if (!lis.length) lis = [...sec.querySelectorAll('[role="treeitem"]')];
      sections++;
      if (/question|attendance/i.test(title)) {
        lis.forEach(li => {
          const inner = li.querySelector('[aria-label]');
          const text = li.getAttribute('aria-label') || (inner && inner.getAttribute('aria-label')) || li.innerText;
          const id = li.id || (li.querySelector('[id]') || {}).id || text;
          push('live:' + id, text, /attendance/i.test(text) ? 'attendance' : 'question');
        });
      } else if (/present/i.test(title)) {
        presenting = lis.length ? lis.map(l => l.innerText.trim()).join(' / ').slice(0, 120) : null;
      }
    });
    // Fallback signals
    const toast = document.getElementById('tophat.new-question-item-notification');
    if (toast) push('toast:' + toast.innerText.slice(0, 80), toast.innerText || 'New question', 'question');
    const body = document.body ? document.body.innerText : '';
    const emptyGone = sections > 0 && !/No questions or attendance sessions are being presented/i.test(body);
    return { items, sections, emptyGone, presenting };
  }

  function courseName() {
    const bc = document.querySelector('[class*="BreadcrumbCurrent"]');
    const t = (bc && bc.innerText.trim()) || document.title.replace(/\s*-\s*Classroom.*$/, '').replace(/\s*\|\s*Top Hat$/, '');
    return t || 'Top Hat';
  }

  function send(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (e) { /* extension reloaded */ }
  }

  let last = '';
  function report(force) {
    const m = location.pathname.match(LECTURE);
    if (!m) return;
    const r = scan();
    if (!r.sections) return;
    const key = JSON.stringify(r);
    if (key === last && !force) return;
    last = key;
    send({ type: 'scan', course: m[1], name: courseName(), url: location.href, r });
  }

  if (/^\/login/.test(location.pathname)) send({ type: 'login', url: location.href });

  let timer;
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(report, 300); })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setInterval(report, 5000);
  chrome.runtime.onMessage.addListener(m => { if (m.type === 'rescan') report(true); });

  // On-page ON/OFF pill
  const pill = document.createElement('div');
  pill.id = 'tophat-watch-pill';
  pill.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:4px 10px;border-radius:12px;' +
    'font:600 12px system-ui,sans-serif;color:#fff;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.3);user-select:none';
  const paint = on => {
    pill.textContent = on ? 'Watch: ON' : 'Watch: OFF';
    pill.style.background = on ? '#dc2626' : '#6b7280';
    pill.title = on ? 'Top Hat Watch is alerting. Click to stop.' : 'Click to start Top Hat Watch';
  };
  pill.onclick = () => send({ type: 'toggle' });
  chrome.storage.local.get('on').then(v => paint(!!v.on));
  chrome.storage.onChanged.addListener(ch => { if (ch.on) paint(!!ch.on.newValue); });
  (document.body || document.documentElement).appendChild(pill);
})();
