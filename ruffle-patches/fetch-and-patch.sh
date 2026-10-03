#!/usr/bin/env bash
# Clones Ruffle at the pinned upstream commit and applies the patch series from this directory.
# Run from anywhere; the checkout lands in ruffle-src/ at the repository root (gitignored).
#
#   ./ruffle-patches/fetch-and-patch.sh
#
# Build instructions afterwards: see README.md next to this script.
set -euo pipefail

UPSTREAM="https://github.com/ruffle-rs/ruffle.git"
PIN="7fb3d255eb3824507f52911b811fe75392218017"

PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$PATCH_DIR/.." && pwd)"
SRC="$ROOT/ruffle-src"

if [ -e "$SRC" ]; then
    echo "$SRC already exists. Remove it first, or apply the patches by hand." >&2
    exit 1
fi

# Ruffle's history is large and we only need one commit plus the tree it points at.
echo "Cloning Ruffle at $PIN ..."
git init -q "$SRC"
git -C "$SRC" remote add origin "$UPSTREAM"
git -C "$SRC" fetch -q --depth 1 origin "$PIN"
git -C "$SRC" checkout -q FETCH_HEAD

# git am needs an identity even when it is only replaying someone else's patches.
git -C "$SRC" config user.name "ruffle-patches"
git -C "$SRC" config user.email "ruffle-patches@localhost"

count=$(ls -1 "$PATCH_DIR"/[0-9][0-9][0-9][0-9]-*.patch | wc -l | tr -d ' ')
echo "Applying $count patches ..."
git -C "$SRC" am "$PATCH_DIR"/[0-9][0-9][0-9][0-9]-*.patch

echo
echo "Done. $SRC is at:"
git -C "$SRC" log --oneline -1
echo
echo "Next:"
echo "  cd $SRC/web && npm install && npm run build"
echo "  cp -r $SRC/web/packages/selfhosted/dist/. $ROOT/server/webclient/ruffle-local/"
