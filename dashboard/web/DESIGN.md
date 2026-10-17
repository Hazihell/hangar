---
name: Hangar Dashboard
description: A strip-chart recorder per Machine: current reading at the pen, 24 h trace behind it on real chart paper.
colors:
  chart-paper: "oklch(0.955 0.007 160)"
  chart-paper-night: "oklch(0.165 0.008 170)"
  sheet: "oklch(0.993 0.003 160)"
  sheet-night: "oklch(0.205 0.009 170)"
  graphite: "oklch(0.24 0.012 240)"
  graphite-night: "oklch(0.93 0.006 160)"
  pencil-grey: "oklch(0.48 0.014 220)"
  pencil-grey-night: "oklch(0.71 0.014 165)"
  hairline: "oklch(0.875 0.012 160)"
  hairline-night: "oklch(0.3 0.012 170)"
  grid-ink: "oklch(0.885 0.03 160)"
  grid-ink-night: "oklch(0.285 0.018 165)"
  ink-cpu: "oklch(0.5 0.17 266)"
  ink-cpu-night: "oklch(0.74 0.12 266)"
  ink-ram: "oklch(0.5 0.15 312)"
  ink-ram-night: "oklch(0.74 0.12 312)"
  ink-disk: "oklch(0.5 0.09 182)"
  ink-disk-night: "oklch(0.76 0.09 182)"
  online-green: "oklch(0.56 0.14 152)"
  online-green-night: "oklch(0.77 0.15 152)"
  high-ochre: "oklch(0.53 0.12 68)"
  high-ochre-night: "oklch(0.82 0.13 78)"
  full-red: "oklch(0.54 0.2 27)"
  full-red-night: "oklch(0.7 0.18 25)"
  focus-ring: "oklch(0.55 0.12 265)"
typography:
  verdict:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.012em"
  machine-name:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  reading:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 88"
    fontFeature: "'tnum'"
  body:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
  axis:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 400
    fontFeature: "'tnum'"
rounded:
  sm: "0.3rem"
  md: "0.4rem"
  lg: "0.5rem"
  xl: "0.7rem"
  pen: "9999px"
spacing:
  sheet-gap: "1rem"
  sheet-gap-wide: "1.5rem"
  sheet-pad: "1.25rem"
  sheet-pad-wide: "1.5rem"
  channel-gap: "1rem"
  section-gap: "1.25rem"
components:
  sheet-online:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.xl}"
    padding: "20px 24px"
  sheet-offline:
    backgroundColor: "transparent"
    textColor: "{colors.pencil-grey}"
    rounded: "{rounded.xl}"
    padding: "20px 24px"
  reading-ok:
    textColor: "{colors.graphite}"
    typography: "{typography.reading}"
  reading-high:
    textColor: "{colors.high-ochre}"
    typography: "{typography.reading}"
  reading-full:
    textColor: "{colors.full-red}"
    typography: "{typography.reading}"
  drive-meter-track:
    backgroundColor: "{colors.grid-ink}"
    rounded: "{rounded.pen}"
    height: "6px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.graphite}"
    rounded: "{rounded.lg}"
    height: "36px"
  app-meter-track:
    backgroundColor: "{colors.grid-ink}"
    rounded: "{rounded.pen}"
    height: "3px"
    width: "max 10rem"
  minute-panel:
    backgroundColor: "{colors.chart-paper}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.lg}"
    padding: "10px 14px 12px"
---

# Design System: Hangar Dashboard

## Overview

**Creative North Star: "The Chart Recorder"**

Every Machine is a sheet from a strip-chart recorder. The pen rests at the current reading, and the last 24 hours trace out behind it on chart paper whose grid is the real scale: a column every 3 hours, a row every 25 %. The page answers one question, "is everything OK?", with a verdict sentence at display size, then lets each sheet confirm it.

The ground is cool green-grey paper with graphite text. Grid ink is printed only where a trace runs, never as page decoration. Each channel has its own pen ink (CPU blue, RAM violet, Disk teal-green). Red is reserved for readings past 90 %; ochre marks "high" (80 % and over). Everything else stays quiet, so a single red number or a hollow pen is noticed without reading. The system follows the OS light/dark setting; there is no toggle.

