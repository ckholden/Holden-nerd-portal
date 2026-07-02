#!/bin/bash
# Keeps hoscad-board/cadview in lockstep with the canonical orfireems board.
# The two are meant to be byte-identical (see the IS_SCMC branch in
# index.html) -- this is a plain copy, never a merge. Run this after every
# edit to this board, then commit+push BOTH Holden-nerd-portal and
# hoscad-board.
set -e
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/index.html"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../hoscad-board/cadview/index.html"

mkdir -p "$(dirname "$DEST")"
cp "$SRC" "$DEST"
echo "Synced $SRC -> $DEST"
echo "Remember to commit+push both Holden-nerd-portal and hoscad-board."
