#!/usr/bin/env python3
"""Cut a release: bump, package, publish, push.

    python release.py                 # patch bump
    python release.py --minor
    python release.py --notes "fix X"

Bumps VScode-ex/package.json, builds the .vsix into the workspace root, copies
it into the backend's downloads folder with a fresh manifest, and pushes both
repositories. The deployed server rebuilds from git on start, so the push is
what actually hands the build to installed extensions.

This script lives in the extension repo but drives both of them, so it
locates the workspace root by walking up from its own location rather than
assuming a working directory.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

def find_root(start: Path) -> Path:
    """Locate the workspace directory holding both repositories."""
    for candidate in (start, *start.parents):
        if (candidate / "VScode-ex").is_dir() and (candidate / "BACK").is_dir():
            return candidate
    raise SystemExit(
        f"no directory containing both VScode-ex and BACK found at or above {start}"
    )


ROOT = find_root(Path(__file__).resolve().parent)
EXT = ROOT / "VScode-ex"
BACK = ROOT / "BACK"


def run(cmd: list[str], cwd: Path) -> None:
    print(f"\n$ {' '.join(cmd)}   ({cwd.name})")
    subprocess.run(cmd, cwd=cwd, check=True, shell=(sys.platform == "win32"))


def dirty(cwd: Path) -> bool:
    """Does this repository have uncommitted changes?"""
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        shell=(sys.platform == "win32"),
    )
    return bool(result.stdout.strip())


def commit_pending(cwd: Path, message: str) -> None:
    """Commit whatever is sitting in the tree.

    `vsce package <part>` bumps the version through `npm version`, which
    refuses to run on a dirty tree - so the work being released has to be
    committed before the release can start. Doing it here rather than
    failing with "Git working directory not clean" keeps this one command.
    """
    if not dirty(cwd):
        return
    print(f"\n{cwd.name} has uncommitted changes; committing them first.")
    run(["git", "add", "-A"], cwd)
    run(["git", "commit", "-m", message], cwd)


def next_version(current: str, part: str) -> str:
    major, minor, patch = (int(n) for n in current.split(".")[:3])
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--minor", action="store_true", help="bump the minor version")
    parser.add_argument("--major", action="store_true", help="bump the major version")
    parser.add_argument("--notes", default="", help="short changelog line")
    parser.add_argument("--no-push", action="store_true", help="commit but do not push")
    parser.add_argument(
        "--dry-run", action="store_true", help="say what would happen and stop"
    )
    args = parser.parse_args()

    part = "major" if args.major else "minor" if args.minor else "patch"
    current = json.loads((EXT / "package.json").read_text(encoding="utf-8"))["version"]
    version = next_version(current, part)
    vsix = ROOT / f"codecolab-{version}.vsix"
    print(f"{current} -> {version}")
    if args.dry_run:
        for repo in (EXT, BACK):
            print(f"  {repo.name}: {'uncommitted changes' if dirty(repo) else 'clean'}")
        print("dry run: nothing committed, built or pushed")
        return 0

    # Whatever is being released has to be committed before the bump, or
    # `npm version` inside vsce refuses to run.
    message = args.notes.strip() or "prepare release"
    commit_pending(EXT, message)
    commit_pending(BACK, message)

    # vsce bumps package.json and commits the change itself.
    run(["npx", "vsce", "package", part, "-o", str(vsix)], EXT)
    run([sys.executable, "scripts/publish_extension.py", str(vsix),
         *(["--notes", args.notes] if args.notes else [])], BACK)

    run(["git", "add", "app/static/downloads"], BACK)
    run(["git", "commit", "-m", f"publish {version}"], BACK)
    if not args.no_push:
        run(["git", "push"], BACK)
        run(["git", "push", "--follow-tags"], EXT)

    print(f"\nreleased {version} -> {vsix.name}")
    print("Installed extensions pick it up within six hours, or immediately")
    print("via the CodeColab: Check for updates command.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
