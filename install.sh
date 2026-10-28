#!/bin/bash
# Nainštaluje Dock Groups ako symlink do používateľských extensions.
set -e
UUID=dock-groups@adam
SRC="$(cd "$(dirname "$0")/$UUID" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
glib-compile-schemas "$SRC/schemas"
mkdir -p "$(dirname "$DEST")"
ln -sfn "$SRC" "$DEST"
echo "Nainštalované do $DEST"
echo "Na Waylande sa odhlás a prihlás, potom spusti:  gnome-extensions enable $UUID"
