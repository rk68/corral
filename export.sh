#!/bin/sh
# Copies the live Herdr config into this repo. Only my own mods: the app ships and updates the others.
set -eu
SRC="${HERDR_HOME:-$HOME/.config/herdr-app}"
DEST="$(cd "$(dirname "$0")" && pwd)"
MODS="agent-flow agent-plans contributions herdr-md my-files pr-diff pr-stack usage"
EXCLUDE="--exclude node_modules --exclude gpui-kit.d.ts --exclude .cache --exclude .DS_Store --exclude *.log"

for m in $MODS; do
  rsync -a --delete $EXCLUDE "$SRC/mods/$m/" "$DEST/mods/$m/"
done
rsync -a --delete --exclude .state --exclude .DS_Store "$SRC/layouts/" "$DEST/layouts/"
rsync -a --delete --exclude .DS_Store "$SRC/themes/" "$DEST/themes/"
cp "$SRC/keys.json" "$SRC/settings.json" "$DEST/"
mkdir -p "$DEST/claude"
cp "$HOME/.claude/statusline-usage.sh" "$DEST/claude/"
rsync -a --delete --exclude .DS_Store "$HOME/.config/herdr-core/templates/" "$DEST/herdr-core/templates/"
echo "Exported. Check git diff for anything private before you commit."
