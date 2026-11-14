# Models

You may start sub-agents whenever you judge they help, without being asked: this is the user's standing permission. A sub-agent inherits your model unless you name one, so name one from this list each time: the one whose strengths best fit the task. Cost decides only between models that fit it equally well. Start every sub-agent with full access: a stricter mode stops it at a prompt nobody answers.

There are two ways to start a sub-agent:

- **Your own sub-agent tool** runs the agent types defined only there. What it starts loses the host's tools once your turn ends.
- **A child thread of your host** keeps the host's tools while you are idle, starts sub-agents of its own, and can be continued after it reports.

| Model | Cost (Opus = 1) | Strengths |
| --- | --- | --- |
| `claude-fable-5-2` | 2 | The deepest thinker: advisor on hard decisions. The one with taste: work with no checkable right answer goes here (how something looks or feels, a new approach, a spread of distinct options). Judges when work is good enough to ship, so it lands a thread that keeps circling. Review its output with Opus. |
| `claude-opus-5-5` | 1 | Infers the intent behind a loose brief, and turns every stone: work with a checkable result goes here (a migration, a port, a repro, a review). Acts on every piece of feedback it gets, so give its brief a scope. |
| `claude-sonnet-5-5` | 0.5 | A scoped worker for a task with a clear path: a bug fix, a feature built against a spec. Where the path has to be found, it wanders and ends up costing more than Opus, so hard work goes to Opus even with a spec (a migration, a performance fix). Takes a brief literally, so spell out what Opus would infer. |
| `claude-haiku-5-5` | 0.025 | The fastest. Bulk pattern-matching: runs one well-defined check across every file or a pile of data, for a pattern grep cannot find. Code goes to a bigger model. Costs five times more once its prompt passes 100K tokens. |

# Evidence

A change that can be seen on screen is shown as a **before and after** pair: the same screen, state and size, once as shipped and once with the change working. Show the pair when you report the change done, and when you report sub-agents' work, show theirs.

Take the before shot first, as soon as you know a task will change what a screen shows, ahead of your first edit. Once the code changes, the shipped state is gone, and the screen or its data may be unreachable later. When you hand such a task to a sub-agent, its brief asks for the before shots first.

Shoot a single screen with T3's browser: `preview_resize` to the size, then `preview_snapshot` with `save=true`. Capture anything beyond one screen (many pages or entity IDs, a PDF, a multi-step flow, a login to reuse) with the `capture` skill: its `cap` command drives one warm browser from any shell, with 10 s timeouts and no dependency on the app repo.

In OLA, a user-facing change you report done to Roger also goes into the weekly update log, with its pair: follow "Logging a change" in `~/Dev/99x/ola-updates/README.md`.

# Long commands

A command that can run past a minute (a test run, a typecheck or build chain, a capture script) starts in the background and writes its output to a log file. Run it with `run_in_background` and wait with `t3_background_wait`, which returns the moment it exits. The foreground is for commands that finish in seconds.
