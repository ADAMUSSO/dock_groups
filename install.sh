#!/bin/bash
# Installs Dock Groups as a symlink into the user extensions directory.
set -e
UUID=dock-groups@adam
SRC="$(cd "$(dirname "$0")/$UUID" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
glib-compile-schemas "$SRC/schemas"
mkdir -p "$(dirname "$DEST")"
ln -sfn "$SRC" "$DEST"
echo "Installed to $DEST"
echo "On Wayland, log out and back in, then run:  gnome-extensions enable $UUID"
