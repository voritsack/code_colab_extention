"use strict";

/**
 * Who you are, as far as CodeColab is concerned.
 *
 * There are no accounts. Identity is a display name you pick once and that
 * everyone in the session sees, remembered per machine so you are not asked
 * again. It is not a credential and grants nothing on its own - what you are
 * allowed to do comes from the session token you hold.
 */

const vscode = require("vscode");
const os = require("os");

const KEY = "codecolab.displayName";
const MIN_LENGTH = 2;
const MAX_LENGTH = 120;

class Identity {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
  }

  /** Best guess for a first-run default. */
  suggest() {
    const stored = this.context.globalState.get(KEY);
    if (stored) return stored;
    try {
      const info = os.userInfo();
      if (info && info.username) return info.username;
    } catch (err) {
      /* some containers have no passwd entry */
    }
    return "";
  }

  get() {
    return this.context.globalState.get(KEY) || "";
  }

  async set(name) {
    const clean = String(name || "").trim().slice(0, MAX_LENGTH);
    if (clean.length < MIN_LENGTH) {
      throw new Error("Pick a name of at least " + MIN_LENGTH + " characters.");
    }
    await this.context.globalState.update(KEY, clean);
    return clean;
  }

  /** Return the stored name, asking for one if there is none yet. */
  async require(prompt) {
    const existing = this.get();
    if (existing) return existing;

    const answer = await vscode.window.showInputBox({
      title: "CodeColab",
      prompt: prompt || "What name should other people see?",
      value: this.suggest(),
      ignoreFocusOut: true,
      validateInput: (value) =>
        value && value.trim().length >= MIN_LENGTH
          ? null
          : "At least " + MIN_LENGTH + " characters",
    });
    if (!answer) return null;
    return this.set(answer);
  }
}

module.exports = { Identity, MIN_LENGTH, MAX_LENGTH };
