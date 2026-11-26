#!/usr/bin/env bash
# Build protondrive-gui and protondrive-vfs for glibc 2.35 (Ubuntu 22.04, Debian 12 and anything newer), in an
# Ubuntu 22.04 container (build-env/Dockerfile), and copy them to release/. package.sh runs this unless given --native.
#
# Needs docker. The image is built once and then reused. The build runs as the calling user, with only this
# repository and a named volume for the cargo registry mounted. It builds into native-gui/target-portable and
# native-vfs/target-portable, apart from the host builds in target/.
#
# Usage: packaging/linux/build-portable.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/packaging/linux"
IMAGE="kosidhar-protondrive-build:ubuntu22.04"
CARGO_VOLUME="kosidhar-protondrive-cargo-$(id -u)"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is needed to build the portable binaries" >&2
  exit 1
fi

echo "==> Preparing the Ubuntu 22.04 build image ($IMAGE)..."
docker build --tag "$IMAGE" "$HERE/build-env"

echo "==> Building protondrive-gui and protondrive-vfs in Ubuntu 22.04..."
# --init passes Ctrl+C on to cargo; --rm leaves no stopped container behind
docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --env CARGO_HOME=/cargo \
  --mount "type=bind,src=$ROOT,dst=/src" \
  --mount "type=volume,src=$CARGO_VOLUME,dst=/cargo" \
  --workdir /src \
  "$IMAGE" \
  bash -euc '
    for crate in native-gui native-vfs; do
      (cd "/src/$crate" && CARGO_TARGET_DIR="/src/$crate/target-portable" cargo build --release --locked)
    done
  '

install -Dm755 "$ROOT/native-gui/target-portable/release/protondrive-gui" "$ROOT/release/protondrive-gui"
install -Dm755 "$ROOT/native-vfs/target-portable/release/protondrive-vfs" "$ROOT/release/protondrive-vfs"
echo "==> release/protondrive-gui and release/protondrive-vfs need glibc" \
  "$("$HERE/glibc-min.sh" "$ROOT/release/protondrive-gui" "$ROOT/release/protondrive-vfs") or newer"
