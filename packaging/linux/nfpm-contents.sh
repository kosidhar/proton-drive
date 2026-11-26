#!/usr/bin/env bash
# Prints nfpm `contents:` entries for everything staged under STAGE/usr/share and STAGE/usr/lib (#548): each file on its
# own (0755 if executable, 0644 otherwise), each symlink as a link, and as folders only the package's own. Owning shared
# folders such as /usr/share/icons/hicolor or /usr/share/mime/packages (as `type: tree` did, at the staging umask's 0775)
# makes the .rpm conflict on Fedora with hicolor-icon-theme, shared-mime-info and every other package that owns them.
#
# Usage: packaging/linux/nfpm-contents.sh STAGE      (package.sh splices the output into nfpm.yaml)
set -euo pipefail

STAGE="${1:?usage: nfpm-contents.sh STAGE}"
# The folders that are this package's alone; every other folder belongs to the system or another package
OWN_DIRS=(usr/share/protondrive usr/share/protondrive/tray usr/share/licenses/kosidhar-protondrive)

# A YAML single-quoted scalar: quotes doubled, so any file name reads back as itself
quote() { printf "'%s'" "${1//\'/\'\'}"; }

cd "$STAGE"
for top in usr/share usr/lib; do
  [ -d "$top" ] || continue
  find "$top" \( -type f -o -type l \) -print0
done | LC_ALL=C sort -z | while IFS= read -r -d '' rel; do
  if [ -L "$rel" ]; then
    printf '  - src: %s\n    dst: %s\n    type: symlink\n' "$(quote "$(readlink "$rel")")" "$(quote "/$rel")"
  else
    if [ -x "$rel" ]; then mode=0755; else mode=0644; fi
    printf '  - src: %s\n    dst: %s\n    file_info: { mode: %s }\n' "$(quote "$STAGE/$rel")" "$(quote "/$rel")" "$mode"
  fi
done

for dir in "${OWN_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    printf '  - dst: %s\n    type: dir\n    file_info: { mode: 0755 }\n' "$(quote "/$dir")"
  fi
done
