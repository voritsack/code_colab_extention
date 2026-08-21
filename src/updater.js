"use strict";

/**
 * Keeping the extension up to date.
 *
 * A sideloaded VSIX never updates itself, so the server that hosts the
 * sessions also hosts the build and a version manifest, and this polls it.
 *
 * Installing a VSIX runs whatever code is inside it, so however convenient
 * silent updates are, there are three rules that are not negotiable:
 *
 *   1. Only ever from the configured server. A join link can point anywhere,
 *      and a link must never be able to install code.
 *   2. Silent installs need an authenticated transport - https, or a loopback
 *      address for local development. Over plain http anyone on the network
 *      can answer for the server, and a silent install would hand them the
 *      machine. There we downgrade to asking, rather than refusing.
 *   3. The download must match the digest the manifest advertised.
 *
 * `codecolab.autoUpdate` chooses between "silent", "ask" and "off".
 *
 * A silent update also reloads the window by itself, but only when there is
 * no session running: reloading drops the socket, and finishing somebody's
 * pair-programming call to install a patch is not an improvement.
 *
 * Activation alone is not enough to call this automatic - a window left open
 * for a week would check once - so `poll()` keeps looking on a timer.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const config = require("./config");
const log = require("./log");
const { request, download } = require("./http");

const LAST_CHECK_KEY = "codecolab.lastUpdateCheck";
/**
 * An extension is identified by `<publisher>.<name>`, so every publisher
 * change makes VS Code see a different extension and install it beside the
 * old one rather than over it. Two copies then activate together: two
 * pollers, two panels, two sets of commands bidding for the same names.
 *
 * The publisher went `voritsack` -> `codecolab` -> `ddatunashvili`, and the
 * server handed out builds under each, so a machine can be carrying either of
 * the first two. The current build removes both.
 */
const LEGACY_EXTENSION_IDS = ["voritsack.codecolab", "codecolab.codecolab"];
const SKIPPED_KEY = "codecolab.skippedVersion";
const CHECK_EVERY_MS = 60 * 60 * 1000; // hourly - a build should not sit unseen all day
const POLL_EVERY_MS = 15 * 60 * 1000; // how often the timer looks; the throttle above decides

/** "2.10.0" > "2.9.0" - a plain string compare gets this wrong. */
function isNewer(candidate, current) {
  const a = String(candidate).split(".").map((n) => parseInt(n, 10) || 0);
  const b = String(current).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left > right;
  }
  return false;
}

/** Is this origin safe enough to install from without asking? */
function trustedTransport(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return ["localhost", "127.0.0.1", "::1"].indexOf(parsed.hostname) !== -1;
  } catch (err) {
    return false;
  }
}

/**
 * Uninstall any pre-rename copy still installed.
 *
 * Safe to call at any time: it skips ids that are not installed, and it never
 * removes the id we are running as - an extension asking for its own removal
 * would be torn down half way through this function, before it could install
 * anything or reload the window.
 *
 * @param {vscode.ExtensionContext} [context] used to identify the running
 *   extension; when omitted the self-check falls back to the id lookup.
 * @returns {Promise<string[]>} the ids that were removed
 */
async function removeLegacyInstall(context) {
  const own = context && context.extension && context.extension.id;
  const removed = [];

  for (const id of LEGACY_EXTENSION_IDS) {
    if (own && own.toLowerCase() === id) continue;
    if (!vscode.extensions.getExtension(id)) continue;
    try {
      await vscode.commands.executeCommand(
        "workbench.extensions.uninstallExtension",
        id
      );
      log.info("Removed the superseded " + id);
      removed.push(id);
    } catch (err) {
      // Not fatal. Two copies running is untidy, not broken, and the person
      // can remove the old one by hand; failing the update over it is worse.
      log.warn(
        "Could not remove " +
          id +
          ": " +
          (err && err.message ? err.message : String(err))
      );
    }
  }
  return removed;
}

class Updater {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {{isBusy?: () => boolean}} [hooks] `isBusy` tells the updater not
   *   to reload the window on its own - there is a session in progress.
   */
  constructor(context, hooks) {
    this.context = context;
    this.currentVersion =
      (context.extension && context.extension.packageJSON.version) || "0.0.0";
    this.busy = false;
    this.isBusy =
      hooks && typeof hooks.isBusy === "function" ? hooks.isBusy : () => false;
  }

