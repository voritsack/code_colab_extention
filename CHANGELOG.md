# Changelog

## 2.3.0

- **Credential files are no longer shared.** `.env`, `.ssh/`, `.aws/`,
  `*.pem`, `*.key`, `id_rsa*`, `.npmrc` and `secrets.*` were being uploaded
  with the rest of the folder and pushed to everyone admitted to the session.
  They are excluded by default now; `.env.example` still goes, since that is
  what it is for.
- The host is told how many files were skipped, not just how many were sent.

## 2.2.0

- First Marketplace release. The extension id is now `voritsack.codecolab`,
  which is what invite links are built from.
- Self-hosted updates are off by default: VS Code keeps a Marketplace install
  current on its own, and two updaters installing over each other is worse
  than none. Turn it back on only if you sideload the VSIX.

## 2.1.0

- Everyone has a colour, worked out from their participant id so a person
  looks the same in every editor. Their caret is drawn with their name beside
  it, their selection is tinted, and an initialled dot sits in the gutter.
- Click an avatar to **follow** someone: your editor opens what they open and
  scrolls with them.
- The panel gains three tabs — people, chat, and a shared drawing board. The
  board is open to view-only participants, because somebody who cannot type
  still needs to circle the line they are asking about.
- **Soft file locks.** Sync replaces whole files, so two people in one file
  used to overwrite each other silently. Whoever types first now holds that
  file briefly and everyone else is told who has it. The hold is released as
  soon as they move elsewhere.
- Viewers can **ask to edit** instead of hoping the host notices.
- The session survives a window reload. Before this, restarting VS Code
  orphaned it: still live on the server, with nobody able to control it.
- A heartbeat keeps idle sessions alive through proxy read timeouts, and
  spots a dead connection in about a minute rather than waiting on TCP.

## 2.0.0

- **No accounts.** Pick a display name; the session token you are issued
  decides what you can do. Sign-in, registration and stored credentials are
  gone.
- The view is a webview instead of a tree, so every action is a button or a
  field rather than a command name you have to know.

## 1.3.0

- A dropped connection no longer discards the session. The invite link and
  participant list survive, and **Reconnect** rejoins the same session.
- A server that refuses to upgrade the WebSocket now says so — naming the
  proxy setting that fixes it — instead of retrying six times and reporting
  "lost the connection".

## 1.0.0

- First release: sessions with a shareable link and a Meet-style join code, a
  lobby the host admits people from, host/editor/viewer roles, and
  pause/resume.
