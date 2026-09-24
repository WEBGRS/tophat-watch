// Watches the open Top Hat tab and reports pending questions/attendance to background
(() => {
  const COURSE = /^\/e\/(\d+)/;
  const LECTURE = /^\/e\/\d+\/lecture/;

  // Pending = open and not yet answered / checked in
  function itemState(li, body) {
    const row = li.querySelector('.list-row') || li;
    const label = ((li.querySelector('[id^="label-item-"]') || {}).innerText || li.getAttribute('aria-label') || '').trim();
    const title = ((li.querySelector('[data-click-id$="details title"]') || {}).innerText || '').trim();
    const sub = ((li.querySelector('[data-click-id$="details subtext"]') || {}).innerText || '').trim();
    const all = `${label} | ${sub}`.toLowerCase();
    const kind = /attendance/i.test(label + title) ? 'attendance' : 'question';
    let pending = true;
    if (row.classList.contains('list-row--answered')) pending = false;
    if (/\b(answered|submitted|complete[d]?|present|checked in)\b/.test(all.replace(/unanswered/g, ''))) pending = false;
    if (/\bclosed\b/.test(all)) pending = false;
    if (row.classList.contains('list-row--unanswered')) pending = true;
    if (kind === 'attendance' && /marked present|attendance has been (recorded|updated)/i.test(body)) pending = false;
    const idAttr = (li.querySelector('[data-click-id^="tree item"]') || {}).getAttribute?.('data-click-id') || '';
    const id = (idAttr.match(/tree item (\d+)/) || [])[1] || title || label;
    return { id: 'live:' + id, text: title || label || li.innerText.trim().split('\n')[0], kind, pending, raw: label || sub };
  }

  function scan() {
    const body = document.body ? document.body.innerText : '';
    const items = [];
    let sections = 0, presenting = null;
    document.querySelectorAll('[class*="StudentContentTreestyles__Section-"]').forEach(sec => {
      const title = ((sec.querySelector('[class*="SectionTitle"]') || {}).innerText || '').trim();
      const lis = [...sec.querySelectorAll('[class*="SectionList"] > li')];
      sections++;
      if (/question|attendance/i.test(title)) lis.forEach(li => items.push(itemState(li, body)));
      else if (/present/i.test(title)) presenting = lis.length ? lis.map(l => l.innerText.trim()).join(' / ').slice(0, 120) : null;
    });
    // Non-Classroom pages: Top Hat's own "new question" toast
    const toast = document.getElementById('tophat.new-question-item-notification');
    if (toast) items.push({ id: 'toast:' + toast.innerText.slice(0, 80), text: toast.innerText.trim() || 'New question', kind: 'question', pending: true, raw: 'toast' });
    return { items, sections, presenting, lecture: LECTURE.test(location.pathname) };
  }

  function courseName() {
    const bc = document.querySelector('[class*="BreadcrumbCurrent"]');
    const t = (bc && bc.innerText.trim()) || document.title.replace(/\s*-\s*Classroom.*$/, '').replace(/\s*\|\s*Top Hat$/, '');
    return t || 'Top Hat';
  }

  function send(msg) {
    try { return chrome.runtime.sendMessage(msg); } catch (e) { return Promise.resolve(); }
  }

  let last = '';
  function report(force) {
    const m = location.pathname.match(COURSE);
    if (!m) return;
    const r = scan();
    const key = JSON.stringify(r);
    if (key === last && !force) return;
    last = key;
    send({ type: 'scan', course: m[1], name: courseName(), url: location.href, r });
  }

  if (/^\/login/.test(location.pathname)) send({ type: 'login', url: location.href });

  let timer;
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(report, 300); })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  setInterval(report, 5000);
  chrome.runtime.onMessage.addListener(m => { if (m.type === 'rescan') report(true); });

  // On-page status pill
  const pill = document.createElement('div');
  pill.id = 'tophat-watch-pill';
  pill.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:4px 10px;border-radius:12px;' +
    'font:600 12px system-ui,sans-serif;color:#fff;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.3);user-select:none';
  const paint = on => {
    pill.style.display = COURSE.test(location.pathname) ? '' : 'none';
    const lecture = LECTURE.test(location.pathname);
    pill.textContent = !on ? 'Watch: OFF' : lecture ? 'Watch: ON' : 'Watch: ON (open Classroom tab for best results)';
    pill.style.background = !on ? '#6b7280' : lecture ? '#16a34a' : '#d97706';
    pill.title = on ? 'Top Hat Watch is watching this tab. Click to pause.' : 'Click to resume Top Hat Watch';
  };
  const refresh = () => chrome.storage.local.get('enabled').then(v => paint(v.enabled !== false));
  pill.onclick = () => chrome.storage.local.get('enabled').then(v => chrome.storage.local.set({ enabled: v.enabled === false }));
  chrome.storage.onChanged.addListener(ch => { if (ch.enabled) refresh(); });
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; refresh(); } }, 1000);
  refresh();
  (document.body || document.documentElement).appendChild(pill);
})();
