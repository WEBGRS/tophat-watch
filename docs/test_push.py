# End-to-end check: extension alerts on instructor pushes (mock Classroom page + mock WebSocket)
import json, shutil, sys, tempfile, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = "https://app.tophat.com/e/123456/lecture"

MOCK = """<!doctype html><meta charset="utf-8"><title>CS 101 Demo - Classroom | Top Hat</title>
<section class="StudentContentTreestyles__Section-a"><h2 class="StudentContentTreestyles__SectionTitle-a">Presenting</h2>
<ul class="StudentContentTreestyles__SectionList-a" id="p"><li>Lecture 5</li></ul></section>
<section class="StudentContentTreestyles__Section-b"><h2 class="StudentContentTreestyles__SectionTitle-b">Questions &amp; Attendance</h2>
<ul class="StudentContentTreestyles__SectionList-b" id="q"></ul></section>
<section class="StudentContentTreestyles__Section-c"><h2 class="StudentContentTreestyles__SectionTitle-c">Materials</h2>
<ul class="StudentContentTreestyles__SectionList-c" id="m"><li>Syllabus</li></ul></section>
<script>
new WebSocket('wss://app.tophat.com/sockjs/1/abc/websocket');
window.addQ = () => document.getElementById('q').innerHTML =
  `<li><div class="list-row list-row--unanswered" data-click-id="tree item 42">
   <div data-click-id="tree item 42 details title">Pick the recurrence</div>
   <div data-click-id="tree item 42 details subtext">Unanswered</div></div></li>`;
window.addM = () => document.getElementById('m').insertAdjacentHTML('beforeend', '<li>Worksheet 3</li>');
window.addD = () => document.getElementById('q').insertAdjacentHTML('beforeend',
  `<li><div class="list-row list-row--unanswered" data-click-id="tree item 77 container">
   <svg data-testid="DiscussionIcon"></svg>
   <span data-click-id="tree item 77 details title">Lecture Backchannel</span>
   <span id="label-item-77">current: discussion, Lecture Backchannel</span></div></li>`);
window.setP =t => document.getElementById('p').innerHTML = `<li>${t}</li>`;
</script>"""


def frame(obj):
    return "a" + json.dumps([json.dumps(obj)])


tmp = pathlib.Path(tempfile.mkdtemp())
ext = tmp / "ext"
shutil.copytree(ROOT / "extension", ext)
(ext / "local.json").unlink(missing_ok=True)
socks = []

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(str(tmp / "profile"), headless=True, channel="chromium",
        args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"])
    ctx.route("https://ntfy.sh/**", lambda r: r.abort())
    ctx.route("https://app.tophat.com/**", lambda r: r.fulfill(status=200, content_type="text/html", body=MOCK))

    def on_ws(ws):
        socks.append(ws)
        ws.send("o")
        ws.send(frame({"type": "register-ok"}))
        ws.send(frame({"type": "meta", "data": {"auth": True, "event": "authorize"}}))
        ws.send(frame({"type": "state", "data": {"event": "snapshot"}}))  # warmup
    ctx.route_web_socket("wss://app.tophat.com/**", on_ws)

    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    sw.evaluate("""() => { self.__notes = []; const orig = chrome.notifications.create.bind(chrome.notifications);
      chrome.notifications.create = (...a) => { self.__notes.push(a[a.length - 1].title + ' | ' + a[a.length - 1].message); return orig(...a); }; }""")

    page = ctx.new_page()
    page.goto(URL)
    page.wait_for_selector("#tophat-watch-pill")
    page.wait_for_timeout(9000)
    ws = socks[0]
    ws.send("h")
    ws.send(frame({"type": "pong", "data": {"timestamp": 1}}))
    ws.send(frame({"type": "slide", "data": {"event": "changed"}}))          # 1: generic push alert
    page.wait_for_timeout(4500)
    ws.send(frame({"type": "slide", "data": {"event": "changed"}}))          # cooldown: silent
    page.wait_for_timeout(4500)
    ws.send(frame({"type": "item", "data": {"event": "opened"}}))            # 2: question (push deduped)
    page.evaluate("addQ()")
    page.wait_for_timeout(5000)
    ws.send(frame({"type": "item", "data": {"event": "published"}}))         # 3: new material (push deduped)
    page.evaluate("addM()")
    page.wait_for_timeout(5000)
    # Discussion item + classmate posts (real frame shape): must stay silent
    page.evaluate("addD()")
    for ev in ("discussion:response:added", "discussion:response:updated"):
        ws.send(frame({"type": "message", "data": {"auth": False, "event": ev, "payload": {"discussion": 77}}}))
    page.wait_for_timeout(5000)
    page.evaluate("setP('Lecture 5 - Poll 2')")                              # 4: presenting changed
    page.wait_for_timeout(5000)
    notes = sw.evaluate("self.__notes")
    log = sw.evaluate("chrome.storage.local.get('pushLog').then(v => v.pushLog.map(p => p.type + '/' + p.event + (p.warmup ? ' warmup' : '')))")
    ctx.close()

print("pushLog:", log)
for n in notes:
    print("NOTE:", n)
expect = ["Top Hat push", "Top Hat question", "Top Hat new item", "Top Hat presenting"]
ok = len(notes) == len(expect) and all(n.startswith(e) for n, e in zip(notes, expect))
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
