#!/usr/bin/env bash
# Pack the extension into a zip, and with "install" also install it for
# this user. Every .js file besides extension.js and prefs.js is included
# automatically.
set -euo pipefail

cd "$(dirname "$0")"
UUID=tideline@croby.se

extra=()
for f in "$UUID"/*.js; do
    name=$(basename "$f")
    [[ $name == extension.js || $name == prefs.js ]] && continue
    extra+=("--extra-source=$name")
done

gnome-extensions pack --force "${extra[@]}" "$UUID"
echo "Packed $UUID.shell-extension.zip"

if [[ ${1:-} == install ]]; then
    gnome-extensions install --force "$UUID.shell-extension.zip"
    echo "Installed. On Wayland, log out and back in to load the new version."
fi
