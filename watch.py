"""Top Hat question watcher: alerts (toast + sound + phone push) when a question goes live."""
import argparse
import base64
import json
import re
import subprocess
import sys
import threading
import time
import urllib.request
import winreg
import winsound
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
PROFILE = ROOT / "profile"
LOGS = ROOT / "logs"
SEEN_FILE = ROOT / "seen.json"
STATUS_FILE = ROOT / "status.json"
LOBBY = "https://app.tophat.com/e"
LOGIN_RE = re.compile(r"login|signin|sign_in|auth|shibboleth|idp|duosecurity|/register", re.I)

# In-page scan of the Classroom tab (/e/<id>/lecture); fallback selectors from open-source notifiers
SCAN_JS = r"""
() => {
  const items = [];
  const push = (id, text, kind) => items.push({id, text: (text || '').trim().replace(/\s*\n\s*/g, ' / ').slice(0, 200), kind});
  let sections = 0, presenting = null;
  document.querySelectorAll('[class*="StudentContentTreestyles__Section-"]').forEach(sec => {
    const title = ((sec.querySelector('[class*="SectionTitle"]') || {}).innerText || '').trim();
    let lis = [...sec.querySelectorAll('[class*="SectionList"] > li')];
    if (!lis.length) lis = [...sec.querySelectorAll('[role="treeitem"]')];
    sections++;
    if (/question|attendance/i.test(title)) {
      lis.forEach(li => {
        const label = li.getAttribute('aria-label') || (li.querySelector('[aria-label]') || {getAttribute: () => ''}).getAttribute('aria-label') || '';
        const text = label || li.innerText;
        push('live:' + (li.id || (li.querySelector('[id]') || {}).id || text), text, /attendance/i.test(text) ? 'attendance' : 'question');
      });
    } else if (/present/i.test(title)) {
      presenting = lis.length ? lis.map(l => l.innerText.trim()).join(' / ').slice(0, 120) : null;
    }
  });
  const body = document.body ? document.body.innerText : '';
  const emptyGone = sections > 0 && !/No questions or attendance sessions are being presented/i.test(body);
  document.querySelectorAll('[data-testid="QuestionIcon"]').forEach(icon => {
    const row = icon.closest('[data-hotkey-id="list-item"]') || icon.closest('li');
    if (!row) return;
    const sub = row.querySelector('[data-click-id*="details subtext"]');
    const st = sub ? sub.innerText.trim().toLowerCase() : '';
    if (st && st !== 'unanswered') return;
    const c = row.querySelector('[data-click-id*="sanity="]');
    const t = row.querySelector('[data-click-id*="details title"]');
    const text = t ? t.innerText : row.innerText;
    push('q:' + (c ? c.getAttribute('data-click-id') : text), text, 'question');
  });
  document.querySelectorAll('.list-row--unanswered').forEach(r => push('legacy:' + r.innerText.slice(0, 120), r.innerText, 'question'));
  const toast = document.getElementById('tophat.new-question-item-notification');
  const badge = document.querySelector('span[class*="UnansweredCountBadge"], span[class*="UnansweredQuestionCount"]');
  const n = badge ? parseInt(badge.innerText, 10) : NaN;
  return {
    items,
    toast: toast ? (toast.innerText || 'New question').trim().slice(0, 200) : null,
    form: !!document.querySelector('form.question-renderer-container'),
    count: isNaN(n) ? null : n,
    tree: sections > 0,
    emptyGone,
    presenting,
    title: document.title,
  };
}
"""

COURSE_LINKS_JS = r"""
() => [...document.querySelectorAll('a[href^="/e/"]')]
  .map(a => ({href: a.getAttribute('href'), name: (a.getAttribute('aria-label') || a.innerText || '').trim()}))
  .filter(x => /^\/e\/\d+\/?$/.test(x.href))
"""


