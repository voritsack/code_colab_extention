# Changelog

## 2.6.5

- **The pre-rename copy is removed once the new one is running.** Changing the
  publisher changed the extension id, so 2.6.4 installed *beside* the old
  `voritsack.codecolab` rather than over it, leaving two copies activating
  together - two update pollers, two panels, two sets of commands answering to
  the same names. The new build now uninstalls the old id on activation. It
  has to happen from the new copy: an extension asked to remove itself is torn
  down half way through the request.

## 2.6.4

- **The extension id is now `codecolab.codecolab`.** The publisher changed
  from `voritsack` to `codecolab` ahead of the first Marketplace release, and
  the id is `<publisher>.<name>`, so the `vscode://` deep link behind every
  "Open in VS Code" button changed with it. The backend builds that link from
  `VSCODE_EXTENSION_ID`, which has to be updated on the server too.
- **Every packaged file resolves to a content type again.** A `.vsix` is an
  OPC package and `vsce` maps parts to content types by file extension alone,
  so `node_modules/ws/LICENSE` - which has no extension - shipped as a part
  nothing covered, and the Marketplace ingester rejected the upload with
  "Value cannot be null. Parameter name: v1". That file is no longer packaged
  and ws's MIT text now travels in `THIRD-PARTY-NOTICES.txt`.

## 2.6.2

- **"Share this one" now means the same thing for every file.** Anything the
  live sync cannot carry - a PNG, a zip, a 700 KB fixture - used to become an
  attachment sitting in a list, which is not sharing a project file, it is
  emailing it. The bytes still travel the other way, because a text channel
  under a size cap cannot take them, but they now carry the path they belong
  at and every client writes them there. `codecolab.autoWriteSharedFiles`
  turns that off if you would rather be asked.
- The panel separates the two: *Shared project files*, which land in the
  folder, and *Send a file*, which does not.
- **Updates are checked on a timer, not only at startup.** A window left
  open used to check once and then stay quiet for six hours, so a build
  published five minutes after you opened the editor went unnoticed for the
  rest of the day. It now looks every fifteen minutes and asks the server at
  most once an hour.
- **"Check for updates" is a button in the panel**, next to "Show log". The
  command still exists; you no longer have to know its name.

## 2.6.0

- **Share any file, not only text.** "Share this one" on an excluded or
  oversized file used to refuse anything binary. It now sends those as an
  attachment instead: text still joins the live sync, everything else is
  handed round without being mangled by a UTF-8 round trip.
- **Automatic updates are on by default again**, and finish by themselves.
  A silent update installs in the background and reloads the window as soon
  as no session is running - never under one in progress. Still only from
  the configured server, still only over https or localhost, and still only
  if the download matches the published digest.
- The server's admin dashboard gained the other half of this: publish a
  build from the browser, and see the two URLs the extension talks to.

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
