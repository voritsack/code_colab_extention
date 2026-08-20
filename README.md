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

No account is needed to join a guest-friendly session. Hosting always needs
one — that is who the session belongs to.

## While it runs

The **CodeColab** view in the activity bar shows the code, the invite link and
everyone in the room, with the file each person currently has open. From its
title bar the host can pause, resume, re-push the workspace and end the
session; from the list, admit or refuse newcomers, switch someone between
editing and view-only, or remove them.

**Pause** freezes the session in both directions — nothing propagates and
nothing is stored. Useful for teaching: freeze the picture, talk, then resume.
Resuming pushes a fresh snapshot so everyone is back in step.

## Commands

| Command | Who |
| --- | --- |
| Start session and generate link | anyone signed in |
| Join session by code or link | anyone |
| Copy invite link · Copy join code | host |
| Pause · Resume · End session | host |
| Push current workspace to everyone | host |
| Resynchronise from host · Leave session | participant |
| Sign in · Sign out · Create an account | anyone |
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

Binary files are skipped automatically.

## Security

- **Tokens never leave SecretStorage**, and they are keyed by server origin, so
  pointing the extension at a different backend never reuses credentials from
  another one. Access tokens are short-lived and refreshed silently.
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

## Install

```bash
npm install
npm run package          # produces codecolab-<version>.vsix
code --install-extension codecolab-1.2.0.vsix
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
src/config.js       settings and environment overrides
src/http.js         JSON client over node's http/https
src/auth.js         sign-in, SecretStorage, token refresh
src/api.js          REST wrappers
src/session.js      the session controller: socket, edits, roles
src/workspace.js    reading the folder, writing peers' edits safely
src/paths.js        path sanitising
src/code.js         join-code parsing
src/tree.js         the activity-bar view
src/status.js       the status-bar item
```
