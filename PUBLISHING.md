# Publishing CodeColab

Everything in the code is ready. Three things are left, and they all need you.

---

## 1. Create the publisher

Go to <https://marketplace.visualstudio.com/manage> and sign in with a
Microsoft account.

Create a publisher with the ID **`voritsack`**. It has to be exactly that —
it is already set in `package.json` and in the backend. (If you want a
different one, see [Changing the publisher](#changing-the-publisher).)

If it asks you to create an Azure DevOps organization first, do it. The name
does not matter and you will never use it again.

## 2. Get a token and publish

In Azure DevOps (<https://dev.azure.com>): your avatar, top right →
**Personal Access Tokens** → **New Token**.

Two settings matter:

- **Organization: All accessible organizations** — not your org name.
- **Scopes: Custom defined** → **Marketplace** → **Manage**.

Copy the token; it is only shown once.

```bash
cd VScode-ex
npx @vscode/vsce login voritsack     # paste the token
npm run publish:marketplace
```

Live in five to ten minutes. Login is once per machine.

## 3. Fix the deployed `.env`

**Do this or every invite link breaks.**

The "Open in VS Code" button builds `vscode://voritsack.codecolab/join?...`.
The server on `code-colab.renode.space` still has the old placeholder, and
`.env` is not in the repository, so pushing does not fix it.

In the hosting panel's file manager, open `.env` and set:

```
VSCODE_EXTENSION_ID=voritsack.codecolab
```

Restart, then check:

```bash
curl -s https://code-colab.renode.space/api/info
```

It must say `"extension_id":"voritsack.codecolab"`. If it still says
`local.codecolab`, the button will do nothing at all — no error, no message,
it just fails silently. The server also warns about this in its startup log.

---

## Optional: the repository link

`package.json` points at `https://github.com/voritsack/code_colab_extention`,
which is private, so the **Repository** link on the listing will 404 for
everyone.

Either make the repository public, or delete the `repository` field from
`package.json` before publishing.

## Optional: Open VSX

Cursor, VSCodium and Windsurf cannot reach Microsoft's marketplace. Publishing
to [Open VSX](https://open-vsx.org) covers them. Separate site, separate
token, same publisher ID.

```bash
npx ovsx create-namespace voritsack -p <token>   # once
npm run publish:openvsx -- -p <token>
```

---

## Releasing an update

```bash
cd VScode-ex
node test/run.js http://127.0.0.1:8000     # against a local backend
npx @vscode/vsce publish minor             # bumps the version and publishes
```

Publishing the same version twice is rejected, so always bump.

To also serve the build to people who sideload:

```bash
cd ../BACK
python scripts/publish_extension.py ../VScode-ex/codecolab-<version>.vsix \
  --notes "What changed"
git add app/static/downloads && git commit -m "chore: publish <version>" && git push
```

The deployment folder is rebuilt from git on every start, so an uncommitted
build disappears at the next restart.

---

## Changing the publisher

If you create a publisher other than `voritsack`:

```bash
cd VScode-ex
node scripts/set-publisher.js <new-id>
```

That updates the extension and the backend together — nine places. Doing it
by hand means eventually missing the backend and wondering why invite links
stopped opening. Then redeploy the backend and update its `.env` as in
[step 3](#3-fix-the-deployed-env).

## Updates after publishing

`codecolab.autoUpdate` is off by default, which is right for a Marketplace
install: VS Code keeps it current on its own, and two updaters installing over
each other is worse than none.

Only turn it on (`silent` or `ask`) if you hand people the `.vsix` directly
instead.

---

## Errors you might hit

| Message | Cause |
| --- | --- |
| `Failed request: (401)` | Token was not created for *All accessible organizations*. Make a new one — it cannot be changed. |
| `Personal Access Token verification has failed` | Token expired, or it belongs to a different Microsoft account than the publisher. |
| `Missing publisher name` | `publisher` is still `local` in `package.json`. |
| `<version> is already published` | Bump the version, or use `vsce publish patch`. |
| Published, but "Open in VS Code" does nothing | The deployed `VSCODE_EXTENSION_ID` does not match. See [step 3](#3-fix-the-deployed-env). |

## Unpublishing

```bash
npx @vscode/vsce unpublish voritsack.codecolab
```

The listing goes, but the publisher ID and extension name stay burned — you
cannot republish under the same identity. Treat the first publish as one-way.
