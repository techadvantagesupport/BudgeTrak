#!/usr/bin/env bash
# Resize images so longest edge ≤ MAX (default 1800px).
# Usage: resize-for-agents.sh <src-dir> <dst-dir> [MAX]
# Copies smaller images unchanged; scales oversize images via ImageMagick.
set -euo pipefail

SRC=${1:?src dir required}
DST=${2:?dst dir required}
MAX=${3:-1800}

mkdir -p "$DST"
shopt -s nullglob nocaseglob

count_copied=0
count_resized=0
for f in "$SRC"/*.{jpg,jpeg,png,webp}; do
  name=$(basename "$f")
  dims=$(magick identify -format '%w %h' "$f" 2>/dev/null) || { echo "  SKIP (identify failed): $name"; continue; }
  w=${dims%% *}
  h=${dims##* }
  if [ "$w" -gt "$MAX" ] || [ "$h" -gt "$MAX" ]; then
    magick "$f" -resize "${MAX}x${MAX}>" -quality 90 "$DST/$name"
    count_resized=$((count_resized + 1))
    new_dims=$(magick identify -format '%wx%h' "$DST/$name")
    printf '  resized  %s  %dx%d → %s\n' "$name" "$w" "$h" "$new_dims"
  else
    cp "$f" "$DST/$name"
    count_copied=$((count_copied + 1))
  fi
done

echo ""
echo "Done. Copied: $count_copied | Resized: $count_resized | Max edge: ${MAX}px"