Archivo is the only family. Words use normal width; readings use the width axis at 88 % with tabular figures so live numbers don't jitter.

**Key Characteristics:**
- Chart-paper ground, hairline-edged flat sheets, no glass, no gradients, no glow.
- One pen ink per channel; one reserved red; one ochre.
- State is always in words as well as color (Online/Offline, "nearly full", Running/Stopped).
- Big readings (2rem) beside their trace; labels small and grey.
- The pen dot sits at the trace's live end; an Offline pen is lifted (hollow).

## Colors

Cool green-tinted neutrals (hue 160-170) with three pen inks at one lightness, and two alarm inks. Light-mode values are listed first; the `-night` tokens are the dark-mode counterparts, lighter and slightly less chromatic so the same hue reads on dark paper.

### Primary
- **Graphite** (`graphite`, `graphite-night`): body text, readings, the verdict, and the solid button fill. Slightly blue-cool, never pure black.

### Secondary (pen inks)
- **CPU Blue** (`ink-cpu`): CPU trace, its pen dot, the text-selection tint, and App share meters while Apps are sorted by CPU.
- **RAM Violet** (`ink-ram`): RAM trace and pen dot, and App share meters while sorted by RAM.
- **Disk Teal-Green** (`ink-disk`): Disk trace, and the drive meter fill while a drive is below 80 %.

### Tertiary (state inks)
- **Online Green** (`online-green`): the filled pen dot for Online, the Live connection dot, T3 Running, a Connected VPN.
- **High Ochre** (`high-ochre`): 80-89 % readings, trace and drive meter; T3 stopped; reconnecting; stale-notice border. High is not a verdict issue.
- **Full Red** (`full-red`): 90 % and over only: the reading, its trace and pen, the drive meter, and the numeral inside the verdict sentence. Also the destructive token: the message of a command that failed (VPN, Quit, Alerts) and the tinted Force quit confirmation.

### Neutral
- **Chart Paper** (`chart-paper`): page ground.
- **Sheet** (`sheet`): the Online Machine's card fill. Offline sheets are transparent, letting the paper show through.
- **Pencil Grey** (`pencil-grey`): labels, detail lines, OS name, footer note, Offline text.
- **Hairline** (`hairline`): card ring and separators.
- **Grid Ink** (`grid-ink`): the trace grid and the empty drive-meter and App-meter tracks.
- **Focus Ring** (`focus-ring`): 2px outline, 2px offset, on every focusable element.

### Named Rules
**The Reserved Red Rule.** Red appears only for readings at 90 % or more (and the matching verdict numeral), for a failed command's message (VPN, Quit, Alerts), and for the confirming button of Force quit, the one action that can lose work. Offline, stopped, reconnecting, Disconnected, a command under way, Quit, "Quitting…", Protected and Alerts blocked are never red.

**The Printed-Where-It-Runs Rule.** Grid ink exists only inside a trace or a drive track. It is never a page background or texture.

**The Words-Too Rule.** No state is carried by color alone; pair it with a word or a filled/hollow shape.

## Typography

**Display Font:** Archivo Variable (ui-sans-serif, system-ui fallback), with the width axis available.
**Body Font:** Archivo Variable, normal width.
**Label/Mono Font:** none. Code samples fall back to the platform monospace at 0.9em.

**Character:** One grotesque in two widths: ordinary width for language, semi-condensed (88 %) tabular for instrument readings, so numbers look like pen counters.

