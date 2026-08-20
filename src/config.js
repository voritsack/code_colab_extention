"use strict";

/**
 * Every tunable the extension reads.
 *
 * Precedence for the two connection settings is environment variable, then
 * VS Code setting, then the built-in default. Values are read lazily so a
 * change in Settings takes effect without a window reload.
 */

const vscode = require("vscode");

const SECTION = "codecolab";
const DEFAULT_SERVER_URL = "http://5.83.153.81:25589";

function conf() {
  return vscode.workspace.getConfiguration(SECTION);
}

function trimSlashes(value) {
  return String(value).replace(/\/+$/, "");
}

function serverUrl() {
  const value =
    process.env.CODECOLAB_SERVER_URL ||
    conf().get("serverUrl") ||
    DEFAULT_SERVER_URL;
  return trimSlashes(value);
}

function wsUrl() {
  const explicit = process.env.CODECOLAB_WS_URL || conf().get("wsUrl");
  if (explicit) return trimSlashes(explicit);
  return serverUrl().replace(/^http/, "ws");
}

function excludeGlobs() {
  const patterns = conf().get("exclude") || [];
  if (!patterns.length) return null;
  return "{" + patterns.join(",") + "}";
}

module.exports = {
  SECTION,
  DEFAULT_SERVER_URL,
  serverUrl,
  wsUrl,
  excludeGlobs,
  maxFileBytes: () => Number(conf().get("maxFileBytes")) || 512000,
  maxFiles: () => Number(conf().get("maxFiles")) || 2000,
  syncDelayMs: () => Number(conf().get("syncDelayMs")) || 300,
  autoOpenPanel: () => conf().get("autoOpenPanel") !== false,
  setServerUrl: (value) =>
    conf().update("serverUrl", trimSlashes(value), vscode.ConfigurationTarget.Global),
};
