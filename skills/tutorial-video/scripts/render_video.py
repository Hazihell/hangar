"""Render a narrated tutorial video from rebuilt app screens and a storyboard.

Usage:
    python3 render_video.py <src-dir> --out <out-dir> [--keep]

<src-dir> holds storyboard.json and screens.html (see ../references/). The script:
  1. voices every narration line with HyperFrames' local Kokoro voice (cached)
  2. writes a HyperFrames project: the screens in a browser window (or phone), a cursor, captions
  3. renders <out-dir>/video.mp4, plus screenshots/NN-<beat>.png (one per beat)

It prints a JSON report and exits 0 when the video rendered, 1 on any failure.
"""

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
HYPERFRAMES = "hyperframes@0.8.221"
VENV = Path(os.environ.get("TUTORIAL_VIDEO_VENV", Path.home() / ".cache" / "tutorial-video" / "venv"))
# No usage reports, and no update checks: the version above is pinned.
os.environ.update(HYPERFRAMES_NO_TELEMETRY="1", HYPERFRAMES_NO_UPDATE_CHECK="1")

LEAD_IN, TAIL, MIN_BEAT = 0.3, 0.5, 2.0
ACTION_LENGTH = {"click": 1.1, "show": 0.4, "hide": 0.3, "swap": 0.45, "flash": None, "type": None}

# Browser frame geometry on the 1920x1080 canvas; the screen sits under a 46 px toolbar.
BX, BY, BW, BAR, BSH = 272, 44, 1376, 46, 860
# Phone geometry: the phone on the left, captions on the right.
PH, PBEZEL = 940, 16


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}, indent=2))
    sys.exit(1)


def run(cmd, cwd=None, env=None):
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)


