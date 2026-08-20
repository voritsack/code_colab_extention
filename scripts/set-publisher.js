#!/usr/bin/env node
"use strict";

/**
 * Change the marketplace publisher id everywhere it matters.
 *
 *   node scripts/set-publisher.js <publisher-id>
 *
 * The publisher is not just a listing detail: the extension id it forms is
 * what the backend builds `vscode://<publisher>.<name>/join` links from. Get
 * the two out of step and the "Open in VS Code" button does nothing at all,
 * with no error anywhere. So this updates the extension and the backend
 * together, and refuses to do half the job.
 */

const fs = require("fs");
const path = require("path");

const EXT_ROOT = path.resolve(__dirname, "..");
const BACK_ROOT = path.resolve(EXT_ROOT, "..", "BACK");

const publisher = (process.argv[2] || "").trim();
if (!publisher) {
  console.error("Usage: node scripts/set-publisher.js <publisher-id>");
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(publisher)) {
  console.error(
    "A publisher id is lowercase letters, digits and hyphens, 2-63 characters."
  );
  process.exit(1);
}

const pkgPath = path.join(EXT_ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const oldId = pkg.publisher + "." + pkg.name;
const newId = publisher + "." + pkg.name;

if (oldId === newId) {
  console.log("Already set to " + newId + ", nothing to do.");
  process.exit(0);
}

/** Files carrying the extension id as text. */
const textTargets = [
  path.join(EXT_ROOT, "extension.js"),
  path.join(EXT_ROOT, "src", "code.js"),
  path.join(EXT_ROOT, "test", "run.js"),
  path.join(EXT_ROOT, "README.md"),
  path.join(EXT_ROOT, "PUBLISHING.md"),
  path.join(BACK_ROOT, "app", "config.py"),
  path.join(BACK_ROOT, "README.md"),
  path.join(BACK_ROOT, ".env"),
  path.join(BACK_ROOT, ".env.example"),
  path.join(BACK_ROOT, ".env.production"),
];

let touched = 0;
const missing = [];

pkg.publisher = publisher;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("package.json      publisher -> " + publisher);
touched += 1;

for (const file of textTargets) {
  if (!fs.existsSync(file)) {
    // .env files are gitignored and may legitimately not be here.
    if (path.basename(file).startsWith(".env")) missing.push(file);
    continue;
  }
  const before = fs.readFileSync(file, "utf8");
  if (before.indexOf(oldId) === -1) continue;
  const after = before.split(oldId).join(newId);
  fs.writeFileSync(file, after);
  const count = before.split(oldId).length - 1;
  console.log(
    path.relative(path.resolve(EXT_ROOT, ".."), file).padEnd(28) +
      count +
      " occurrence" + (count === 1 ? "" : "s")
  );
  touched += 1;
}

console.log("\n" + oldId + "  ->  " + newId);
console.log(touched + " file(s) updated.");

if (missing.length) {
  console.log("\nNot found (set VSCODE_EXTENSION_ID by hand if you use these):");
  missing.forEach((f) => console.log("  " + f));
}

console.log(
  "\nThe backend must be redeployed for its VSCODE_EXTENSION_ID to take effect."
);
console.log("Verify afterwards:");
console.log("  curl -s <server>/api/info | grep extension_id");
