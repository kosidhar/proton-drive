#!/usr/bin/env bash
# Check a release's .deb the way a user installs it (#510): in clean Ubuntu 22.04 and Debian 12 containers, install it
# with `apt install ./…deb`, then start the daemon, the app and the drive helper. Also checks that no binary in the
# package needs a glibc newer than 2.35. Run it after package.sh and before publishing a release (see RELEASING.md).
#
# Needs docker. Pulls the official ubuntu:22.04 and debian:12 images and, inside them, packages from their archives.
#
# Usage: packaging/linux/verify-release.sh [version]     (default: the version in package.json)
#   IMAGES="ubuntu:22.04 ubuntu:24.04"  to check other images instead
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/packaging/linux"
DIST="$ROOT/dist/release"
GLIBC_LIMIT=2.35
VERSION="${1:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/package.json")}"
DEB="kosidhar-protondrive-$VERSION-linux-amd64.deb"
IMAGES="${IMAGES:-ubuntu:22.04 debian:12}"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is needed to check the release" >&2
  exit 1
fi
if [ ! -f "$DIST/$DEB" ]; then
  echo "error: $DIST/$DEB is missing: run packaging/linux/package.sh first" >&2
  exit 1
fi

failed=0

# 1. No binary in the package needs a newer glibc than the release supports
unpacked="$(mktemp -d)"
trap 'rm -rf "$unpacked"' EXIT
dpkg-deb -x "$DIST/$DEB" "$unpacked"
need="$("$HERE/glibc-min.sh" "$unpacked/usr/bin/protondrive" "$unpacked/usr/bin/protondrive-gui" "$unpacked/usr/bin/protondrive-vfs")"
if [ "$(printf '%s\n' "$need" "$GLIBC_LIMIT" | sort -V | tail -n 1)" = "$GLIBC_LIMIT" ]; then
  echo "PASS glibc: the binaries need $need (limit $GLIBC_LIMIT)"
else
  echo "FAIL glibc: the binaries need $need, newer than $GLIBC_LIMIT (was it built with --native?)"
  failed=1
fi

# 2. In each image: apt install ./…deb, then every program starts and reports this version
for image in $IMAGES; do
  echo "==> $image: installing $DEB with apt..."
  if out="$(docker run --rm --mount "type=bind,src=$DIST,dst=/pkgs,readonly" -e DEBIAN_FRONTEND=noninteractive "$image" bash -c "
      set -u
      apt-get update -qq >/dev/null 2>&1 || { echo 'apt-get update failed'; exit 1; }
      apt-get install -y -qq /pkgs/$DEB >/tmp/apt.log 2>&1 || { tail -5 /tmp/apt.log; exit 1; }
      echo \"daemon: \$(protondrive --version 2>&1 | head -1)\"
      echo \"app: \$(protondrive-gui --version 2>&1 | head -1)\"
      echo \"helper: \$(protondrive-vfs --help 2>&1 | head -1)\"
      for p in fuse3; do dpkg -s \$p >/dev/null 2>&1 || echo \"missing dependency: \$p\"; done
    " 2>&1)"; then
    :
  else
    echo "FAIL $image: the install failed:"
    printf '%s\n' "$out" | sed 's/^/    /'
    failed=1
    continue
  fi
  ok=1
  grep -qx "daemon: protondrive $VERSION" <<<"$out" || ok=0
  grep -qx "app: protondrive-gui $VERSION" <<<"$out" || ok=0
  # The helper takes no --help; what matters is that it loads (no dynamic-loader or glibc error)
  grep -q "^helper: " <<<"$out" || ok=0
  if grep -qE "GLIBC_|error while loading shared libraries|missing dependency" <<<"$out"; then ok=0; fi
  if [ "$ok" = 1 ]; then
    echo "PASS $image: installed, and the daemon, the app and the drive helper start"
  else
    echo "FAIL $image:"
    failed=1
  fi
  printf '%s\n' "$out" | sed 's/^/    /'
done

if [ "$failed" = 0 ]; then
  echo "==> $DEB is ready to publish"
else
  echo "==> do not publish $DEB: see the failures above" >&2
fi
exit "$failed"