### Hierarchy
- **Verdict** (600, 1.75rem phone / 2.25rem from 40rem, 1.15, -0.012em, max 28ch, balanced): the one h1 sentence. Word-spacing +0.06em.
- **Machine name** (600, 1.25rem, 1.25, -0.01em): sheet h2.
- **Reading** (600, 2rem, 1.05, width 88 %, tabular, -0.01em): CPU/RAM/Disk percentages. Colored by level.
- **Issue list** (400, 1.0625rem): secondary lines under the verdict; also the unreachable explanation.
- **Body** (400-500, 0.9375rem): status line, service row, brand name (600).
- **Label** (500, 0.8125rem, Pencil Grey): channel names and "x of y GB" detail (tabular); drive rows at 0.875rem.
- **Axis** (400, 0.6875rem, tabular, Pencil Grey): time ticks on the Disk trace only: every 6 hours plus "now". Also the trace's hover label.
- **List** (400, 0.9375rem App names, 0.875rem figures and Process names, tabular figures; counts, PIDs and notes 0.75-0.8125rem Pencil Grey): the Apps list and a minute's Top Apps. The figures of the column being sorted by are Graphite, the other Pencil Grey.

### Named Rules
**The Two Widths Rule.** Readings use the 88 % width with tabular figures; words stay at normal width. Do not mix.

**The One Sentence Rule.** The page has one display-size line and it is a complete sentence about the state of the Machines.

## Layout

A single page, max width 78rem, centered, 1rem side padding on phone and 2rem from 40rem. Order: a thin header (Hangar mark left, connection state right), the verdict, a `sheets` grid, then a footer note explaining Online and the grid. Vertical gaps are 2rem on phone, 2.5rem wider.

The sheet grid is `repeat(auto-fill, minmax(min(100%, 30rem), 1fr))` with 1rem gaps (1.5rem from 40rem), top-aligned so sheets of unequal height do not stretch. That gives one column on a phone, two on a laptop, three on wide screens.

