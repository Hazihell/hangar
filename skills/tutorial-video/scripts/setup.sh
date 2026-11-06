#!/usr/bin/env bash
# One-time setup for the tutorial-video skill: checks Node 22+ and ffmpeg, installs the local
# Kokoro voice into its own virtualenv, and downloads the voice model so the first real run is fast.
set -euo pipefail
VENV="${TUTORIAL_VIDEO_VENV:-$HOME/.cache/tutorial-video/venv}"
export HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_NO_UPDATE_CHECK=1

node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null \
  || { echo "Node.js 22+ is required (https://nodejs.org)"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required (macOS: brew install ffmpeg; Arch: pacman -S ffmpeg; Debian: apt install ffmpeg)"; exit 1; }

if ! "$VENV/bin/python" -c "import kokoro_onnx, soundfile" 2>/dev/null; then
  rm -rf "$VENV"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q kokoro-onnx soundfile
fi

# HyperFrames reports usage by default; turn it off for every hyperframes command on this machine.
npx --yes hyperframes@0.8.221 telemetry disable >/dev/null

tmp="$(mktemp -d)"
(cd "$tmp" && HYPERFRAMES_PYTHON="$VENV/bin/python" npx --yes hyperframes@0.8.221 tts "Ready to go." -v am_michael -o "$tmp/ready.wav" --json >/dev/null)
rm -rf "$tmp"
echo "tutorial-video ready (voice venv: $VENV)"
