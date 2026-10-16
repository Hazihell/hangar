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
- **CPU Blue** (`ink-cpu`): CPU trace, its pen dot, and the text-selection tint.
- **RAM Violet** (`ink-ram`): RAM trace and pen dot.
- **Disk Teal-Green** (`ink-disk`): Disk trace, and the drive meter fill while a drive is below 80 %.

### Tertiary (state inks)
- **Online Green** (`online-green`): the filled pen dot for Online, the Live connection dot, T3 Running.
- **High Ochre** (`high-ochre`): 80-89 % readings, trace and drive meter; T3 stopped; reconnecting; stale-notice border. High is not a verdict issue.
- **Full Red** (`full-red`): 90 % and over only: the reading, its trace and pen, the drive meter, and the numeral inside the verdict sentence. Also the destructive token.

### Neutral
- **Chart Paper** (`chart-paper`): page ground.
- **Sheet** (`sheet`): the Online Machine's card fill. Offline sheets are transparent, letting the paper show through.
- **Pencil Grey** (`pencil-grey`): labels, detail lines, OS name, footer note, Offline text.
- **Hairline** (`hairline`): card ring and separators.
- **Grid Ink** (`grid-ink`): the trace grid and the empty drive-meter track.
- **Focus Ring** (`focus-ring`): 2px outline, 2px offset, on every focusable element.

### Named Rules
**The Reserved Red Rule.** Red appears only for readings at 90 % or more (and the matching verdict numeral). Offline, stopped and reconnecting are never red.

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
- **Axis** (400, 0.6875rem, tabular, Pencil Grey): time ticks on the Disk trace only: every 6 hours plus "now".

### Named Rules
**The Two Widths Rule.** Readings use the 88 % width with tabular figures; words stay at normal width. Do not mix.

**The One Sentence Rule.** The page has one display-size line and it is a complete sentence about the state of the Machines.

## Layout

A single page, max width 78rem, centered, 1rem side padding on phone and 2rem from 40rem. Order: a thin header (Hangar mark left, connection state right), the verdict, a `sheets` grid, then a footer note explaining Online and the grid. Vertical gaps are 2rem on phone, 2.5rem wider.

The sheet grid is `repeat(auto-fill, minmax(min(100%, 30rem), 1fr))` with 1rem gaps (1.5rem from 40rem), top-aligned so sheets of unequal height do not stretch. That gives one column on a phone, two on a laptop, three on wide screens.

Inside a sheet: header (name and OS on one baseline, status line beneath), a hairline, then channel rows, an optional two-column drive list (one column on phone), and a dashed-rule service row. Channel rows are a two-column grid: reading column 6.75rem on phone, 8rem from 40rem, trace filling the rest. Sheet padding is 1.25rem, 1.5rem from 40rem; channels sit 1rem apart; sections 1.25rem apart. Safe-area insets are respected top and bottom. Legible at 390px.

## Elevation & Depth

Flat, with tonal layering: the lighter Sheet over the Chart Paper, edged by a 1px hairline ring. An Offline sheet drops its fill entirely and keeps only the ring, so it recedes. In dark mode there is no shadow at all. No glass, glow, or gradient.

The only motion is 200 ms ease-out on value changes (meter width, sheet color on Online/Offline change); traces themselves do not animate.

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
- Hover shows a dotted cursor and a tooltip of clock time and value.

### Drive row
- Name left, "used of total" plus percentage right (percentage in level color), a 6px meter beneath. Fill is Disk teal-green below 80 %, ochre to 89 %, red from 90 %. Track is Grid Ink.

### Service row
- "T3 service" label and a dot with "Running" or "Stopped" (ochre, medium weight). Preceded by a dashed rule.

### Verdict
- h1 sentence naming the worst issue first (nearly full before stopped before Offline). Further issues are a list of linked lines, each with a dot (red or hollow pen), linking to the sheet. A stale connection lowers the verdict to 60 % opacity. Healthy: "Both Machines are Online. Nothing needs attention."

### Connection state
- Quiet 0.875rem Pencil Grey text with a dot: green Live, ochre Reconnecting, hollow Not connected, faint grey Connecting.

### Buttons and notices
- shadcn Base UI button, outline variant only in use, 0.5rem radius, 36px height at `lg`. Appears only as "Try again now" / "Try again" when the server is unreachable. The stale notice is an Alert with an ochre-tinted border on the Sheet fill.

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

### Don't:
- **Don't** build a stat-tile admin grid: badge, KPI tile, decorative sparkline.
- **Don't** use red for anything below 90 % or for Offline, stopped, or reconnecting.
- **Don't** print grid ink as a page background, or add gradients, glass, or glow.
- **Don't** add a theme toggle; follow the system setting.
- **Don't** add a primary action to the page; Retry exists only for an unreachable server.
- **Don't** interpolate across an Offline gap in a trace.
- **Don't** use the Machine terms host, node, device, stats, or health in copy; use Machine, Usage, Online, Offline, Last seen, History.
