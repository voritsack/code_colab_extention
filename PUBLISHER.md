# Marketplace publisher form — answers

Copy each value into the matching field at
<https://marketplace.visualstudio.com/manage/createpublisher>.

## Basic information

| Field | Value |
| --- | --- |
| **Name** | `CodeColab` |
| **ID** | `ddatunashvili` |
| **Verified domain** | *leave empty* |

### Read this before submitting

The ID is not a display name — it is the namespace every extension is
published under, it forms the extension's permanent identifier
(`ddatunashvili.codecolab`), and **it can never be changed after creation**.

`package.json` declares:

```json
"publisher": "codecolab"
```

Create the publisher with the ID exactly `codecolab`, lower case. The **Name**
field is the free-text display name on the profile page, so `CodeColab` goes
there and reads the way you want.

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
