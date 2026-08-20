# Marketplace publisher form — answers

Copy each value into the matching field at
<https://marketplace.visualstudio.com/manage/createpublisher>.

## Basic information

| Field | Value |
| --- | --- |
| **Name** | `CodeColab` |
| **ID** | `voritsack` |
| **Verified domain** | *leave empty* |

### Read this before submitting

The ID is not a display name — it is the namespace every extension is
published under, it appears in the extension's permanent identifier
(`voritsack.codecolab`), and **it can never be changed after creation**.

`package.json` already declares:

```json
"publisher": "voritsack"
```

So the ID has to be `voritsack`, not `CodeColab`. If you create the publisher
as `CodeColab`, `vsce publish` fails with a mismatch and the only fix is
editing `package.json`, re-releasing, and abandoning the unused publisher —
the name is taken permanently either way.

The **Name** field is the free-text display name shown on the profile page, so
`CodeColab` belongs there and reads exactly the way you wanted.

If you would rather the identifier itself be `codecolab`, say so — that is a
one-line change to `package.json` plus a release, and it must happen *before*
the first publish, since the extension's marketplace URL and every existing
install key are built from `publisher.name`.

## About you

**Description**

```
CodeColab is live code collaboration for VS Code with no accounts and no
sign-up. Share the folder you already have open: generate an invite link,
admit people one at a time as editors or view-only guests, and everyone
edits in their own editor with live cursors, selections and follow mode.
```

**Logo** — upload `media/publisher-logo-128.png` (128x128, generated from
`media/logo.png`, which is 256x256 and the wrong size for this field).

| Field | Value |
| --- | --- |
| **Company website** | `https://code-colab.renode.space` |
| **Support** | `https://github.com/voritsack/code_colab_extention/issues` |
| **LinkedIn** | *leave empty* |
| **Source code repository** | `https://github.com/voritsack` |
| **Twitter** | *leave empty* |

### Notes on the optional fields

- **Support** takes an email or a URL. The issue tracker is the better answer:
  it is already set as `bugs.url` in `package.json`, and it keeps a personal
  inbox off a public profile page.
- **Source code repository** wants the org or user root, per Microsoft's own
  `https://github.com/microsoft` example. The extension repo itself
  (`https://github.com/voritsack/code_colab_extention`) is already published
  through `package.json`'s `repository` field.
- **Verified domain** only matters if you want the blue verified badge. It
  requires adding a TXT record to a domain you control — `renode.space` is a
  subdomain, so verification would need the apex domain. Skip it for now; it
  can be added later, unlike the ID.
- **LinkedIn** and **Twitter** are public profile links. Left empty on
  purpose; fill them only if you want them associated with the extension.