Inside a sheet: header (name and OS on one baseline, status line beneath), a hairline, then channel rows (and, under them, a picked minute's Top Apps), an optional two-column drive list (one column on phone), one dashed rule over what runs on the Machine: the service row, then a row per VPN, and a last dashed rule over the Apps section, folded by default. Channel rows are a two-column grid: reading column 6.75rem on phone, 8rem from 40rem, trace filling the rest. Sheet padding is 1.25rem, 1.5rem from 40rem; channels sit 1rem apart; sections 1.25rem apart. Safe-area insets are respected top and bottom. Legible at 390px.

## Elevation & Depth

Flat, with tonal layering: the lighter Sheet over the Chart Paper, edged by a 1px hairline ring. An Offline sheet drops its fill entirely and keeps only the ring, so it recedes. In dark mode there is no shadow at all. No glass, glow, or gradient.

The only motion is 200 ms ease-out on value changes (meter width, sheet color on Online/Offline change, a disclosure chevron turning), the 2.4 s breathing dot of something under way, and a 700 ms focus-ring outline that rings a sheet for under 2 s when an Alert or a `#machine` link brings you to it. Traces themselves do not animate.

Popovers (the Alerts control) float: Sheet fill, hairline ring, a soft shadow in light mode. Nothing else floats.

### Named Rules
**The Flat Sheet Rule.** A sheet is a hairline-ringed rectangle. Depth is told by fill (Sheet vs. paper vs. transparent), not by shadow.

## Shapes

Soft but not round: sheets use the 0.7rem radius (`xl`), buttons and the empty-state panel 0.5rem, the connection and pen dots are full circles, and drive meters are 6px full-round pills. Borders are 1px hairlines; separators between a sheet's header and body are full-bleed hairlines; the service row uses a dashed top rule. Pen dots are 10px (service and connection dots 8px): filled when live, a 1.5px hollow ring when lifted or not connected.

## Components

### Sheet (Machine)
- **Character:** a recorder page for one Machine.
- **Online:** Sheet fill, hairline ring. **Offline:** transparent, same ring; reading text goes Pencil Grey, traces drop to 50 % stroke and 5 % fill, pen dot turns hollow, meters go grey, and the status line says "Offline · Last seen 2 hours ago".
- The Offline trace stops at Last seen; the rest of the 24 h paper stays blank (a gap, not interpolation).

### Trace (channel)
- 24 h of History, 1.5px monotone line, 9 % ink fill (5 % for Disk), vertical grid every 3 h, horizontal rules at 0/25/50/75/100 %, domain fixed 0-100. Height 3.75rem, or 5rem on the Disk trace that carries the time axis.
- The pen: 3.5px-radius filled dot at the last point; hollow with 60 % ink ring when Offline. The trace takes Ochre or Red ink when the level is high or full.
- The trace is also the way into History: hover (or drag a finger along it) and a dotted rule crosses all three traces at that minute, with a small label on the trace under the pointer: clock time, the channel's value, and "Click for Top Apps". Each 10-minute point stands for its busiest minute in that channel, so hovering a flat-looking stretch reveals a spike the averaging hid. Click or tap pins the minute: a solid Graphite rule at 55 % across all three traces, and the Top Apps panel opens beneath them. Clicking the pinned minute again unpins it.
- Keyboard: each trace is a slider (Tab to it; arrows step 10 minutes, Shift or Page keys an hour, Home/End the ends; Enter opens or closes that minute's Top Apps; Escape closes). Cursor is a crosshair. The footer says it in one sentence.

### Drive row
- Name left, "used of total" plus percentage right (percentage in level color), a 6px meter beneath. Fill is Disk teal-green below 80 %, ochre to 89 %, red from 90 %. Track is Grid Ink.

### Service row
- "T3 service" label and a dot with "Running" or "Stopped" (ochre, medium weight). Preceded by a dashed rule.

### VPN row
- Sits under the same dashed rule as the service row, 1rem apart. Left: the VPN's name (500) followed by "VPN" in Pencil Grey, and beneath it an 0.875rem status line: an 8px dot and the word. Connected is a filled Online Green dot; Disconnected a 1.5px hollow ring in Pencil Grey; Connecting/Disconnecting (reported by the Machine itself) a grey dot that breathes.
- Right: one outline button, 36px tall with a 44px hit area, at a fixed 8.75rem width so its label can change without the row moving. It reads **Disconnect** when Connected and **Connect** when Disconnected, with the VPN's name for screen readers only.
- Under way (a command pending, or the Machine reporting a transition): the button goes dashed and Pencil Grey, reads "Connecting…" / "Disconnecting…", and carries a breathing 8px dot in the ink of where it is heading (Online Green for connect, grey for disconnect). It turns busy the moment it is pressed, before the server answers. Breathing is a 2.4 s opacity cycle and stops under reduced motion. A PC connect can take 40 s, so nothing about this state is ochre or red.
- A failed command leaves one 0.8125rem Full Red line spanning the row: "Couldn't connect." (500) then the message. It stays until the next command.
- Offline: last known state, the dot greyed, the button at half strength and disabled (still focusable). Disabled too while the server can't be reached. A Machine with no VPNs shows no row and no heading.

### Confirmation dialog
- Disconnect asks first; Connect doesn't. shadcn Base UI AlertDialog on the Sheet fill, 0.7rem radius, hairline ring, over a flat graphite veil (no blur). Title at 1.125rem/600, a question naming both: "Disconnect Steeprock on MacBook Air?"; one sentence of consequence beneath; left-aligned at every width. Footer: Cancel (outline, takes first focus) and Disconnect (solid graphite, never red); stacked full width on phones with Disconnect on top. Focus returns to the row's button. If the VPN stops being Connected or a command starts elsewhere while it is open, it closes; if the Machine goes Offline or the server can't be reached, it stays, the Disconnect button disables, and a Pencil Grey line says why.

### Top Apps of a minute
- Under the channels, full width, a Chart Paper panel (0.5rem radius, hairline ring) with a notch on its top edge pointing up at the pinned minute in the trace column: a cut from the chart.
- Header: "Top Apps at 21:27" (500) and "· 4 hours ago" in Pencil Grey, with "CPU 95 % · RAM 29 % that minute" beneath; a ghost close button (44px hit area).
- Rows as in the Apps list (name | CPU | RAM, share meter under the name), "in WSL" in Pencil Grey after Apps inside WSL. Sorted by the channel it was picked on (RAM for the RAM trace, else CPU), the meter showing each App's part of what the Machine used that minute.
- Loading: three skeleton bars. Empty: "No Apps were recorded in this minute." Not kept: "No Top Apps were kept for this minute." Error: "Couldn't load this minute's Top Apps." with an outline Try again.

### Apps
- The last section of a sheet, under its own dashed rule; hidden when the Machine hasn't sent Processes. Folded by default, remembered per Machine in this browser. Folded, it is one 44px row: chevron, "Apps" (500), and at the right the two Apps using the most CPU in Pencil Grey ("WSL 22 %, chrome 6 %").
- Open, the same row carries the column heads CPU and RAM, which are the sort toggle (pressed one Graphite 500 with a small down arrow; default CPU). Ten Apps, each a 44px disclosure row: chevron, name, "×14" count in Pencil Grey, CPU and RAM right-aligned and tabular; beneath the name a 3px share meter (max 10rem) on a Grid Ink track, in the sorted channel's ink, showing the App's part of what the Machine is using (CPU in use, or RAM used). Real scale would leave most meters empty; this is "who is using it".
- An App opens into an indented panel with a hairline on its left. Its Processes: PID (Pencil Grey, 0.75rem), name, CPU, RAM and an action column; on a phone the figures move to a second line ("PID 5121 · 4 % CPU · 462 MB") so names keep their width. Under them "and 20 more Processes, using less" when the list is cut, then a line: how many Processes, and an outline "Quit chrome" button for the whole App. The `WSL` App opens into "Apps inside WSL", the same rows one level deeper, each opening to its Processes.
- Offline: last known Apps in Pencil Grey, meters grey, Quit disabled (still focusable), like the VPN rows.

**The Hold-Still Rule.** Live lists don't shuffle under a finger. Rows re-sort only when one App clearly overtakes the one above it (15 % more and past noise), and not at all while the pointer is over the list, focus is in it, or a confirmation is open. Changing the sort re-sorts at once.

### Quit
- A Process's Quit is a quiet ghost text button in its action column; an App's is the outline "Quit {name}" button in its panel. Processes the Dashboard may not quit show "Protected" in 0.75rem Pencil Grey (with a tooltip saying why); an App none of whose Processes may be quit says so in one Pencil Grey line instead of a button: "Protected: it isn't yours, or {Machine} or the Dashboard depends on it, so it can't be quit from here."
- After confirming: "Quitting…" with a breathing 6px grey dot, in place of the button (and "· quitting…" after the App's name). When the Process leaves the reports, its row simply goes. If a report still lists it 10 s after the server said `sent`, or the server answered `failed`, the button comes back as an outline **Force quit**. An App quit can reach Processes beyond the 20 listed: it stays "Quitting…" the full 10 s, then offers Force quit if any of them is still listed, or if the App is still listed while some weren't. Force quit sends exactly the Processes the server answered for (PID and start time), never ones looked up again.
- Outcomes are said on the row, 0.8125rem: `failed` in Full Red ("Couldn't quit. {Windows' message}"); `changed` and `protected` in Pencil Grey ("Not quit: PID 5121 now belongs to another Process."); `gone` says nothing. An App's line counts them ("Couldn't quit 2 of 8 Processes. …").

### Quit dialogs
- Every Quit and Force quit asks first, in the same AlertDialog as Disconnect. Title names what and where: "Quit node on Stormtrooper (WSL)?". One sentence says what it uses and what Quit does: "It's using 61 % CPU and 1.2 GB. Quit asks it to close cleanly, as closing its window would." For an App: "Its 14 Processes are using …". The figures stay live while it's open.
- Force quit: "Force quit node on Stormtrooper (WSL)?" and "Quit didn't close it. Force quit ends it at once, without asking: anything unsaved in node is lost." Its confirming button is the destructive tint (Full Red on a red wash), the only red action on the page; Quit's is solid Graphite.
- If what it's about goes away while open, the dialog closes. Offline or an unreachable server keeps it open with the button disabled and a Pencil Grey line: "{why} Nothing can be quit until that changes."

### Alerts control
- In the header, left of the connection state, the same quiet 0.875rem Pencil Grey: a bell-off icon and "Alerts off". One click asks the browser for permission and turns Alerts on; it becomes a bell and "Alerts on" in Graphite. "Turning on…" breathes while it works.
- "Alerts on" opens a popover: "Alerts are on in this browser", one sentence on what sends an Alert, and two buttons: outline "Send a test" and ghost "Turn off". A sent test says "Test sent. It should arrive in a few seconds." in Pencil Grey.
- Anything in the way is explained in the same popover rather than in an error state: "Alerts blocked" (how to allow notifications again, with Try again), no Web Push in this browser, the plain-http address (Alerts need https), or a failure (Full Red line, Try again). "Alerts on" is only said once the server has the subscription: if renewing it on load fails, the control says "Alerts off" and the popover gives the reason with Try again. "Turn off" says off if the server forgot this browser or the browser unsubscribed; if neither worked, it stays on with the reason in Full Red.

### Verdict
- h1 sentence naming the worst issue first (nearly full before stopped before Offline). Further issues are a list of linked lines, each with a dot (red or hollow pen), linking to the sheet. A stale connection lowers the verdict to 60 % opacity. Healthy: "Both Machines are Online. Nothing needs attention."

### Connection state
- Quiet 0.875rem Pencil Grey text with a dot: green Live, ochre Reconnecting, hollow Not connected, faint grey Connecting.

### Buttons and notices
- shadcn Base UI button, 0.5rem radius, 36px height at `lg`. Outline on the page: "Try again now" / "Try again" when the server is unreachable, each VPN row's Connect/Disconnect, an App's Quit, and Force quit. Quieter still, as ghost text: a Process's Quit, the Alerts control, a panel's close. The solid graphite fill appears only as the confirming action inside a dialog (the Force quit dialog's is the destructive tint). Every small control keeps a 44px hit area. The stale notice is an Alert with an ochre-tinted border on the Sheet fill.

### Loading and empty
- Skeletons mirror the sheet layout. A Machine with no Usage shows a miniature ruled grid panel with the sentence "No Usage yet: this Machine hasn't reported."

## Do's and Don'ts

### Do:
- **Do** put the verdict sentence first and let sheets confirm it.
- **Do** color a reading, its trace, and its pen together by level: ink, ochre from 80 %, red from 90 %.
- **Do** say state in words next to the dot or color.
- **Do** keep the trace axis the real scale: 24 h across, 0-100 % up, grid every 3 h and 25 %.
- **Do** use the 88 % width with tabular figures for every live number.
- **Do** keep Offline sheets legible but receding: transparent fill, Pencil Grey, hollow pen.
- **Do** use the `sheets` grid and a 2px focus ring on every interactive element.
- **Do** fold what's only sometimes needed (Apps, a minute's Top Apps) and let one tap open it.
- **Do** keep live lists still while someone is pointing at them (the Hold-Still Rule).

### Don't:
- **Don't** build a stat-tile admin grid: badge, KPI tile, decorative sparkline.
- **Don't** use red for anything below 90 % or for Offline, stopped, or reconnecting.
- **Don't** print grid ink as a page background, or add gradients, glass, or glow.
- **Don't** add a theme toggle; follow the system setting.
- **Don't** add a primary action to the page. The only actions are Retry for an unreachable server, each VPN row's Connect/Disconnect, Quit and Force quit inside the Apps section, and the Alerts control, all outline or quieter.
- **Don't** make a disconnect or Quit button or confirmation red; disconnecting a VPN or quitting an App is a choice, not an alarm. Only Force quit's confirmation is red-tinted, because it can lose work.
- **Don't** Quit or Force quit without asking, and don't offer Force quit before Quit has failed or been ignored.
- **Don't** interpolate across an Offline gap in a trace.
- **Don't** use the Machine terms host, node, device, stats, or health in copy; use Machine, Usage, Online, Offline, Last seen, History. Say Process, App, Top Apps, Quit, Force quit and Alert, never kill, terminate, task or alarm. ("node" in copy is only ever the name of a Process.)
