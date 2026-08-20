"use strict";

/**
 * Reading the workspace, and writing other people's edits into it safely.
 *
 * Every write goes through `resolve()`, which refuses anything that is not a
 * plain relative path inside the first workspace folder.
 */

const crypto = require("crypto");
const vscode = require("vscode");
const config = require("./config");
const log = require("./log");
const { sanitizeRelativePath, UnsafePathError } = require("./paths");

const BINARY_SNIFF_BYTES = 8000;

function rootFolder() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0] : null;
}

function rootName() {
  const folder = rootFolder();
  return folder ? folder.name : "";
}

/** Turn a small glob subset into a RegExp: `**`, `*`, `?`. */
function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` may match zero segments, so the slash is optional.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".indexOf(ch) !== -1) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp("^" + out + "$");
}

let excludeCache = { source: null, matchers: [] };

function excludeMatchers() {
  const patterns = vscode.workspace.getConfiguration("codecolab").get("exclude") || [];
  const source = patterns.join("\n");
  if (excludeCache.source !== source) {
    excludeCache = { source, matchers: patterns.map(globToRegExp) };
  }
  return excludeCache.matchers;
}

function isExcluded(relativePath) {
  return excludeMatchers().some((re) => re.test(relativePath));
}

/**
 * Workspace-relative POSIX path for a document, or null if it is not a file we
 * should be syncing at all.
 */
function relativePathOf(uri, allowed) {
  const folder = rootFolder();
  if (!folder || uri.scheme !== "file") return null;

  const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
  // asRelativePath hands back the absolute path when the file is outside.
  if (relative.indexOf("..") === 0 || /^[a-zA-Z]:/.test(relative) || relative.startsWith("/")) {
    return null;
  }
  try {
    const safe = sanitizeRelativePath(relative);
    // `allowed` is the set of files the host unlocked by hand. An excluded
    // file stays excluded until somebody deliberately says otherwise.
    if (allowed && allowed.has(safe)) return safe;
    return isExcluded(safe) ? null : safe;
  } catch (err) {
    return null;
  }
}

/** Absolute Uri for a peer-supplied relative path, or null if it is unsafe. */
function resolve(relativePath) {
  const folder = rootFolder();
  if (!folder) return null;
  let safe;
  try {
    safe = sanitizeRelativePath(relativePath);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      log.warn("Refused unsafe path from peer: " + relativePath + " (" + err.message + ")");
      return null;
    }
    throw err;
  }
  return vscode.Uri.joinPath(folder.uri, ...safe.split("/"));
}

/**
 * Is this file unsafe to move through a text channel?
 *
 * A null byte is the classic tell, and what git uses. But the real question
 * is whether the bytes survive a UTF-8 round trip: anything that does not
 * comes back with replacement characters where the original bytes were, so
 * "sharing" it would hand everyone a corrupted copy.
 */
function looksBinary(buffer) {
  const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  const head = buffer.subarray(0, limit);
  return !Buffer.from(head.toString("utf8"), "utf8").equals(head);
}

/**
 * Read every shareable file in the workspace.
 * @returns {Promise<{files: Array<{path: string, content: string}>, skipped: string[], truncated: boolean}>}
 */
async function collectFiles(token) {
  const folder = rootFolder();
  if (!folder) return { files: [], skipped: [], truncated: false };

  const maxFiles = config.maxFiles();
  const maxBytes = config.maxFileBytes();
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, "**/*"),
    config.excludeGlobs(),
    maxFiles + 1,
    token
  );

  const truncated = uris.length > maxFiles;
  const files = [];
  const skipped = [];

  for (const uri of uris.slice(0, maxFiles)) {
    const relative = relativePathOf(uri);
    if (!relative) continue;
    try {
      const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
      if (bytes.length > maxBytes) {
        skipped.push(relative + " (too large)");
        continue;
      }
      if (looksBinary(bytes)) {
        skipped.push(relative + " (binary)");
        continue;
      }
      files.push({ path: relative, content: bytes.toString("utf8") });
    } catch (err) {
      skipped.push(relative + " (unreadable)");
    }
  }

  return { files, skipped, truncated };
}

async function exists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Put `content` at `relativePath`, creating parent folders as needed.
 *
 * If the file is open in an editor the change goes through a WorkspaceEdit so
 * undo history and dirty state behave normally; otherwise it is written
 * straight to disk.
 */
async function writeContent(relativePath, content) {
  const uri = resolve(relativePath);
  if (!uri) return false;

  const open = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === uri.toString()
  );

  if (open) {
    if (open.getText() === content) return true;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)),
      content
    );
    return vscode.workspace.applyEdit(edit);
  }

  // Writing identical bytes still bumps the mtime and wakes every watcher
  // in the editor, so check first.
  const bytes = Buffer.from(content, "utf8");
  try {
    if (Buffer.from(await vscode.workspace.fs.readFile(uri)).equals(bytes)) {
      return true;
    }
  } catch (err) {
    /* not there yet, which is fine */
  }

  const parent = vscode.Uri.joinPath(uri, "..");
  await vscode.workspace.fs.createDirectory(parent);
  await vscode.workspace.fs.writeFile(uri, bytes);
  return true;
}

/**
 * Put raw bytes at `relativePath`, creating parent folders as needed.
 *
 * The text path above cannot do this: it round-trips through a string, which
 * is exactly what a PNG or a zip does not survive. This is what a file too
 * big or too binary for the live sync is written with when it arrives over
 * the attachment transport instead.
 *
 * @returns {Promise<boolean>} false if the path was refused or unchanged
 */
async function writeBytes(relativePath, bytes) {
  const uri = resolve(relativePath);
  if (!uri) return false;

  // Identical bytes still bump the mtime and wake every watcher in the
  // editor, and here that would also bounce straight back as an edit.
  try {
    if (Buffer.from(await vscode.workspace.fs.readFile(uri)).equals(bytes)) {
      return false;
    }
  } catch (err) {
    /* not there yet, which is the usual case */
  }

  const parent = vscode.Uri.joinPath(uri, "..");
  await vscode.workspace.fs.createDirectory(parent);
  await vscode.workspace.fs.writeFile(uri, bytes);
  return true;
}

/**
 * SHA-256 of a workspace file, or null if it is not there.
 *
 * Compared against the digest the server publishes, so a file that arrived
 * and a file that was already correct look the same and neither is rewritten.
 */
async function digestOf(relativePath) {
  const uri = resolve(relativePath);
  if (!uri) return null;
  try {
    const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
    return crypto.createHash("sha256").update(bytes).digest("hex");
  } catch (err) {
    return null;
  }
}

async function deleteContent(relativePath) {
  const uri = resolve(relativePath);
  if (!uri) return false;
  if (!(await exists(uri))) return true;
  await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
  return true;
}

/** Is the workspace folder empty enough to drop someone else's project into? */
async function looksEmpty() {
  const folder = rootFolder();
  if (!folder) return true;
  try {
    const entries = await vscode.workspace.fs.readDirectory(folder.uri);
    const meaningful = entries.filter(
      ([name]) => name !== ".git" && name !== ".vscode" && !name.startsWith(".")
    );
    return meaningful.length === 0;
  } catch (err) {
    return false;
  }
}

/**
 * Every file in the workspace with its verdict, for the panel's file search.
 *
 * Unlike collectFiles this deliberately looks at excluded files too - the
 * whole point is to show what is being left out and let the host override it
 * one file at a time.
 */
async function listCandidates(query, { limit = 400 } = {}) {
  const folder = rootFolder();
  if (!folder) return [];

  const needle = String(query || "").trim().toLowerCase();
  const maxBytes = config.maxFileBytes();

  // No exclude pattern here: a hidden file is exactly what we want to list.
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, "**/*"),
    "**/{.git,node_modules}/**",
    5000
  );

  const out = [];
  for (const uri of uris) {
    let relative;
    try {
      relative = sanitizeRelativePath(
        vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/")
      );
    } catch (err) {
      continue;
    }
    if (needle && relative.toLowerCase().indexOf(needle) === -1) continue;

    let size = 0;
    try {
      size = (await vscode.workspace.fs.stat(uri)).size;
    } catch (err) {
      continue;
    }

    let reason = null;
    if (isExcluded(relative)) reason = "excluded";
    else if (size > maxBytes) reason = "too large";

    out.push({ path: relative, size, reason });
    if (out.length >= limit) break;
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** A content type good enough for the browser saving it later. */
const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function contentTypeFor(name) {
  const dot = String(name || "").lastIndexOf(".");
  const ext = dot === -1 ? "" : String(name).slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

/** Read one file for a manual share. Returns null if it is not text. */
async function readTextFile(relativePath) {
  const uri = resolve(relativePath);
  if (!uri) return null;
  const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
  if (looksBinary(bytes)) return null;
  return bytes.toString("utf8");
}

module.exports = {
  listCandidates,
  readTextFile,
  contentTypeFor,
  rootFolder,
  rootName,
  relativePathOf,
  resolve,
  isExcluded,
  collectFiles,
  writeContent,
  writeBytes,
  digestOf,
  deleteContent,
  looksEmpty,
  globToRegExp,
};
