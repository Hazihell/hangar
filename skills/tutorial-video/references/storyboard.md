# storyboard.json

One file per video, beside `screens.html`. Full example: `../examples/card-support-assistant/storyboard.json`.

```json
{
  "title": "How to raise your card limit",
  "voice": "am_michael",
  "device": "browser",
  "app_size": [1152, 720],
  "url": "app.example.com/support",
  "beats": [
    {"id": "greet", "do": [{"at": 0.4, "show": "m-greet"}]},
    {"id": "limit", "do": [{"at": 0.3, "click": "chip-limit"}, {"at": 1.4, "show": "m-u1"},
                           {"at": 1.8, "flash": "typing", "for": 1.0}, {"at": 2.8, "show": "m-offer"}]}
  ],
  "narration": {"greet": "…", "limit": "…"}
}
```

| Field | Meaning |
|---|---|
| `voice` | Kokoro voice; its prefix sets the pronunciation. English: `am_michael` (US male, default), `af_heart` (US female), `bm_george` (UK male), `bf_emma` (UK female). Brazilian Portuguese: `pf_dora` (female), `pm_alex` (male), `pm_santa` (male) |
| `device` | `browser` (16:10 window, captions below) or `phone` (phone on the left, captions on the right) |
| `app_size` | The CSS size the screens are laid out at. `[1152, 720]` for web apps (text reads well at 1080p), `[390, 844]` for phones |
| `url` | Text in the browser's address pill |
| `beats` | The flow, in order. Each beat lasts as long as its narration or its actions, whichever is longer. Add `"still": false` to skip its screenshot |
| `narration` | One line per beat id. A beat without a line plays silent |

## Actions

Each action has `at`, seconds from the start of its beat, and one verb whose value is an element id in the screens.

| Verb | Effect | Takes |
|---|---|---|
| `show` | Fades and lifts the element in. Inside a `data-fv-scroll` area it scrolls so the element is visible | 0.4 s |
| `hide` | Fades the element out | 0.3 s |
| `click` | The cursor glides to the element and clicks it; the element dims for a moment | 1.1 s |
| `flash` | Shows the element for `for` seconds, then hides it (a typing indicator) | `for` |
| `type` | Reveals the element left to right in `for` seconds, like typing (put the text in a span) | `for` |
| `swap` | `["old-id", "new-id"]`: crossfades a value (a limit, a status) | 0.45 s |

Leave about 1 second between a `click` and what it causes, so the click reads before the result. A user message shows about 1.1 s after the click on the button that sends it, and the reply about 1 s after the typing indicator starts.
