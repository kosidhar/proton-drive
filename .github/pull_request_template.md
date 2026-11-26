Fixes #

**What changed**

-

**How it was tested**

- [ ] A test that failed before this change and passes now
- [ ] `bun test tests` and `bunx tsc --noEmit`
- [ ] `cargo test` and `cargo clippy --all-targets -- -D warnings`, in each Rust crate this touches
- [ ] The Python tests, if `linux/` changed

**Data safety:** does this touch syncing, deleting, moving, the virtual drive or the sync records? If so, how does it
keep the rules in [CLAUDE.md](https://github.com/kosidhar/proton-drive/blob/main/CLAUDE.md)? Never trash or overwrite a cloud item except for a genuine user
delete; records before files; a missing file isn't proof of a delete; when unsure, keep both.

**Changelog:** a line under Unreleased in `CHANGELOG.md`, if users would notice this.

**Left over** (as new issues):