def ffprobe_duration(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(out.stdout.strip())


# ---------- 1. voice ----------

def tts(text, voice, cache):
    key = hashlib.sha1(f"{voice}|{text}".encode()).hexdigest()[:16]
    out = cache / f"{key}.wav"
    if not out.exists():
        env = dict(os.environ)
        if (VENV / "bin" / "python").exists():
            env["HYPERFRAMES_PYTHON"] = str(VENV / "bin" / "python")
        res = run(["npx", "--yes", HYPERFRAMES, "tts", text, "-v", voice, "-o", str(out), "--json"], cwd=cache, env=env)
        if res.returncode != 0 or not out.exists():
            fail(f"tts failed for {text[:60]!r}: {res.stderr[-600:] or res.stdout[-600:]}. Run scripts/setup.sh first.")
    return out


# ---------- 2. composition ----------

def split_app(page):
    """Return (css, body_html) from a standalone screen page; scripts and external links are dropped."""
    css = "\n".join(re.findall(r"<style[^>]*>(.*?)</style>", page, flags=re.S | re.I))
    body = re.search(r"<body[^>]*>(.*)</body>", page, flags=re.S | re.I)
    body = body.group(1) if body else page
    body = re.sub(r"<script.*?</script>", "", body, flags=re.S | re.I)
    # Scope the page's root rules to the app box, so they don't restyle the video canvas.
    css = css.replace(":root", ".fv-app")
    css = re.sub(r"(^|[}\s,;])(html|body)(?=[\s,{:.#\[>*])", r"\1.fv-app", css)
    return css, body


def action_end(action):
    kind = next(k for k in ACTION_LENGTH if k in action)
    length = ACTION_LENGTH[kind]
    if length is None:
        length = float(action.get("for", 1.0))
    return float(action["at"]) + length


def plan(board, voice_cache):
    """Beats with start, length and voice clip."""
    texts = board.get("narration", {})
    voice = board.get("voice", "am_michael")
    beats = [{"id": b["id"], "actions": b.get("do", []), "still": b.get("still", True)} for b in board["beats"]]
    t = 0.0
    for b in beats:
        text = texts.get(b["id"], "")
        b["text"] = text
        b["wav"] = tts(text, voice, voice_cache) if text else None
        b["vo"] = round(ffprobe_duration(b["wav"]), 3) if b["wav"] else 0.0
        need = max([action_end(a) + 0.8 for a in b["actions"]] + [b["vo"] + LEAD_IN + TAIL, MIN_BEAT])
        if b is beats[-1]:
            need += 1.0  # hold the last screen a moment after the narration ends
        b["start"], b["dur"] = round(t, 3), round(need, 3)
        t += need
    return beats, round(t, 3)


def geometry(board):
    aw, ah = board.get("app_size", [1152, 720])
    if board.get("device", "browser") == "phone":
        sh = PH - 2 * PBEZEL
        k = sh / ah
        sw = round(aw * k)
        pw = sw + 2 * PBEZEL
        px = 640 - pw // 2
        py = (1080 - PH) // 2
        return {"device": "phone", "k": k, "aw": aw, "ah": ah, "frame": (px, py, pw, PH),
                "screen": (px + PBEZEL, py + PBEZEL, sw, sh)}
    k = min(BW / aw, BSH / ah)
    sw, sh = round(aw * k), round(ah * k)
    sx = BX + (BW - sw) // 2
    sy = BY + BAR + (BSH - sh) // 2
    return {"device": "browser", "k": k, "aw": aw, "ah": ah, "frame": (BX, BY, BW, BAR + BSH), "screen": (sx, sy, sw, sh)}


CANVAS_CSS = """
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 1920px; height: 1080px; overflow: hidden; background: #f3f4f6; }
#root { position: relative; width: 1920px; height: 1080px; overflow: hidden; font-family: "Inter", sans-serif; }
.bg { position: absolute; inset: 0; }
.frame { position: absolute; overflow: hidden; }
.browser { border-radius: 18px; border: 2px solid rgba(17,24,39,.14); background: #fff;
  box-shadow: 0 40px 90px rgba(17,24,39,.25), 0 8px 24px rgba(17,24,39,.10); }
.bar { height: 46px; display: flex; align-items: center; gap: 18px; padding: 0 20px; background: #f3f4f6; border-bottom: 1px solid #e5e7eb; }
.dots { display: flex; gap: 9px; } .dots i { width: 12px; height: 12px; border-radius: 50%; background: #d1d5db; display: block; }
.pill { margin: 0 auto; transform: translateX(-36px); padding: 5px 26px; border-radius: 999px; background: #fff;
  border: 1px solid #e5e7eb; color: #4b5563; font: 500 17px "JetBrains Mono", monospace; }
.phone { border-radius: 64px; background: #111827; box-shadow: 0 40px 90px rgba(0,0,0,.35), inset 0 0 0 2px #374151; }
.notch { position: absolute; z-index: 5; top: 30px; left: 50%; width: 120px; height: 32px; margin-left: -60px; border-radius: 999px; background: #111827; }
.screen { position: absolute; overflow: hidden; background: #fff; }
.phone .screen { border-radius: 48px; }
.cursor { position: absolute; left: 0; top: 0; width: 34px; height: 34px; z-index: 20; }
.cap { position: absolute; color: #111827; font-size: 34px; line-height: 1.3; }
.cap.below { left: 160px; right: 160px; top: 975px; text-align: center; }
.cap.side { left: 1060px; right: 120px; top: 380px; font-size: 44px; line-height: 1.3; font-weight: 700; letter-spacing: -.01em; }
.fv-app { position: relative; }
.fv-app [data-fv-scroll] { position: relative; overflow: hidden; }
"""

CURSOR = ('<svg viewBox="0 0 24 24" width="34" height="34"><path d="M3 2l7.5 19 2.6-7.4L21 11z" fill="#111827" '
          'stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>')

RUNTIME_JS = """
const tl = gsap.timeline({ paused: true });
const EVENTS = __EVENTS__;
const K = __K__, S0 = __S0__;
const rr = document.getElementById("root").getBoundingClientRect();
const cursor = document.getElementById("cursor");

// Measure every target before any tween moves layout.
const POS = {}, BOTTOM = {}, BOX = {};
for (const e of EVENTS) {
  for (const id of [].concat(e.target)) {
    const el = document.getElementById(id);
    if (!el) { console.warn("missing element #" + id); continue; }
    const r = el.getBoundingClientRect();
    POS[id] = { x: r.left - rr.left + r.width * 0.55, y: r.top - rr.top + r.height * 0.6 };
    BOTTOM[id] = el.offsetTop + el.offsetHeight;
  }
}
const scrollOf = new Map();
function scroller(el) { return el.closest("[data-fv-scroll]"); }

tl.fromTo(".frame", { opacity: 0, y: 60, scale: .96 }, { opacity: 1, y: 0, scale: 1, duration: .9, ease: "power3.out" }, S0);
document.querySelectorAll(".fv-app [data-fv-hidden]").forEach((el) => gsap.set(el, { opacity: 0 }));
document.querySelectorAll(".fv-app [data-fv-scroll]").forEach((el) => { if (el.firstElementChild) gsap.set(el.firstElementChild, { y: 0 }); });
if (cursor) gsap.set(cursor, { x: __PARK_X__, y: __PARK_Y__, scale: 1 });

for (const e of EVENTS) {
  const el = document.getElementById([].concat(e.target)[0]);
  if (!el) continue;
  if (e.kind === "show") {
    const box = scroller(el);
    if (box && box.firstElementChild) {
      const need = Math.max(0, BOTTOM[e.target] + 16 - box.clientHeight);
      if (need > (scrollOf.get(box) || 0)) {
        tl.to(box.firstElementChild, { y: -need, duration: .45, ease: "power2.out" }, e.t);
        scrollOf.set(box, need);
      }
    }
    tl.fromTo(el, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .3, ease: "power2.out" }, e.t);
  } else if (e.kind === "hide") {
    tl.to(el, { opacity: 0, duration: .25 }, e.t);
  } else if (e.kind === "flash") {
    tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: .15 }, e.t);
    tl.to(el, { opacity: 0, duration: .12 }, e.t + e.for - .12);
  } else if (e.kind === "type") {
    tl.fromTo(el, { opacity: 1, clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: e.for, ease: "steps(" + Math.max(4, Math.round(e.for * 14)) + ")" }, e.t);
  } else if (e.kind === "swap") {
    const b = document.getElementById(e.target[1]);
    tl.to(el, { opacity: 0, duration: .3 }, e.t);
    if (b) tl.fromTo(b, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .35, ease: "power2.out" }, e.t + .1);
  } else if (e.kind === "click" && cursor) {
    const box = scroller(el);
    const off = box ? (scrollOf.get(box) || 0) * K : 0;
    const p = POS[e.target];
    tl.to(cursor, { x: p.x, y: p.y - off, duration: .8, ease: "power2.inOut" }, e.t);
    tl.to(cursor, { scale: .82, duration: .1, ease: "power1.in" }, e.t + .85);
    tl.to(cursor, { scale: 1, duration: .14, ease: "power1.out" }, e.t + .95);
    tl.fromTo(el, { opacity: 1 }, { opacity: .55, duration: .1 }, e.t + .85);
    tl.to(el, { opacity: 1, duration: .2 }, e.t + .95);
  }
}
document.querySelectorAll(".cap").forEach((c) => {
  tl.fromTo(c, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: .4, ease: "power2.out" }, parseFloat(c.parentElement.dataset.start) + .1);
});
window.__timelines["main"] = tl;
tl.seek(0);
"""


def events_for(beats):
    events = []
    for b in beats:
        for a in b["actions"]:
            kind = next(k for k in ACTION_LENGTH if k in a)
            ev = {"t": round(b["start"] + float(a["at"]), 3), "kind": kind, "target": a[kind]}
            if kind in ("flash", "type"):
                ev["for"] = float(a.get("for", 1.0))
            events.append(ev)
    return sorted(events, key=lambda e: e["t"])


def composition(board, beats, total, app_page, geo):
    css, body = split_app(app_page)
    s0, s_dur = 0.0, total
    fx, fy, fw, fh = geo["frame"]
    sx, sy, sw, sh = geo["screen"]
    url = html.escape(board.get("url", "localhost"))
    app_box = (f'<div class="fv-app" style="width:{geo["aw"]}px;height:{geo["ah"]}px;overflow:hidden;'
               f'transform:scale({geo["k"]:.5f});transform-origin:0 0">{body}</div>')
    if geo["device"] == "phone":
        frame = (f'<div class="frame phone" style="left:{fx}px;top:{fy}px;width:{fw}px;height:{fh}px"><span class="notch"></span>'
                 f'<div class="screen" style="left:{PBEZEL}px;top:{PBEZEL}px;width:{sw}px;height:{sh}px">{app_box}</div></div>')
        cap_cls = "side"
    else:
        frame = (f'<div class="frame browser" style="left:{fx}px;top:{fy}px;width:{fw}px;height:{fh}px">'
                 f'<div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="pill" data-layout-ignore>{url}</span></div>'
                 f'<div class="screen" style="left:{sx - fx}px;top:{sy - fy}px;width:{sw}px;height:{sh}px">{app_box}</div></div>')
        cap_cls = "below"
    has_cursor = any("click" in a for b in beats for a in b["actions"])
    parts = ['<div class="bg" style="background:radial-gradient(90% 80% at 50% 20%, #ffffff 0%, #f3f4f6 55%, #e5e7eb 100%)"></div>',
             f'<div id="win" class="clip" data-start="{s0}" data-duration="{s_dur}" style="position:absolute;inset:0">{frame}'
             + (f'<div class="cursor" id="cursor">{CURSOR}</div>' if has_cursor else "") + "</div>"]
    for b in beats:
        if b["text"]:
            parts.append(f'<div id="cap-{b["id"]}" class="clip" data-start="{b["start"]}" data-duration="{b["dur"]}" '
                         f'style="position:absolute;inset:0;z-index:12"><p class="cap {cap_cls}">{html.escape(b["text"])}</p></div>')
    for b in beats:
        if b["wav"]:
            parts.append(f'<audio id="vo-{b["id"]}" src="assets/vo/{b["id"]}.wav" data-start="{round(b["start"] + LEAD_IN, 3)}" data-duration="{b["vo"]}"></audio>')
    park_x, park_y = (sx + sw // 2, sy + sh - 40)
    js = (RUNTIME_JS.replace("__EVENTS__", json.dumps(events_for(beats))).replace("__K__", f"{geo['k']:.5f}")
          .replace("__S0__", str(s0)).replace("__PARK_X__", str(park_x)).replace("__PARK_Y__", str(park_y)))
    return f"""<!doctype html>
<html lang="en" data-resolution="landscape">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1920, height=1080" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>{CANVAS_CSS}
{css}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="{total}" data-width="1920" data-height="1080">
{chr(10).join(parts)}
</div>
<script>{js}</script>
</body>
</html>
"""


def write_project(proj, page, beats):
    if proj.exists():
        shutil.rmtree(proj)
    (proj / "assets" / "vo").mkdir(parents=True)
    (proj / "compositions").mkdir()
    (proj / "hyperframes.json").write_text(json.dumps({"paths": {"blocks": "compositions", "components": "compositions/components", "assets": "assets"}}, indent=2))
    (proj / "meta.json").write_text(json.dumps({"id": "tutorial-video", "name": "tutorial-video"}))
    (proj / "index.html").write_text(page)
    for b in beats:
        if b["wav"]:
            shutil.copy(b["wav"], proj / "assets" / "vo" / f"{b['id']}.wav")


# ---------- 3. render and stills ----------

def render(proj, out_mp4):
    t0 = time.time()
    res = run(["npx", "--yes", HYPERFRAMES, "render", "-o", str(out_mp4)], cwd=proj)
    if res.returncode != 0 or not out_mp4.exists():
        return None, (res.stderr or res.stdout)[-1500:]
    return round(time.time() - t0, 1), None


def stills(mp4, beats, geo, folder):
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.png"):
        old.unlink()
    sx, sy, sw, sh = geo["screen"]
    saved = []
    n = 0
    for b in beats:
        if not b.get("still", True):
            continue
        n += 1
        path = folder / f"{n:02d}-{b['id']}.png"
        t = b["start"] + b["dur"] - 0.35
        run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", str(mp4), "-frames:v", "1",
             "-vf", f"crop={sw}:{sh}:{sx}:{sy}", str(path)])
        if path.exists():
            saved.append(str(path))
    return saved


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path)
    ap.add_argument("--out", type=Path, required=True, help="output folder: video.mp4 and screenshots/ go here")
    ap.add_argument("--keep", action="store_true", help="keep the HyperFrames project in <src>/build for editing")
    args = ap.parse_args()
    args.src, args.out = args.src.resolve(), args.out.resolve()

    for tool in ("npx", "ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            fail(f"{tool} not found. Run scripts/setup.sh.")
    for name in ("storyboard.json", "screens.html"):
        if not (args.src / name).exists():
            fail(f"{args.src / name} not found")
    board = json.loads((args.src / "storyboard.json").read_text())
    page = (args.src / "screens.html").read_text()
    build = args.src / "build"
    cache = build / "tts-cache"
    cache.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)
    geo = geometry(board)

    beats, total = plan(board, cache)
    proj = build / "video"
    write_project(proj, composition(board, beats, total, page, geo), beats)
    mp4 = args.out / "video.mp4"
    seconds, err = render(proj, mp4)
    if err:
        fail(f"render failed: {err}")
    shots = stills(mp4, beats, geo, args.out / "screenshots")
    if not args.keep:
        shutil.rmtree(proj, ignore_errors=True)
    print(json.dumps({"ok": True, "voice": board.get("voice", "am_michael"), "file": str(mp4), "seconds": total,
                      "render_seconds": seconds, "screenshots": shots}, indent=2))


if __name__ == "__main__":
    main()
