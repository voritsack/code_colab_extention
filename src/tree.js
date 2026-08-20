"use strict";

/** The CodeColab view in the activity bar. */

const vscode = require("vscode");

const STATUS_ICON = {
  idle: "circle-outline",
  connecting: "sync",
  pending: "clock",
  active: "broadcast",
  paused: "debug-pause",
  disconnected: "debug-disconnect",
  ended: "circle-slash",
};

class Node extends vscode.TreeItem {
  constructor(label, collapsibleState) {
    super(label, collapsibleState || vscode.TreeItemCollapsibleState.None);
  }
}

class SessionTreeProvider {
  /** @param {import("./session").SessionController} controller */
  constructor(controller) {
    this.controller = controller;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    controller.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    const c = this.controller;
    if (!c.inSession) return [];

    if (!element) return this.rootNodes();
    if (element.id === "participants") return this.participantNodes();
    return [];
  }

  rootNodes() {
    const c = this.controller;
    const nodes = [];

    const title = new Node(c.session.title || "Session");
    title.id = "session";
    title.description = c.isHost ? c.status + " · you are the host" : c.status + " · " + c.role;
    title.iconPath = new vscode.ThemeIcon(STATUS_ICON[c.status] || "circle-outline");
    title.tooltip = new vscode.MarkdownString(
      "**" + (c.session.title || "Session") + "**\n\n" +
        "Status: `" + c.status + "`\n\n" +
        "Your role: `" + (c.role || "unknown") + "`"
    );
    nodes.push(title);

    if (c.isDisconnected) {
      // Offered before the invite details, because it is the only thing
      // worth doing from here.
      const retry = new Node("Disconnected - click to reconnect");
      retry.id = "reconnect";
      retry.iconPath = new vscode.ThemeIcon(
        "debug-disconnect",
        new vscode.ThemeColor("charts.red")
      );
      retry.command = { command: "codecolab.reconnect", title: "Reconnect" };
      if (c.lastError) {
        retry.description = c.lastError.message;
        retry.tooltip = new vscode.MarkdownString(
          "**" + c.lastError.message + "**\n\n" + c.lastError.hint
        );
      }
      nodes.push(retry);
    }

    if (c.isHost && c.session.joinCode) {
      const code = new Node("Code  " + c.session.joinCode);
      code.id = "code";
      code.iconPath = new vscode.ThemeIcon("key");
      code.tooltip = "Click to copy the join code";
      code.command = { command: "codecolab.copyCode", title: "Copy join code" };
      nodes.push(code);

      const link = new Node("Invite link");
      link.id = "link";
      link.description = c.session.joinUrl;
      link.iconPath = new vscode.ThemeIcon("link");
      link.tooltip = "Click to copy " + c.session.joinUrl;
      link.command = { command: "codecolab.copyInvite", title: "Copy invite link" };
      nodes.push(link);
    }

    if (c.status === "pending") {
      const waiting = new Node("Waiting for the host to admit you");
      waiting.id = "waiting";
      waiting.iconPath = new vscode.ThemeIcon("clock");
      nodes.push(waiting);
      return nodes;
    }

    const group = new Node(
      "Participants",
      vscode.TreeItemCollapsibleState.Expanded
    );
    group.id = "participants";
    group.description = String(c.participants.length);
    group.iconPath = new vscode.ThemeIcon("organization");
    nodes.push(group);

    return nodes;
  }

  participantNodes() {
    const c = this.controller;
    if (!c.participants.length) {
      const empty = new Node("Nobody else yet");
      empty.iconPath = new vscode.ThemeIcon("person");
      return [empty];
    }

    return c.participants.map((p) => {
      const node = new Node(p.display_name);
      node.id = "participant-" + p.participant_id;
      node.participantId = p.participant_id;

      if (p.state === "pending") {
        node.description = "wants to join";
        node.iconPath = new vscode.ThemeIcon(
          "question",
          new vscode.ThemeColor("charts.yellow")
        );
        node.contextValue = c.isHost ? "pendingParticipant" : "participant";
      } else {
        const where = p.active_file ? " · " + p.active_file : "";
        node.description = p.role + (p.connected ? "" : " · offline") + where;
        node.iconPath = new vscode.ThemeIcon(
          p.role === "host" ? "star-full" : p.role === "editor" ? "edit" : "eye",
          p.connected ? new vscode.ThemeColor("charts.green") : undefined
        );
        if (p.role === "host") {
          node.contextValue = "hostParticipant";
        } else if (c.isHost) {
          node.contextValue = p.role === "editor" ? "editorParticipant" : "viewerParticipant";
        } else {
          node.contextValue = "participant";
        }
      }

      node.tooltip = new vscode.MarkdownString(
        "**" + p.display_name + "**" + (p.is_guest ? " _(guest)_" : "") + "\n\n" +
          "Role: `" + p.role + "`\n\n" +
          "State: `" + p.state + "`\n\n" +
          "Editing: `" + (p.active_file || "nothing") + "`\n\n" +
          "Edits: " + (p.edits || 0)
      );
      return node;
    });
  }
}

module.exports = { SessionTreeProvider };
