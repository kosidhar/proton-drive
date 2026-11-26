# The build environment for the release builds of protondrive-gui and protondrive-vfs (#505), used by
# packaging/linux/build-portable.sh. Ubuntu 22.04 has glibc 2.35, so what is built here runs on Ubuntu 22.04,
# Debian 12, Fedora 36 and anything newer. Both binaries link only libc, libm and libgcc_s; graphics, X11 and Wayland
# are loaded at run time, so a C toolchain and Rust are all they need.
FROM ubuntu:22.04

# The Rust the project is developed with; there is no rust-toolchain file to follow.
ARG RUST_VERSION=1.99.1

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The toolchain is read-only to the user the build runs as: its registry and caches go to /cargo (below).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "$RUST_VERSION" \
    && chmod -R a+rX "$RUSTUP_HOME" "$CARGO_HOME" \
    && rustc --version \
    && cargo --version

# The cargo cache: build-portable.sh mounts a named volume here, which takes this folder's mode on first use, so any
# user can write to it.
RUN mkdir -m 1777 /cargo
