#!/usr/bin/env bash
# Print the newest glibc version (e.g. 2.35) that any of the given binaries needs: the highest GLIBC_x.y among the
# versions of the symbols they import (objdump -T). package.sh declares it as the packages' glibc minimum (#505).
#
# Fails, printing nothing, if objdump is missing, a file can't be read as a binary, or a binary names no glibc
# version: a minimum is never guessed.
#
# Usage: packaging/linux/glibc-min.sh <binary>...
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "usage: $0 <binary>..." >&2
  exit 2
fi
if ! command -v objdump >/dev/null 2>&1; then
  echo "glibc-min.sh: objdump is missing (it comes with binutils)" >&2
  exit 1
fi

versions=""
for bin in "$@"; do
  if ! symbols="$(objdump -T "$bin")"; then
    echo "glibc-min.sh: can't read the dynamic symbols of $bin" >&2
    exit 1
  fi
  found="$(grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' <<<"$symbols" | sed 's/^GLIBC_//' || true)"
  if [ -z "$found" ]; then
    echo "glibc-min.sh: $bin names no glibc version" >&2
    exit 1
  fi
  versions+="$found"$'\n'
done
printf '%s' "$versions" | sort -uV | tail -n 1