  /**
   * Keep checking while the window is open. The timer is deliberately more
   * frequent than the throttle: it is what makes a machine that woke from
   * sleep notice a build, and `check()` still refuses to ask the server more
   * than once per CHECK_EVERY_MS.
   *
   * @returns {vscode.Disposable} stop polling
   */
  poll() {
    const timer = setInterval(() => {
      this.check().catch((err) => log.info("Update check skipped: " + err.message));
    }, POLL_EVERY_MS);
    if (typeof timer.unref === "function") timer.unref();
    return { dispose: () => clearInterval(timer) };
  }

  mode() {
    const value = vscode.workspace.getConfiguration("codecolab").get("autoUpdate");
    return value === "off" || value === "ask" ? value : "silent";
  }

  /**
   * @param {{force?: boolean}} options force skips the throttle and the
   *   "skip this version" memory, for the manual command.
   */
  async check({ force = false } = {}) {
    if (this.busy) return null;
    if (!force && this.mode() === "off") return null;

    const last = this.context.globalState.get(LAST_CHECK_KEY) || 0;
    if (!force && Date.now() - last < CHECK_EVERY_MS) return null;
    await this.context.globalState.update(LAST_CHECK_KEY, Date.now());

    let manifest;
    try {
      manifest = await request(config.serverUrl() + "/api/extension/latest", {
        timeoutMs: 10000,
      });
    } catch (err) {
      log.info("Update check failed: " + err.message);
      return null;
    }

    if (!manifest || !manifest.available) return null;
    if (!isNewer(manifest.version, this.currentVersion)) {
      if (force) {
        vscode.window.showInformationMessage(
          "CodeColab " + this.currentVersion + " is the latest version."
        );
      }
      return null;
    }

    if (!force && this.context.globalState.get(SKIPPED_KEY) === manifest.version) {
      return null;
    }

    log.info(
      "Update available: " + this.currentVersion + " -> " + manifest.version
    );

    const silent = this.mode() === "silent" && trustedTransport(manifest.url);
    if (silent && !force) return this.install(manifest, { silent: true });

    if (this.mode() === "silent" && !silent) {
      log.warn(
        "Silent updates are configured but " +
          config.serverUrl() +
          " is not https, so this one is being confirmed instead."
      );
    }

    const choice = await vscode.window.showInformationMessage(
      "CodeColab " + manifest.version + " is available." +
        (manifest.notes ? " " + manifest.notes : ""),
      "Install",
      "Later",
      "Skip this version"
    );
    if (choice === "Install") return this.install(manifest, { silent: false });
    if (choice === "Skip this version") {
      await this.context.globalState.update(SKIPPED_KEY, manifest.version);
    }
    return null;
  }

  async install(manifest, { silent }) {
    if (this.busy) return null;
    this.busy = true;

    const target = path.join(
      os.tmpdir(),
      "codecolab-" + manifest.version + "-" + Date.now() + ".vsix"
    );

    try {
      log.info("Downloading " + manifest.url);
      const result = await download(manifest.url, target);

      if (manifest.sha256 && result.sha256 !== manifest.sha256) {
        throw new Error(
          "the download did not match the published checksum, so it was discarded"
        );
      }

      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        vscode.Uri.file(target)
      );
      log.info("Installed CodeColab " + manifest.version);

      // Usually a no-op: during the rename the code running this *is* the old
      // copy, so it declines to remove itself and the freshly installed build
      // does it on its first activation instead. This covers the other order,
      // where the new build is already the one updating.
      await removeLegacyInstall(this.context);

      // The new code cannot run until the window reloads. A silent update
      // does that itself - that is the point of it - but never while a
      // session is running, because the reload would drop everyone.
      if (silent && !this.isBusy()) {
        vscode.window.setStatusBarMessage(
          "$(check) CodeColab updated to " + manifest.version,
          6000
        );
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        return manifest.version;
      }

      const choice = await vscode.window.showInformationMessage(
        "CodeColab updated to " +
          manifest.version +
          (silent
            ? ". It starts working when this window reloads - your session is safe until then."
            : ". Reload to start using it."),
        "Reload now",
        "Later"
      );
      if (choice === "Reload now") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
      return manifest.version;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log.error("Update failed: " + message);
      if (!silent) {
        vscode.window.showErrorMessage("CodeColab: update failed - " + message);
      }
      return null;
    } finally {
      this.busy = false;
      fs.rm(target, { force: true }, () => {});
    }
  }
}

module.exports = {
  Updater,
  isNewer,
  trustedTransport,
  removeLegacyInstall,
  LEGACY_EXTENSION_IDS,
  CHECK_EVERY_MS,
  POLL_EVERY_MS,
};
