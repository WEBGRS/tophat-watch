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


def evt(event, payload=None):
    return frame({"type": "message", "data": {"auth": False, "event": event, "payload": payload or {}}})


def item(event, id_, name, status, module="question"):
    return evt(event, {"display_name": name, "id": id_, "module_id": module, "status": status,
                       "last_activated_at": None if status in ("inactive", "preview") else "2026-10-01T15:33:48+0000"})


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
    # Lifecycle noise (real event names): must stay silent
    for ev in ("show_course_info", "close_course_info", "patch:tree{1}", "close_attendance"):
        ws.send(evt(ev))
    ws.send(evt("general_location_update", {"attendance_id": "9", "attended": True}))
    ws.send(item("course:module_item:create", 500, "Push Only Q", "inactive"))
    ws.send(item("course:module_item:update", 500, "Push Only Q", "preview"))
    page.wait_for_timeout(4500)
    ws.send(item("course:module_item:update", 500, "Push Only Q", "active_visible"))   # 1: opened
    page.wait_for_timeout(4500)
    ws.send(item("course:module_item:update", 500, "Push Only Q", "active_visible"))   # repeat: silent
    page.wait_for_timeout(4500)
    ws.send(item("course:module_item:update", 500, "Push Only Q", "visible"))          # closed: silent
    page.wait_for_timeout(4500)
    ws.send(item("course:module_item:update", 500, "Push Only Q", "active_visible"))   # 2: reopened
    page.wait_for_timeout(9000)
    # Backchannel module item + classmate posts: must stay silent
    ws.send(item("course:module_item:update", 600, "Lecture Backchannel", "active_visible", "discussion"))
    page.wait_for_timeout(4500)
    ws.send(item("course:module_item:update", 42, "Pick the recurrence", "active_visible"))  # push deduped by DOM
    page.evaluate("addQ()")                                                  # 3: question (DOM)
    page.wait_for_timeout(5000)
    ws.send(frame({"type": "item", "data": {"event": "published"}}))         # unknown push: silent
    page.evaluate("addM()")                                                  # 4: new material (DOM)
    page.wait_for_timeout(5000)
    page.evaluate("addD()")
    for ev in ("discussion:response:added", "discussion:response:updated"):
        ws.send(evt(ev, {"discussion": 77}))
    page.wait_for_timeout(5000)
    page.evaluate("setP('Lecture 5 - Poll 2')")                              # 5: presenting changed
    page.wait_for_timeout(5000)
    notes = sw.evaluate("self.__notes")
    log = sw.evaluate("chrome.storage.local.get('pushLog').then(v => v.pushLog.map(p => p.type + '/' + p.event + (p.warmup ? ' warmup' : '')))")
    ctx.close()

print("pushLog:", log)
for n in notes:
    print("NOTE:", n)
expect = ["Top Hat opened", "Top Hat opened", "Top Hat question", "Top Hat new item", "Top Hat presenting"]
ok = len(notes) == len(expect) and all(n.startswith(e) for n, e in zip(notes, expect))
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
