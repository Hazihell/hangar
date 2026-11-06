---
name: tutorial-video
description: >
  Make a short narrated tutorial video that shows a user going through a flow in a web or
  mobile app: rebuilds the app's screens as one static HTML page (from the code or a DOM dump
  of the running app), animates a cursor clicking through them, voices the narration locally
  and renders video.mp4 plus one screenshot per step with HyperFrames. Use when asked for a
  tutorial video, how-to video, walkthrough video or demo video of the platform.
---

# Tutorial video

Produce `video.mp4` and `screenshots/NN-<step>.png` for one flow. The video is 16:9, 1080p, narrated with burned-in captions, and looks like a screen recording of someone using the app inside a browser window (or a phone for mobile apps). Aim for 20 to 90 seconds; split longer tutorials into several videos.

Nothing is recorded live: the screens are rebuilt as HTML and animated, so the video is deterministic, re-renders in seconds after a wording change, and never shows a real account.

Worked example: `examples/card-support-assistant/` (a fictional bank's support chat). Read its `storyboard.json` and `screens.html` before writing your own.

## 0. Setup (once per machine)

`bash <skill-dir>/scripts/setup.sh`. It checks Node 22+ and ffmpeg, installs the local Kokoro voice into `~/.cache/tutorial-video/venv`, downloads the voice model and turns off HyperFrames' usage reporting. If it fails, stop and tell the user what is missing.

## 1. Inputs

Ask the user, unless already given:

- which flow to teach, from where the user starts to the result they get
- where the screens come from: the app's front-end code, a URL of the app running locally against demo data, or screenshots
- who watches it (new customers, admins, internal team), which sets the tone

Work in a folder outside the repo's tracked files, for example `tutorial-videos/<slug>/` (add it to `.gitignore`).

## 2. Storyboard

Split the flow into 3 to 8 steps (beats): what the user sees, what they click, what the app does back. One action and its result per beat. Write `storyboard.json` following `references/storyboard.md`.

## 3. Rebuild the screens

Write `screens.html`: one static page that holds every state the flow needs, following `references/screens.md`.

- If the app runs locally, dump its real pages (see *Capturing the real app* in `references/screens.md`). Otherwise read its UI code (components, templates, styles) and copy the real layout, labels, colours and copy.
- **Show only what the product does.** No invented buttons, numbers or screens. Sample data (names, amounts) is fine and should look realistic; never use a real customer's data.
- No JavaScript and no network: everything is in the page. Elements that appear later are in the page from the start with `data-fv-hidden`.

## 4. Narration

One short block per beat, about 140 words per minute, written as instructions to the viewer ("Click Save. The report appears on the right."). Name buttons as they appear on screen. No ellipses or symbols the voice would read out. Narrate in the language of the app's screens: English and Brazilian Portuguese have voices (list in `references/storyboard.md`). Captions wrap at about 80 characters and a third line runs off the frame, so keep each line under about 160 characters; Portuguese runs longer than English, so split a long pt-BR line across two beats.

## 5. Render

```sh
python3 <skill-dir>/scripts/render_video.py tutorial-videos/<slug> --out tutorial-videos/<slug>/out
```

It voices every line, renders the video and saves one screenshot per beat. The bundled 35-second example rendered in about 33 seconds on a laptop; the voice is cached, so re-renders skip that step for unchanged lines. Add `--keep` to keep the HyperFrames project in `<src>/build/video/` (open it with `npx hyperframes preview` to inspect it). Exit code `0` means rendered, `1` means something failed (the JSON report says what).

## 6. Check

Look at every screenshot, then at two or three frames of the video (`ffmpeg -ss <t> -i video.mp4 -frames:v 1 frame.png`) to confirm the cursor lands on the right element and the screens change as the narration says. Fix timings in `storyboard.json` and re-render.

## Report

The voice used, the video length and render time, the output paths, and any step you dropped or simplified.
