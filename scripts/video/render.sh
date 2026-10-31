#!/usr/bin/env bash
# `make video`: render docs/demo.tape with VHS against a live local sandbox,
# then write docs/media/demo.mp4 (H.264, <= 25 MB) and docs/media/demo.gif.
#
# The tape runs in a throw-away clone of this repository (HEAD, plus the
# working-copy tape and scene helper), so the recording shows no local paths;
# the clone reuses this repository's target/ (built here first) and gets its
# own `npm ci`. Nothing leaves the machine: no account, no testnet, no upload
# (never `vhs publish`).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAX_SECONDS="${VIDEO_MAX_SECONDS:-180}"
MAX_MP4_BYTES=$((25 * 1024 * 1024))

for tool in vhs ttyd ffmpeg ffprobe git node make; do
  command -v "$tool" >/dev/null 2>&1 || { echo "make video needs '$tool' (macOS: brew install vhs, which brings ttyd and ffmpeg)"; exit 1; }
done

WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/allowance-video.XXXXXX")" && pwd -P)"
cleanup() {
  # Anything the tape left running in the clone (it stops the demo itself).
  pkill -INT -f "$WORK/allowance/" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "[video] building the contracts and the sandbox host (log: $WORK/build.log)"
if ! make -C "$REPO" build sandbox-node node_modules > "$WORK/build.log" 2>&1; then
  tail -n 40 "$WORK/build.log"; exit 1
fi

echo "[video] fresh clone in $WORK/allowance"
git clone -q "$REPO" "$WORK/allowance"
cd "$WORK/allowance"
ln -s "$REPO/target" target
cp "$REPO/docs/demo.tape" docs/demo.tape
mkdir -p scripts/video docs/media
cp "$REPO/scripts/video/scene.ts" scripts/video/scene.ts
npm ci --prefer-offline --no-audit --no-fund --loglevel=error >/dev/null

echo "[video] recording (about 3 minutes)"
vhs -q docs/demo.tape

RAW=docs/media/demo.mp4
duration="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RAW")"
echo "[video] raw recording: ${duration}s, $(wc -c < "$RAW" | tr -d ' ') bytes"
if ! awk -v d="$duration" -v m="$MAX_SECONDS" 'BEGIN { exit (d <= m) ? 0 : 1 }'; then
  echo "[video] the video is longer than ${MAX_SECONDS}s: shorten the Sleeps in docs/demo.tape"; exit 1
fi

# MP4 for the X post: H.264 + yuv420p + faststart; re-encode harder if it is too big.
ffmpeg -v error -y -i "$RAW" -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart -an "$WORK/demo.mp4"
if [ "$(wc -c < "$WORK/demo.mp4")" -gt "$MAX_MP4_BYTES" ]; then
  ffmpeg -v error -y -i "$RAW" -c:v libx264 -preset slow -crf 32 -pix_fmt yuv420p -movflags +faststart -an "$WORK/demo.mp4"
fi

# GIF for the README: 8 fps, 960 px wide, one palette for the whole video
# (colours come out paler than in the MP4: the text's anti-aliasing takes
# most of the palette).
ffmpeg -v error -y -i "$WORK/demo.mp4" \
  -vf "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 "$WORK/demo.gif"

mkdir -p "$REPO/docs/media"
cp "$WORK/demo.mp4" "$WORK/demo.gif" "$REPO/docs/media/"
for f in "$REPO/docs/media/demo.mp4" "$REPO/docs/media/demo.gif"; do
  d="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"
  echo "[video] ${f#"$REPO"/}: ${d}s, $(wc -c < "$f" | tr -d ' ') bytes"
done