def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    try:
        print(line, flush=True)
    except Exception:
        pass
    LOGS.mkdir(exist_ok=True)
    with open(LOGS / f"watch-{datetime.now():%Y%m%d}.log", "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


# ---------- notifications ----------

def toast(title, body):
    # WinRT toast via EncodedCommand (UTF-16, safe for any text)
    esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("'", "''")
    ps = f"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast scenario="urgent"><visual><binding template="ToastGeneric"><text>{esc(title)}</text><text>{esc(body)}</text></binding></visual><audio src="ms-winsoundevent:Notification.Looping.Alarm" loop="false"/></toast>')
$appId = '{{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($x))
"""
    enc = base64.b64encode(ps.encode("utf-16-le")).decode()
    subprocess.Popen(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", enc],
                     creationflags=subprocess.CREATE_NO_WINDOW)


def beep(repeats):
    def run():
        for _ in range(repeats):
            winsound.PlaySound("SystemHand", winsound.SND_ALIAS)
            time.sleep(0.4)
    threading.Thread(target=run, daemon=True).start()


def ntfy(cfg, title, body, url=None, priority=5):
    topic = cfg.get("ntfy_topic")
    if not topic:
        return
    payload = {"topic": topic, "title": title, "message": body, "priority": priority, "tags": ["rotating_light"]}
    if url:
        payload["click"] = url
    try:
        req = urllib.request.Request(cfg.get("ntfy_server", "https://ntfy.sh"), data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        log(f"ntfy failed: {e}")


def alert(cfg, title, body, url=None, loud=True):
    log(f"ALERT {title} | {body}")
    toast(title, body)
    if loud:
        beep(cfg.get("sound_repeats", 4))
    threading.Thread(target=ntfy, args=(cfg, title, body, url, 5 if loud else 3), daemon=True).start()


# ---------- browser ----------

def chrome_ua():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Google\Chrome\BLBeacon") as k:
            ver = winreg.QueryValueEx(k, "version")[0]
    except OSError:
        ver = "140.0.0.0"
    return f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{ver} Safari/537.36"


def launch(pw, headless):
    args = ["--disable-blink-features=AutomationControlled", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]
    return pw.chromium.launch_persistent_context(
        str(PROFILE), channel="chrome", headless=headless, args=args,
        user_agent=chrome_ua() if headless else None, viewport={"width": 1280, "height": 900})


def is_login(url):
    return "tophat.com" not in url or bool(LOGIN_RE.search(url.split("?")[0]))


def do_login():
    with sync_playwright() as pw:
        ctx = launch(pw, headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(LOBBY)
        print("Log in with NetID in the Chrome window. It closes itself once you reach the Top Hat course list.")
        deadline = time.time() + 900
        while time.time() < deadline:
            try:
                # Any logged-in Top Hat page counts; then go to lobby
                if any("tophat.com/e" in p.url and not is_login(p.url) for p in ctx.pages):
                    break
            except Exception:
                pass
            time.sleep(2)
        else:
            print("Timed out waiting for login.")
            ctx.close()
            return 1
        page = ctx.pages[-1]
        page.goto(LOBBY, wait_until="domcontentloaded")
        time.sleep(5)
        courses = page.evaluate(COURSE_LINKS_JS)
        print("Logged in. Courses found:")
        for c in courses:
            print(f"  {c['name'] or '?'}  https://app.tophat.com{c['href']}")
        time.sleep(2)
        ctx.close()
    return 0


class Tab:
    def __init__(self, name, url, page):
        self.name, self.url, self.page = name, url, page
        self.baselined = False
        self.toast = None
        self.form = False
        self.count = None
        self.last_reload = time.time()
        self.logged_out = False
        self.empty_since = None
        self.presenting = None
        self.empty_gone = False


def course_list(cfg, ctx):
    courses = {c["url"].rstrip("/"): c["name"] for c in cfg.get("courses", [])}
    if cfg.get("auto_discover", True):
        page = ctx.new_page()
        try:
            page.goto(LOBBY, wait_until="domcontentloaded", timeout=60000)
            for _ in range(15):
                links = page.evaluate(COURSE_LINKS_JS)
                if links or is_login(page.url):
                    break
                time.sleep(1)
            skip = re.compile(cfg.get("exclude_regex", r"$^"), re.I)
            for l in links:
                if skip.search(l["name"] or ""):
                    continue
                u = "https://app.tophat.com" + l["href"].rstrip("/")
                courses.setdefault(u, l["name"] or l["href"])
            if links:
                log(f"lobby courses: {links}")
        except Exception as e:
            log(f"discover failed: {e}")
        finally:
            page.close()
    # Watch each course's Classroom tab
    out = {}
    for u, n in courses.items():
        m = re.search(r"/e/(\d+)", u)
        if m:
            out.setdefault(f"https://app.tophat.com/e/{m.group(1)}/lecture", n)
    return out


def check_tab(cfg, tab, seen):
    try:
        if is_login(tab.page.url):
            if not tab.logged_out:
                tab.logged_out = True
                alert(cfg, "Top Hat watcher: login expired",
                      f"{tab.name}: run  python watch.py --login  to sign in again", loud=False)
            return
        tab.logged_out = False
        r = tab.page.evaluate(SCAN_JS)
    except Exception as e:
        log(f"{tab.name}: scan error {e}; reloading")
        reload(tab)
        return

    new = [it for it in r["items"] if it["id"] not in seen]
    reasons = []
    for it in new:
        seen[it["id"]] = time.time()
        # Live items alert even on first scan; old fallback items are baselined silently
        if tab.baselined or it["id"].startswith("live:"):
            reasons.append(("ATTENDANCE: " if it["kind"] == "attendance" else "") + (it["text"] or "new question"))
    if tab.baselined:
        if r["toast"] and not tab.toast:
            reasons.append(r["toast"])
        if r["form"] and not tab.form:
            reasons.append("question opened on screen")
        if r["count"] is not None and tab.count is not None and r["count"] > tab.count:
            reasons.append(f"unanswered count {tab.count} -> {r['count']}")
        if r["presenting"] and not tab.presenting:
            alert(cfg, f"Top Hat {tab.name}: presenting started", r["presenting"], tab.url, loud=False)
    if r["emptyGone"] and not tab.empty_gone and not any(i["id"].startswith("live:") for i in r["items"]):
        reasons.append("something is live in Questions & Attendance")
    tab.toast, tab.form, tab.count = r["toast"], r["form"], r["count"]
    tab.presenting, tab.empty_gone = r["presenting"], r["emptyGone"]
    tab.baselined = tab.baselined or bool(r["tree"])

    if reasons:
        alert(cfg, f"Top Hat question - {tab.name}", " | ".join(dict.fromkeys(reasons))[:300], tab.url)
        save_json(SEEN_FILE, seen)

    # Page never rendered course content: reload periodically
    if not r["tree"]:
        tab.empty_since = tab.empty_since or time.time()
        if time.time() - tab.empty_since > 120:
            log(f"{tab.name}: content tree missing for 2 min; reloading")
            reload(tab)
    else:
        tab.empty_since = None
    if time.time() - tab.last_reload > cfg.get("reload_minutes", 45) * 60 and not r["form"]:
        reload(tab)


def reload(tab):
    tab.last_reload = time.time()
    tab.empty_since = None
    try:
        tab.page.goto(tab.url, wait_until="domcontentloaded", timeout=60000)
    except Exception as e:
        log(f"{tab.name}: reload failed {e}")


def watch(cfg, show):
    seen = load_json(SEEN_FILE, {})
    with sync_playwright() as pw:
        ctx = launch(pw, headless=cfg.get("headless", True) and not show)
        initial = list(ctx.pages)
        courses = course_list(cfg, ctx)
        log(f"watching {len(courses)} course(s): {courses}")
        tabs = []
        for url, name in courses.items():
            page = ctx.new_page()
            page.on("websocket", lambda ws, n=name: ws.on("framereceived", lambda f, n=n: ws_log(n, f)))
            tab = Tab(name, url, page)
            reload(tab)
            tabs.append(tab)
        for p in initial:
            if tabs:
                p.close()
        alert(cfg, "Top Hat watcher running", ", ".join(courses.values()) or "no courses found", loud=False)
        started = time.time()
        limit = cfg.get("auto_stop_hours", 3) * 3600
        while True:
            if limit and time.time() - started > limit:
                alert(cfg, "Top Hat watcher stopped", f"auto stop after {cfg.get('auto_stop_hours', 3)} h", loud=False)
                ctx.close()
                raise SystemExit(0)
            for tab in tabs:
                check_tab(cfg, tab, seen)
            save_json(STATUS_FILE, {"time": datetime.now().isoformat(timespec="seconds"),
                                    "tabs": {t.name: {"url": t.page.url, "logged_out": t.logged_out,
                                                      "baselined": t.baselined, "count": t.count} for t in tabs}})
            time.sleep(cfg.get("poll_seconds", 2))


def ws_log(name, frame):
    # Raw frames for tuning detection
    try:
        text = frame if isinstance(frame, str) else frame.decode("utf-8", "replace")
    except Exception:
        return
    if len(text) < 4:
        return
    LOGS.mkdir(exist_ok=True)
    with open(LOGS / f"ws-{datetime.now():%Y%m%d}.log", "a", encoding="utf-8") as f:
        f.write(f"[{datetime.now():%H:%M:%S}] {name}: {text[:2000]}\n")


_lock = None


def single_instance():
    global _lock
    import msvcrt
    _lock = open(ROOT / "watch.lock", "w")
    try:
        msvcrt.locking(_lock.fileno(), msvcrt.LK_NBLCK, 1)
        return True
    except OSError:
        return False


def main():
    ap = argparse.ArgumentParser(description="Top Hat question watcher")
    ap.add_argument("--login", action="store_true", help="open Chrome to sign in with NetID, then start watching")
    ap.add_argument("--test", action="store_true", help="send a test alert")
    ap.add_argument("--show", action="store_true", help="run with a visible browser")
    a = ap.parse_args()
    cfg = load_json(ROOT / "config.json", None) or load_json(ROOT / "config.example.json", {})
    if not a.test and not single_instance():
        print("Another watcher is already running.")
        return 1
    if a.login and do_login() != 0:
        return 1
    if a.test:
        alert(cfg, "Top Hat watcher test", "If you see/hear this, alerts work.", LOBBY)
        time.sleep(4)
        return 0
    while True:
        try:
            watch(cfg, a.show)
        except (KeyboardInterrupt, SystemExit):
            return 0
        except Exception as e:
            log(f"watcher crashed: {e!r}; restarting in 30s")
            time.sleep(30)


if __name__ == "__main__":
    sys.exit(main())
