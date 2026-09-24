# tophat-watch

Alerts you when a Top Hat question or attendance session goes live, so you don't miss it.

A headless Chrome (Playwright) keeps each course's **Classroom** tab (`/e/<id>/lecture`) open and scans it every 2 s. When something shows up under *Questions & Attendance* you get:

- a Windows toast plus an alarm sound
- a push to your phone through [ntfy](https://ntfy.sh) (priority 5, which breaks through Do Not Disturb)

## Chrome extension (recommended)

`extension/` runs inside your everyday Chrome and watches whatever Top Hat course tabs you already have open. There are no course codes to enter.

- Install: open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `extension` folder.
- Use: open a course's **Classroom** tab (`app.tophat.com/e/<id>/lecture`) and leave it open. A pill in the bottom-left corner shows the state: green means watching, amber means you are on a non-Classroom page (only Top Hat's own new-question toast is visible there), and grey means paused.
- Pause and resume from the pill, the toolbar popup, or **Alt+Shift+W**. Watching is on by default.
- Alerts fire only for items that still need you: questions that are open and unanswered, and attendance you have not checked in to yet. Items marked `list-row--answered`, "Answered", or "Closed", and attendance once "You have been marked present" shows, are skipped. An item that becomes pending again alerts again.
- Alert channels: a Chrome notification that stays until you dismiss it, a beep, and an ntfy push (set the topic in the popup, or in a gitignored `extension/local.json` as `{"ntfyTopic": "..."}`). Clicking the notification jumps to the tab.

## Python version

Setup for the standalone Python watcher. It runs its own headless Chrome (about 1.4 GB of RAM).

### Setup

1. **Config:** copy `config.example.json` to `config.json` and set `ntfy_topic` to a long random string (anyone who knows the topic can read the pushes).
2. **Phone:** install the *ntfy* app and subscribe to that topic.
3. **First login:** `python watch.py --login` opens Chrome. Sign in with NetID and Duo. When the course list appears, the window closes and watching starts. The session is kept in `profile/`.
4. **On/off:** run `toggle.ps1` (a desktop shortcut to it works well). It stops by itself after 3 h. `install-task.ps1` would register autostart at logon; it is not installed.

### Commands

| Command | What it does |
|---|---|
| `python watch.py --test` | sends a test alert (toast, sound, and phone) |
| `python watch.py` | starts watching (headless) |
| `python watch.py --show` | starts watching with a visible browser |
| `start.ps1` / `stop.ps1` | starts or stops it in the background |

### Detection

- Primary: any `<li>` under the *Questions & Attendance* section of the Classroom tab. Checked against the live DOM on 2026-09-22; the empty state is an empty `<ul>`.
- Fallback: the "No questions or attendance sessions are being presented" text disappears, the new-question toast (`#tophat.new-question-item-notification`), an unanswered-count badge increase, or an auto-opened question form. These selectors come from open-source notifiers (twangodev/tophat-bot, AndrewW-coder/TopHatNotifier, CSNBS/TopHat-Tracker).
- "Presenting started" sends a quiet notice when slides go up.
- Login expiry sends a quiet notice telling you to run `--login` again.

### Files

- `logs/watch-YYYYMMDD.log`: alerts and errors
- `logs/ws-YYYYMMDD.log`: raw WebSocket frames, kept for tuning detection if Top Hat changes its UI
- `status.json`: heartbeat, written every poll
- `seen.json`: IDs that have already alerted
