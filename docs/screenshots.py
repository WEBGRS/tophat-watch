# Regenerate README screenshots against a mock Top Hat Classroom page
import shutil, tempfile, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs"
URL = "https://app.tophat.com/e/123456/lecture"

MOCK = """<!doctype html><meta charset="utf-8"><title>CS 101 Demo - Classroom | Top Hat</title>
<style>body{margin:0;font:15px system-ui,sans-serif;background:#f4f5f7;color:#1f2937}
header{background:#fff;border-bottom:1px solid #e5e7eb;padding:14px 24px;font-weight:600}
header span{color:#6b7280;font-weight:400}main{max-width:640px;margin:24px auto;padding:0 16px}
section{background:#fff;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:16px}
h2{font-size:14px;margin:0;padding:12px 16px;border-bottom:1px solid #e5e7eb}
ul{list-style:none;margin:0;padding:0;min-height:8px}section>ul>li:not(:has(.list-row)){padding:12px 16px}li .list-row{display:flex;gap:10px;padding:12px 16px;align-items:center}
.tag{font-size:12px;padding:2px 8px;border-radius:10px;background:#fef3c7;color:#92400e}
.sub{color:#6b7280;font-size:13px}</style>
<header>Top Hat <span>/ <span class="BreadcrumbCurrent-x">CS 101 Demo</span></span></header>
<main>
<section class="StudentContentTreestyles__Section-a"><h2 class="StudentContentTreestyles__SectionTitle-a">Presenting</h2>
<ul class="StudentContentTreestyles__SectionList-a"><li>Lecture 5 - Dynamic Programming</li></ul></section>
<section class="StudentContentTreestyles__Section-b"><h2 class="StudentContentTreestyles__SectionTitle-b">Questions &amp; Attendance</h2>
<ul class="StudentContentTreestyles__SectionList-b" id="q"></ul></section>
</main>
<script>
setTimeout(() => document.getElementById('q').innerHTML =
  `<li><div class="list-row list-row--unanswered" data-click-id="tree item 42">
     <div><div data-click-id="tree item 42 details title">Which recurrence gives the LIS in O(n log n)?</div>
     <div class="sub" data-click-id="tree item 42 details subtext">Multiple choice</div></div>
     <span class="tag" id="label-item-42">Unanswered</span></div></li>`, 2500);
</script>"""

tmp = pathlib.Path(tempfile.mkdtemp())
ext = tmp / "ext"
shutil.copytree(ROOT / "extension", ext)
(ext / "local.json").unlink(missing_ok=True)

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(str(tmp / "profile"), headless=True, channel="chromium",
        device_scale_factor=2, args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"])
    ctx.route("https://ntfy.sh/**", lambda r: r.abort())
    ctx.route("https://app.tophat.com/**", lambda r: r.fulfill(status=200, content_type="text/html", body=MOCK))
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    ext_id = sw.url.split("/")[2]
    # Capture notifications fired by the extension
    sw.evaluate("""() => { self.__notes = []; const orig = chrome.notifications.create.bind(chrome.notifications);
      chrome.notifications.create = (...a) => { self.__notes.push(a[a.length - 1]); return orig(...a); }; }""")

    page = ctx.new_page()
    page.set_viewport_size({"width": 760, "height": 380})
    page.goto(URL)
    page.wait_for_selector("#tophat-watch-pill")
    page.wait_for_selector(".list-row--unanswered")
    page.wait_for_timeout(2500)
    page.screenshot(path=str(OUT / "classroom.png"))
    print("notifications:", sw.evaluate("self.__notes"))

    pop = ctx.new_page()
    pop.set_viewport_size({"width": 314, "height": 100})
    pop.goto(f"chrome-extension://{ext_id}/popup.html")
    pop.wait_for_timeout(1000)
    pop.screenshot(path=str(OUT / "popup.png"), full_page=True)
    ctx.close()
print("saved to", OUT)
