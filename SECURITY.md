# Security

## Reporting a problem

**Please don't open a public issue for a security problem.** Report it privately through GitHub instead:
[report a vulnerability](https://github.com/kosidhar/proton-drive/security/advisories/new). Only the maintainer sees
it.

If that page isn't available, open an issue titled **Security contact**, with no details in it, and you'll be given a
private way to send them.

Say which version you used (`protondrive --version`), what someone could do with the problem, and how to reproduce
it. This is a small project with one maintainer: expect an answer within a week, and a fix in a new release as soon as
one is ready. You'll be credited in the release notes unless you'd rather not be.

## What counts

- **Your Proton session:** how the app gets it, stores it (the system keyring, or a file only you can read when
  there's no keyring) and uses it. Without a keyring the session is a plain file that anything running as you can
  read; the app says so (in the log, in Settings, and in `protondrive auth status`), and `PROTONDRIVE_NO_FILE_SESSION=1`
  makes it refuse the file and stay signed out instead.
- **The app's local interfaces:** the daemon's API on `127.0.0.1` and its control socket. That means anything that lets
  a web page, another program or another user on the computer read your files or account, or act on them.
- **The virtual drive helper, and the Files and tray extensions.**
- **The packages and how releases are built,** for example a way to tamper with a download.

A sync bug that deletes or overwrites your files in Proton Drive without you asking is the most serious kind of bug
here. Report it as an ordinary issue straight away, unless someone else could trigger it on purpose: then report it
privately, as above.

**Not in scope:** Proton's own servers, web apps and Drive SDK. Report problems with those to Proton, through their
bug bounty program.

## Supported versions

Only the latest release gets fixes. While the version is `0.x`, please update to it before reporting.

## What the app connects to

The app connects only to Proton's servers, through Proton's Drive SDK. You sign in on Proton's own page in your
browser, so the app never sees your password. The links it shows, to Proton's web pages and to this repository,
open in your browser.
