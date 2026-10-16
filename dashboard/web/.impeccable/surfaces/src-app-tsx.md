# Surface: the Dashboard (dashboard/web, src/App.tsx)

Mode: Operate. One page, every Machine. Audience: Roger, glancing from an Android phone or the MacBook, asking "is everything OK?". Success: calm when all is well; an Offline Machine, a nearly-full disk or RAM, or a stopped T3 service is noticed without reading. Constraints: shadcn/ui on Base UI + shadcn charts (Recharts), no bespoke canvas; follows prefers-color-scheme; red only when genuinely bad; no dense admin feel; legible at 390 px. Live via SSE (API.md).

## Direction contract

THESIS: Each Machine is a strip-chart recorder: the pen rests at the current reading and its 24 h trace runs behind it on chart paper whose grid is the real time axis. Refuses the stat-tile admin grid (badge + KPI tiles + decorative sparkline).

OWN-WORLD: Chart-paper ground, cool green-grey grid ink printed only where a trace runs, graphite text, one pen ink per channel (CPU blue, RAM violet, Disk teal-green), a single reserved red ink past 90 %, ochre for "high". Archivo with its width axis: semi-condensed tabular figures for readings, normal width for words. Flat sheets with a hairline edge; no glass, no gradients, no glow.

STORY: A verdict line says whether anything needs attention; each sheet confirms it: Online pen dot or lifted pen with Last seen; readings; traces; drives as ruled rows; T3 service state. Roger reads, closes the tab.

FIRST VIEWPORT: Top: small "Hangar" mark, live-connection state at right, then the verdict sentence at display size. Below: one sheet per Machine (one column on phone, two on laptop, three on wide). Sheet head: Machine name large, Online/Offline line under it. Body: CPU, RAM, Disk channels, each a big reading beside (desktop) or above (phone) its 24 h trace; drive rows; service row. No primary action; Retry appears only when the server is unreachable.

FORM: Chart Recorder, position 4 of 7 on the grounded list, seed key ac2fe6da. Signature interaction: the pen dot sits at the trace's live end and moves with each SSE minute update; an Offline trace stops at Last seen and the rest of the 24 h paper stays blank. Motion: 200 ms ease-out on value changes only.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
