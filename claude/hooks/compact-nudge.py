#!/usr/bin/env python3
"""UserPromptSubmit hook: past a context size, tell the agent it may compact itself.

An agent cannot see how full its context is, so the automatic compact lands
wherever the work happens to be. Inside T3 an agent can compact its own thread
by sending `/compact` to it, so this hook tells it the size once it passes the
threshold and leaves the moment to the agent. Silent below the threshold and
outside T3.

Usage: compact-nudge.py [threshold_tokens]   (default 200000)
"""
import json
import os
import sys

TAIL_BYTES = 3_000_000
AUTO_COMPACT_MARGIN = 30_000  # observed: a 300K window compacted at 267K-279K


def context_tokens(transcript_path):
    """Size of the context at the last model call since the last compact."""
    try:
        with open(transcript_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - TAIL_BYTES))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return 0
    for line in reversed(lines):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("subtype") == "compact_boundary":
            return 0
        if row.get("type") != "assistant" or row.get("isSidechain"):
            continue
        usage = (row.get("message") or {}).get("usage") or {}
        total = sum(
            usage.get(k) or 0
            for k in (
                "input_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
                "output_tokens",
            )
        )
        if total:
            return total
    return 0


def auto_compact_at():
    try:
        with open(os.path.expanduser("~/.claude/settings.json")) as f:
            window = int(json.load(f).get("autoCompactWindow"))
    except (OSError, ValueError, TypeError):
        return None
    return window - AUTO_COMPACT_MARGIN


def main():
    threshold = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
    if not os.environ.get("T3CODE_CLI_PATH"):
        return
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return
    size = context_tokens(event.get("transcript_path") or "")
    if size < threshold:
        return
    limit = auto_compact_at()
    where = f"near {limit // 1000}K" if limit else "when it fills"
    note = (
        f"Your context is at {size // 1000}K tokens and compacts by itself {where}, "
        "wherever the work is then. You can choose the moment instead: read "
        "your thread id fresh, as `currentThreadId` in `t3_thread_list` (an id "
        "you remember may be another thread's), and send `/compact` to it with "
        "`t3_thread_send`, mode `queue`. It runs when this turn ends, and these "
        "notes stop once it has. Text after `/compact` says what to keep. To compact "
        "before work that will not fit, queue `/compact`, then queue the request "
        "itself, and end the turn. Leave it alone if you report to a parent "
        "agent: the compact would replace your report."
    )
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": note,
                }
            }
        )
    )


if __name__ == "__main__":
    main()
