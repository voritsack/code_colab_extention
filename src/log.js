"use strict";

const vscode = require("vscode");

let channel = null;

function output() {
  if (!channel) {
    channel = vscode.window.createOutputChannel("CodeColab");
  }
  return channel;
}

function stamp() {
  const now = new Date();
  return (
    String(now.getHours()).padStart(2, "0") +
    ":" +
    String(now.getMinutes()).padStart(2, "0") +
    ":" +
    String(now.getSeconds()).padStart(2, "0")
  );
}

function write(level, message) {
  output().appendLine("[" + stamp() + "] " + level + " " + message);
}

module.exports = {
  channel: output,
  info: (message) => write("info ", message),
  warn: (message) => write("warn ", message),
  error: (message) => write("error", message),
  show: () => output().show(true),
  dispose: () => {
    if (channel) channel.dispose();
    channel = null;
  },
};
