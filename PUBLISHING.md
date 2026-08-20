# Publishing CodeColab

How to get this extension onto the Visual Studio Marketplace, and what breaks
if you skip a step.

Everything the marketplace needs is already in `package.json` except one
thing: `publisher` is still `"local"`. Read [Before you
publish](#before-you-publish) first — changing it breaks every invite link
unless the backend changes with it.

---

## What you need

| | |
| --- | --- |
| Microsoft account | any personal or work account |
| Azure DevOps organization | free, name does not matter |
| Personal Access Token | scoped to Marketplace → Manage |
| Publisher ID | permanent, globally unique, lowercase |

## 1. Azure DevOps organization

Marketplace publisher accounts are backed by Azure DevOps, even though you
never otherwise use it.

Sign in at <https://dev.azure.com> and create an organization if you have
none. The name is irrelevant — nobody sees it.

## 2. Personal Access Token

In Azure DevOps: user icon (top right) → **Personal Access Tokens** → **New
Token**.

- **Organization: All accessible organizations** — not your org name. This is
  the single most common reason publishing fails with a `401`.
- **Scopes: Custom defined** → find **Marketplace** → tick **Manage**.
- Expiry: whatever you like; you will need a new one when it lapses.

Copy the token. It is shown once and cannot be retrieved again.

## 3. Create the publisher

Go to <https://marketplace.visualstudio.com/manage>, sign in with the same
Microsoft account, and create a publisher.

The **ID** is what goes in `package.json`. It is permanent, cannot be renamed,
and becomes part of the extension's identity forever. The **display name** is
cosmetic and can be changed later.

## 4. Point the extension at your publisher

See [Before you publish](#before-you-publish) — this is the step with
consequences elsewhere.

```bash
cd VScode-ex
npx @vscode/vsce login <your-publisher-id>   # paste the PAT when asked
```

The token is stored in your keychain, so you only do this once per machine.

## 5. Publish

```bash
npm run publish:marketplace          # publishes the current version
```

or, to bump the version and publish in one step:

```bash
npx @vscode/vsce publish patch       # 2.1.0 -> 2.1.1
npx @vscode/vsce publish minor       # 2.1.0 -> 2.2.0
```

Publishing the same version twice is rejected, so always bump.

The listing appears in search within about five to ten minutes. A first
publish can sit in Microsoft's verification for longer.

---

## Before you publish

### Changing `publisher` breaks every invite link

The "Open in VS Code" button on the join page opens
`vscode://<publisher>.<name>/join?code=…`. Right now that is
`vscode://local.codecolab/join`. The moment the publisher changes, every link
the backend generates points at an extension ID that no longer exists — and
it fails **silently**: the browser just does nothing.

Six places have to change together:

| File | What |
| --- | --- |
| `VScode-ex/package.json` | `publisher` |
| `VScode-ex/extension.js` | the URI-handler comment |
| `VScode-ex/src/code.js` | the deep-link comment |
| `VScode-ex/test/run.js` | the deep-link test fixture |
| `BACK/app/config.py` | `vscode_extension_id` default |
| `BACK/.env`, `BACK/.env.production` | `VSCODE_EXTENSION_ID` |

The backend one is the one that actually matters at runtime, and it is the
easiest to forget, because nothing errors — the button simply stops working.

Check it afterwards:

```bash
curl -s https://code-colab.renode.space/api/info | grep extension_id
```

That must match `<publisher>.codecolab` exactly.

### Marketplace updates will fight the self-hosted updater

Once the extension is on the marketplace, VS Code updates it itself. This
extension also has its own updater, which pulls builds from
`/api/extension/latest` on the backend and installs them.

Both running at once means two things can install different versions over
each other. When you publish, change the default in `package.json`:

```json
"codecolab.autoUpdate": { "default": "off" }
```

The server-hosted build then only serves people who sideload the `.vsix`,
which is still worth keeping for testing.

### The repository is private

`package.json` points `repository` at
`https://github.com/voritsack/code_colab_extention`, which is private. The
marketplace renders a **Repository** link on the listing that will 404 for
every visitor.

Either make the repository public, or remove the `repository` field before
publishing.

### Anyone can then install it

Publishing is public. Everyone who installs it points at
`https://code-colab.renode.space` by default — a single server you run, with
open session creation. Before publishing, decide whether you want that, and
consider setting `HOST_ACCESS_CODE` in the backend so strangers cannot create
sessions on your server.

---

## Also publish to Open VSX

Cursor, VSCodium, Windsurf and Gitpod cannot reach Microsoft's marketplace.
They use [Open VSX](https://open-vsx.org) instead. It is a separate registry
with a separate token.

```bash
# token from https://open-vsx.org/user-settings/tokens
npx ovsx create-namespace <your-publisher-id> -p <token>   # once
npm run publish:openvsx -- -p <token>
```

Use the same publisher ID in both so the extension identity matches.

---

## Releasing an update later

```bash
cd VScode-ex
node test/run.js http://127.0.0.1:8000     # against a local backend
npx @vscode/vsce publish minor
```

If you are still serving builds from the backend as well, publish there too
so sideloaded installs stay current:

```bash
cd ../BACK
python scripts/publish_extension.py ../VScode-ex/codecolab-<version>.vsix \
  --notes "What changed"
git add app/static/downloads && git commit && git push
```

The deployment folder is rebuilt from git on every start, so an uncommitted
build disappears on the next restart.

---

## When it goes wrong

**`ERROR Failed request: (401)`**
The token lacks the right scope, or — far more likely — it was not created
for *All accessible organizations*. Make a new one; the setting cannot be
changed on an existing token.

**`ERROR The Personal Access Token verification has failed`**
The token has expired, or it belongs to a different Microsoft account than
the publisher.

**`ERROR Missing publisher name`**
`publisher` is still `"local"` in `package.json`.

**`ERROR <version> is already published`**
Bump the version, or use `vsce publish patch`.

**`ERROR Make sure to edit the README.md file before you package`**
Only fires on template README content; this repository's README is fine.

**`WARNING A 'repository' field is missing`**
Only if you removed it. Add `--allow-missing-repository` to package anyway.

**Published, but the "Open in VS Code" button does nothing**
The extension ID and `VSCODE_EXTENSION_ID` disagree. See [Changing
`publisher`](#changing-publisher-breaks-every-invite-link).

---

## Unpublishing

```bash
npx @vscode/vsce unpublish <publisher>.codecolab
```

This removes the listing, but the publisher ID and extension name stay
burned — you cannot republish under the same identity later. Treat the first
publish as one-way.
