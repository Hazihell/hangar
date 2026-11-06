# Rebuilt screens: screens.html

One standalone HTML page that holds every state of the flow at once. The renderer drops it into a browser window on the video canvas and plays the storyboard's actions on it. Example: `../examples/card-support-assistant/screens.html`.

## Rules

- **Static.** No `<script>`, no `<link>`, no images from the network. Inline SVG for logos and icons. Scripts are stripped.
- **Fonts.** Use `Inter` (or another HyperFrames bundled font: Roboto, Open Sans, Lato, Poppins, Montserrat, Nunito, Outfit, JetBrains Mono). Other families fall back.
- **Layout at `app_size`.** Lay the page out to fill exactly that size (`body` as a flex column with the main area `flex: 1`). The renderer scales it to the window; nothing scrolls by itself.
- **Root rules.** Put the app's colour tokens on `:root` and page styles on `body`; the renderer scopes both to the app box. Do not style `html` for layout.
- **Every id the storyboard names must exist** in the page; a missing one is skipped with a console warning.

## Attributes the renderer reads

| Attribute | On | Meaning |
|---|---|---|
| `id="…"` | Anything an action targets | Referenced from `storyboard.json` |
| `data-fv-hidden` | Elements that appear later (messages, results, the new value of a `swap`, a typing indicator) | Starts invisible, still takes its space |
| `data-fv-scroll` | A scrolling area, such as a chat log | Its first child holds the items; `show` on an item scrolls that child up so the item is visible |

Use these names exactly: HyperFrames reserves some `data-*` names (`data-hidden`, `data-start`, `data-duration`), and using them hides or re-times elements.

## Patterns

**Chat log.** `<div id="chat" data-fv-scroll><div id="stack">…messages, each data-fv-hidden…</div><div id="typing" data-fv-hidden>…</div></div>`. Give the typing indicator `position: absolute` at the bottom of `#chat` so it does not push messages. Put the stack at the top (`justify-content: flex-start`).

**A value that changes.** `<span class="swap"><strong id="limit-old">$5,000.00</strong><strong id="limit-new" data-fv-hidden>$8,000.00</strong></span>`, with the new value `position: absolute` over the old one.

**Another page of the app.** Two sibling containers of the same size, the second `data-fv-hidden` and `position: absolute; inset: 0`; `hide` the first and `show` the second.

**A form being filled.** Replace the `<input>` with a `div` styled like it (`position: relative`), holding the placeholder in one span and the typed text in a `<span id="…" data-fv-hidden>` laid over it with `position: absolute; inset: 0; display: flex; align-items: center; padding: inherit`. `hide` the placeholder and `type` the text. Without the overlay, the hidden placeholder keeps its space and pushes the typed text to the right.

## Capturing the real app (preferred for tutorials)

Rendering the real app beats rewriting it. Run it against demo or seeded data (never a real customer account), dump each page after its scripts ran (`google-chrome --headless=new --window-size=<app_size> --virtual-time-budget=6000 --dump-dom <url>`, which keeps drawn diagrams), then make each dump static: remove scripts and links, inline the CSS and images as data URIs, and add the ids and `data-fv-*` attributes. Put each page in its own `position: absolute; inset: 0; isolation: isolate` wrapper with a rising `z-index`, the later ones `data-fv-hidden`, and map the CSS's `body` rules to the wrapper and `100vh` to `100%`.

## Fidelity

Copy the layout, labels and copy from the real app (its code or a DOM dump). The screens may simplify (fewer list items, no unrelated menus) but must not show buttons, numbers or results the product does not have: viewers will look for them. Use realistic sample data, never real customer names or emails.
