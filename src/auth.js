"use strict";

/**
 * Account sign-in and token custody.
 *
 * Tokens live in VS Code's SecretStorage, keyed by server origin, so pointing
 * the extension at a different backend never reuses credentials issued by
 * another one. The access token is short-lived; a 401 triggers one silent
 * refresh before the user is asked for anything.
 */

const vscode = require("vscode");
const config = require("./config");
const log = require("./log");
const { request, HttpError } = require("./http");

const KEY_PREFIX = "codecolab.tokens:";

class Auth {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this._cache = null;
    this._refreshing = null;
  }

  key() {
    return KEY_PREFIX + config.serverUrl();
  }

  async load() {
    if (this._cache && this._cache.origin === config.serverUrl()) {
      return this._cache;
    }
    const raw = await this.context.secrets.get(this.key());
    if (!raw) {
      this._cache = null;
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      parsed.origin = config.serverUrl();
      this._cache = parsed;
      return parsed;
    } catch (err) {
      await this.context.secrets.delete(this.key());
      return null;
    }
  }

  async store(tokens) {
    const record = {
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      user: tokens.user,
      origin: config.serverUrl(),
    };
    await this.context.secrets.store(this.key(), JSON.stringify(record));
    this._cache = record;
    this._onDidChange.fire(record.user);
    return record;
  }

  async clear() {
    await this.context.secrets.delete(this.key());
    this._cache = null;
    this._onDidChange.fire(null);
  }

  async currentUser() {
    const record = await this.load();
    return record ? record.user : null;
  }

  async isSignedIn() {
    return (await this.load()) !== null;
  }

  /**
   * Run an authenticated request, refreshing once on 401.
   * @param {(token: string) => Promise<any>} run
   */
  async withToken(run, { interactive = true } = {}) {
    let record = await this.load();
    if (!record) {
      if (!interactive) return null;
      record = await this.signIn();
      if (!record) return null;
    }

    try {
      return await run(record.access);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 401) throw err;
    }

    const refreshed = await this.refresh();
    if (refreshed) {
      return run(refreshed.access);
    }

    if (!interactive) return null;
    const again = await this.signIn("Your session expired. Sign in again.");
    if (!again) return null;
    return run(again.access);
  }

  async refresh() {
    if (this._refreshing) return this._refreshing;

    this._refreshing = (async () => {
      const record = await this.load();
      if (!record || !record.refresh) return null;
      try {
        const tokens = await request(config.serverUrl() + "/api/auth/refresh", {
          method: "POST",
          body: { refresh_token: record.refresh },
        });
        log.info("Refreshed access token");
        return await this.store(tokens);
      } catch (err) {
        log.warn("Refresh failed: " + err.message);
        await this.clear();
        return null;
      } finally {
        this._refreshing = null;
      }
    })();

    return this._refreshing;
  }

  async signIn(prompt) {
    const server = config.serverUrl();
    if (prompt) vscode.window.showWarningMessage(prompt);

    const email = await vscode.window.showInputBox({
      title: "CodeColab sign in",
      prompt: "Email for " + server,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value && value.indexOf("@") > 0 ? null : "Enter a valid email address",
    });
    if (!email) return null;

    const password = await vscode.window.showInputBox({
      title: "CodeColab sign in",
      prompt: "Password",
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return null;

    try {
      const tokens = await request(server + "/api/auth/login", {
        method: "POST",
        body: { email: email.trim(), password },
      });
      const record = await this.store(tokens);
      vscode.window.showInformationMessage(
        "Signed in to CodeColab as " + tokens.user.name
      );
      return record;
    } catch (err) {
      const message = err.message || String(err);
      log.error("Sign in failed: " + message);
      const choice = await vscode.window.showErrorMessage(
        "Sign in failed: " + message,
        "Create an account"
      );
      if (choice === "Create an account") return this.register(email);
      return null;
    }
  }

  async register(prefillEmail) {
    const server = config.serverUrl();

    const email = await vscode.window.showInputBox({
      title: "Create a CodeColab account",
      prompt: "Email for " + server,
      value: prefillEmail || "",
      ignoreFocusOut: true,
      validateInput: (value) =>
        value && value.indexOf("@") > 0 ? null : "Enter a valid email address",
    });
    if (!email) return null;

    const name = await vscode.window.showInputBox({
      title: "Create a CodeColab account",
      prompt: "Display name others will see",
      ignoreFocusOut: true,
      validateInput: (value) => (value && value.trim() ? null : "Required"),
    });
    if (!name) return null;

    const password = await vscode.window.showInputBox({
      title: "Create a CodeColab account",
      prompt: "Password (at least 8 characters)",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value && value.length >= 8 ? null : "At least 8 characters",
    });
    if (!password) return null;

    try {
      const tokens = await request(server + "/api/auth/register", {
        method: "POST",
        body: { email: email.trim(), name: name.trim(), password },
      });
      const record = await this.store(tokens);
      vscode.window.showInformationMessage("Welcome to CodeColab, " + tokens.user.name);
      return record;
    } catch (err) {
      log.error("Registration failed: " + err.message);
      vscode.window.showErrorMessage("Could not create the account: " + err.message);
      return null;
    }
  }

  async signOut() {
    const record = await this.load();
    if (record && record.refresh) {
      try {
        await request(config.serverUrl() + "/api/auth/logout", {
          method: "POST",
          body: { refresh_token: record.refresh },
        });
      } catch (err) {
        // The local token is being discarded either way.
        log.warn("Server-side logout failed: " + err.message);
      }
    }
    await this.clear();
    vscode.window.showInformationMessage("Signed out of CodeColab");
  }

  dispose() {
    this._onDidChange.dispose();
  }
}

module.exports = { Auth };
