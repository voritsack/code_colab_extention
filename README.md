# CodeColab — live code collaboration for VS Code

Share the folder you already have open. You get a link and a short code; the
people you invite open it, VS Code takes over, and you admit them one at a
time. Everyone edits in their own editor.

Backend: <https://github.com/voritsack/code_colab_back>

---

## How a session goes

**Host**

1. Open the folder you want to share.
2. `Ctrl+Shift+P` → **CodeColab: Start session and generate link**.
3. Answer three questions: what it is called, whether guests may join, and
   whether you admit people yourself.
4. The invite link lands on your clipboard. Send it.

**Guest**

1. Open the link. The page has an **Open in VS Code** button.
2. VS Code asks whether to join; if the session allows guests you just type a
   display name.
3. The host gets a prompt and admits you as an editor or view-only.
4. The host's project is written into your open folder and edits flow both
   ways.

There are no accounts at all. You pick a display name once, and the session
token you are issued decides what you can do. Nothing to register, nothing to
remember, nothing to leak.

## Who is where

Everyone gets a colour, worked out from their participant id so it looks the
same in every editor without being synchronised. You see their caret with
their name beside it, their selection tinted, and a dot with their initials
in the gutter. Click anyone's avatar to **follow** them: your editor opens
whatever they open and scrolls with them. Click again to stop.

## The panel

Everything lives in the **CodeColab** view in the activity bar — no command
names to memorise.

Before a session it has your display name, a field for the session name with
two switches (admit each person, open to anyone with the code) and a **Start
session** button; below that, a box to paste a code or invite link and
**Join**.

