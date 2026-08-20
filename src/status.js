"use strict";

/** The status-bar entry: session state at a glance, click to open the view. */

const vscode = require("vscode");

const LABELS = {
  idle: { icon: "$(broadcast)", text: "CodeColab" },
  connecting: { icon: "$(sync~spin)", text: "connecting" },
  pending: { icon: "$(clock)", text: "waiting to be admitted" },
  active: { icon: "$(broadcast)", text: "live" },
  paused: { icon: "$(debug-pause)", text: "paused" },
  ended: { icon: "$(circle-slash)", text: "ended" },
};

class StatusBar {
  /** @param {import("./session").SessionController} controller */
  constructor(controller) {
    this.controller = controller;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = "codecolab.showPanelOrStart";
    this.subscription = controller.onDidChange(() => this.render());
    this.render();
    this.item.show();
  }

  render() {
    const c = this.controller;
    const label = LABELS[c.status] || LABELS.idle;

    if (!c.inSession) {
      this.item.text = "$(broadcast) CodeColab";
      this.item.tooltip = "Start or join a live coding session";
      this.item.backgroundColor = undefined;
      return;
    }

    const people = c.participants.filter((p) => p.state === "approved").length;
    const waiting = c.participants.filter((p) => p.state === "pending").length;

    this.item.text =
      label.icon +
      " " +
      label.text +
      (c.status === "active" || c.status === "paused" ? " · " + people : "") +
      (waiting ? " · " + waiting + " waiting" : "");

    this.item.tooltip = new vscode.MarkdownString(
      "**" + (c.session.title || "CodeColab") + "**\n\n" +
        "Status: `" + c.status + "`\n\n" +
        "Your role: `" + (c.role || "?") + "`" +
        (c.session.joinCode ? "\n\nCode: `" + c.session.joinCode + "`" : "")
    );

    this.item.backgroundColor =
      waiting || c.status === "paused"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  }

  dispose() {
    this.subscription.dispose();
    this.item.dispose();
  }
}

module.exports = { StatusBar };