During a session it shows the title and status, the join code (click to copy),
**Copy link** and **Open page**, then **Pause**/**Resume**, **Push
workspace** and **End session** for the host, or **Ask to edit**, **Resync**
and **Leave** for everyone else. Below that, a row of avatars and three tabs:

- **People** — everyone with their role and current file. Newcomers get
  **Admit as editor**, **View only** and **Refuse**; people already in get a
  role toggle and **Remove**.
- **Chat** — messages with everyone in the session, kept so someone admitted
  late can read back.
- **Board** — a shared drawing canvas. Pick a colour and a width, or the
  eraser, and draw; everyone sees it, including people in view-only mode.
  **Clear mine** removes your own strokes, and the host can clear everything.

If the connection drops, the panel says why and offers **Reconnect** — and
the session survives a window reload, so restarting VS Code walks straight
back into it rather than orphaning it on the server.

Every one of those is also a command in the palette, if you prefer typing.

**Pause** freezes the session in both directions — nothing propagates and
nothing is stored. Useful for teaching: freeze the picture, talk, then resume.
Resuming pushes a fresh snapshot so everyone is back in step.

## When the connection drops

Losing the socket does not end your session. The view keeps the invite link
and the participant list, the status bar turns red, and a **Reconnect** entry
appears at the top of the view - the session is still on the server, so you
rejoin the same one rather than starting over.

The extension sends a heartbeat every 25 seconds, so an idle session survives
a proxy's read timeout - nginx closes idle upstream connections after 60
seconds by default, and a session where nobody is typing is idle by
definition. The same heartbeat notices a dead connection in about a minute
instead of waiting on TCP.

If the server answers the WebSocket handshake with ordinary HTTP instead of
upgrading it, that is reported as what it is rather than retried six times and
given up on. It almost always means a proxy in front of the backend is not
forwarding WebSocket connections:

- **Cloudflare**: Network -> WebSockets must be on.
- **nginx**: the location needs `proxy_http_version 1.1;`,
  `proxy_set_header Upgrade $http_upgrade;` and
  `proxy_set_header Connection "upgrade";`

Nothing else on the site will look broken - the join page renders and the
admin dashboard loads - but no session can work until it is fixed.

## Commands

| Command | Who |
| --- | --- |
| Start session and generate link | anyone |
| Join session by code or link | anyone |
| Copy invite link · Copy join code | host |
| Pause · Resume · End session | host |
| Push current workspace to everyone | host |
| Reconnect to session | anyone, after a drop |
| Resynchronise from host · Leave session | participant |
| Change your display name | anyone |
| Rejoin the previous session | anyone |
| Check for updates | anyone |
| Open the CodeColab panel | anyone |
| Show log | anyone |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `codecolab.serverUrl` | `https://code-colab.renode.space` | Backend origin. Set it to `http://127.0.0.1:8000` to work against a local backend. `CODECOLAB_SERVER_URL` wins over it. |
| `codecolab.wsUrl` | *(empty)* | WebSocket origin; derived from `serverUrl` when empty. `CODECOLAB_WS_URL` wins over it. |
| `codecolab.exclude` | `node_modules`, `.git`, build output, lockfiles, logs | Never shared or synchronised. |
| `codecolab.maxFileBytes` | `512000` | Larger files are skipped. |
| `codecolab.maxFiles` | `2000` | Upload cap when a session starts. |
| `codecolab.syncDelayMs` | `300` | Idle time before an edit is sent. |
| `codecolab.autoOpenPanel` | `true` | Reveal the view when a session starts. |
| `codecolab.autoUpdate` | `silent` | `silent`, `ask` or `off`. See below. |

Binary files are skipped automatically.

## Security

- **Nothing to steal.** There are no passwords and no long-lived credentials.
  A session token is scoped to one session and dies with it.
- **The WebSocket authenticates with a session-scoped token** sent in an
  `Authorization` header rather than the query string, keeping it out of proxy
  logs. That token is only good for one participant in one session.
- **Every incoming path is sanitised before anything is written**
  (`src/paths.js`). Traversal, absolute paths, drive letters, UNC prefixes,
  null bytes and reserved Windows names are refused, so a malicious peer — or
  a compromised server — cannot write outside your workspace folder. The
  server checks the same thing; this is the copy that actually protects your
  disk.
- **Joining always asks first** when your folder is not empty, and says which
  folder is about to be written to.
- **An invite for a different server is confirmed explicitly.** Joining sends
  your open folder's contents to whatever server the link names, so switching
  is never silent.

## Which server it talks to

Out of the box the extension points at the hosted backend
(`https://code-colab.renode.space`). Change **Settings → CodeColab → Server Url**, or
export `CODECOLAB_SERVER_URL`, to run against your own.

An invite link carries the server it belongs to. If it names a different one
than you have configured, the extension says so and asks before switching:
joining sends the contents of your open folder to whatever server the link
names, so that decision is always yours.

## Editing the same file

Sync replaces whole files, so two people typing in one file would overwrite
each other. Whoever types first holds that file for a few seconds; anyone
else is told who has it instead of silently losing their work, and the hold
is released as soon as the holder moves elsewhere. It is not simultaneous
editing — it is a guarantee that nothing disappears.

## Updates

The server hosts the extension build, and by default new versions install
themselves and then offer to reload.

Installing a VSIX runs the code inside it, so three rules hold regardless of
that setting: it only ever comes from the server in `codecolab.serverUrl`
(never from a join link), a silent install requires https or localhost —
over plain http on a public address it downgrades to asking — and the
download has to match the checksum the manifest advertised.

Set `codecolab.autoUpdate` to `ask` or `off` to change that.

See [PUBLISHING.md](PUBLISHING.md) for getting this onto the Visual Studio
Marketplace and Open VSX.

## Install

```bash
npm install
npm run package          # produces codecolab-<version>.vsix
code --install-extension codecolab-2.1.0.vsix
```

If the old `blogapp-sync` extension is still installed, uninstall it — this is
a separate extension, not an upgrade.

## Tests

```bash
node test/run.js [serverUrl]      # default http://127.0.0.1:8000
```

The harness swaps in a small stand-in for the `vscode` module
(`test/vscode-stub.js`) and drives the real extension code against a running
backend: once as the host with a scripted guest on a raw socket, then once as
the guest with a scripted host — including a path-traversal attempt that must
not escape the temporary workspace.

## Layout

```
extension.js        activation, commands, the vscode:// handler
src/panel.js        the activity-bar view: people, chat, board
src/presence.js     other people's cursors, selections and follow mode
src/colors.js       per-person colour and initials
src/updater.js      checking for and installing new builds
src/identity.js     your display name
src/config.js       settings and environment overrides
src/http.js         JSON client over node's http/https
src/api.js          REST wrappers
src/session.js      the session controller: socket, edits, roles
src/workspace.js    reading the folder, writing peers' edits safely
src/paths.js        path sanitising
src/code.js         join-code parsing
src/status.js       the status-bar item
```
