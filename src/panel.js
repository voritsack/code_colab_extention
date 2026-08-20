"use strict";

/**
 * The CodeColab view in the activity bar.
 *
 * A webview rather than a tree, because everything you can do to a session
 * should be a button or a field you can see, not a command you have to know
 * the name of. The extension owns all state; the view renders whatever the
 * controller last reported and posts intents back.
 */

const vscode = require("vscode");
const config = require("./config");
const workspace = require("./workspace");

function nonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

class SessionPanel {
  /**
   * @param {import("./session").SessionController} controller
   * @param {import("./identity").Identity} identity
   * @param {(intent: object) => Promise<void>|void} onIntent
   */
  constructor(controller, identity, onIntent) {
    this.controller = controller;
    this.identity = identity;
    this.onIntent = onIntent;
    this.view = null;
    this.busy = null;

    controller.onDidChange(() => this.render());
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message.type !== "string") return;
      if (message.type === "ready") {
        this.render();
        return;
      }
      await this.onIntent(message);
    });

    // The webview is torn down when the view is hidden and rebuilt when it
    // comes back, so push the current state every time it becomes visible.
    view.onDidChangeVisibility(() => {
      if (view.visible) this.render();
    });

    this.render();
  }

  reveal() {
    if (this.view) {
      this.view.show(true);
    } else {
      vscode.commands.executeCommand("codecolab.sessionView.focus");
    }
  }

  setBusy(label) {
    this.busy = label || null;
    this.render();
  }

  render() {
    if (!this.view) return;
    const c = this.controller;

    this.view.webview.postMessage({
      type: "state",
      busy: this.busy,
      server: config.serverUrl(),
      displayName: this.identity.get() || this.identity.suggest(),
      folder: workspace.rootName(),
      hasFolder: Boolean(workspace.rootFolder()),
      inSession: c.inSession,
      isHost: c.isHost,
      status: c.status,
      role: c.role,
      canEdit: c.canEdit,
      lastError: c.lastError,
      session: c.session
        ? {
            title: c.session.title,
            joinCode: c.session.joinCode,
            joinUrl: c.session.joinUrl,
            hostName: c.session.hostName,
            workspaceName: c.session.workspaceName,
          }
        : null,
      participants: c.participants.map((p) => ({
        id: p.participant_id,
        name: p.display_name,
        role: p.role,
        state: p.state,
        connected: p.connected,
        activeFile: p.active_file,
        edits: p.edits || 0,
      })),
    });
  }

  html(webview) {
    const n = nonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<style nonce="${n}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px 12px 20px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
    color: var(--vscode-descriptionForeground);
    margin: 18px 0 8px; font-weight: 600;
  }
  h2:first-of-type { margin-top: 4px; }
  p { margin: 0 0 8px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: 11px; }
  label { display: block; margin-bottom: 10px; }
  label > span {
    display: block; margin-bottom: 4px; font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  input[type=text] {
    width: 100%; padding: 5px 8px; font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
  }
  input[type=text]:focus {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
  }
  .check { display: flex; align-items: flex-start; gap: 7px; margin-bottom: 8px; }
  .check input { margin: 2px 0 0; }
  .check span { font-size: 12px; }
  button {
    font: inherit; padding: 5px 11px; border: 1px solid transparent;
    border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger { background: var(--vscode-errorForeground); color: #fff; }
  button.tiny { padding: 2px 7px; font-size: 11px; }
  button.block { display: block; width: 100%; margin-top: 4px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    border-radius: 4px; padding: 10px; margin-bottom: 10px;
  }
  .title { font-weight: 600; margin-bottom: 2px; word-break: break-word; }
  .pill {
    display: inline-block; padding: 1px 7px; border-radius: 9px;
    font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
    border: 1px solid currentColor;
  }
  .pill.active { color: var(--vscode-testing-iconPassed, #3fb950); }
  .pill.paused { color: var(--vscode-editorWarning-foreground, #d29922); }
  .pill.pending { color: var(--vscode-editorWarning-foreground, #d29922); }
  .pill.connecting { color: var(--vscode-descriptionForeground); }
  .pill.disconnected { color: var(--vscode-errorForeground); }
  .code {
    font-family: var(--vscode-editor-font-family); font-size: 15px;
    letter-spacing: .09em; padding: 6px 9px; border-radius: 3px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.16));
    cursor: pointer; display: inline-block;
  }
  .banner {
    border-left: 3px solid var(--vscode-errorForeground);
    padding: 7px 10px; margin-bottom: 10px; font-size: 12px;
    background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.08));
  }
  .person {
    display: flex; align-items: flex-start; gap: 8px; padding: 7px 0;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
  }
  .person:last-child { border-bottom: none; }
  .dot {
    width: 7px; height: 7px; border-radius: 50%; margin-top: 6px; flex: none;
    background: var(--vscode-descriptionForeground); opacity: .45;
  }
  .dot.on { background: var(--vscode-testing-iconPassed, #3fb950); opacity: 1; }
  .who { flex: 1; min-width: 0; }
  .file {
    font-family: var(--vscode-editor-font-family); font-size: 10px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .acts { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 5px; }
  .busy { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .foot {
    margin-top: 18px; padding-top: 10px; font-size: 10px;
    color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
    word-break: break-all;
  }
  .foot button { margin-top: 6px; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${n}">
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  let state = null;

  const send = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(label, cls, handler, disabled) {
    const b = el("button", cls, label);
    if (disabled) b.disabled = true;
    else b.addEventListener("click", handler);
    return b;
  }

  function field(labelText, value, id, placeholder) {
    const wrap = el("label");
    wrap.appendChild(el("span", null, labelText));
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.value = value || "";
    if (placeholder) input.placeholder = placeholder;
    wrap.appendChild(input);
    return wrap;
  }

  function checkbox(labelText, checked, id) {
    const wrap = el("div", "check");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = !!checked;
    wrap.appendChild(input);
    wrap.appendChild(el("span", null, labelText));
    return wrap;
  }

  function val(id) {
    const node = document.getElementById(id);
    return node ? node.value.trim() : "";
  }
  function checked(id) {
    const node = document.getElementById(id);
    return node ? node.checked : false;
  }

  function renderIdle() {
    root.appendChild(field("Your name", state.displayName, "name", "Shown to everyone"));

    root.appendChild(el("h2", null, "Start a session"));
    if (!state.hasFolder) {
      root.appendChild(el("p", "muted small",
        "Open a folder first - that folder is what you share."));
      root.appendChild(button("Open folder\\u2026", "secondary block",
        () => send("openFolder")));
    } else {
      root.appendChild(field("Session name", state.folder, "title", state.folder));
      root.appendChild(checkbox("I admit each person", true, "approve"));
      root.appendChild(checkbox("Anyone with the code can ask to join", true, "guests"));
      root.appendChild(button("Start session", "block", () => {
        send("start", {
          displayName: val("name"),
          title: val("title") || state.folder,
          requireApproval: checked("approve"),
          allowGuests: checked("guests")
        });
      }));
    }

    root.appendChild(el("h2", null, "Join a session"));
    root.appendChild(field("Code or invite link", "", "code", "abc-defg-hij"));
    root.appendChild(button("Join", "secondary block", () => {
      send("join", { displayName: val("name"), code: val("code") });
    }));
  }

  function renderSession() {
    const s = state.session || {};

    if (state.status === "disconnected") {
      const banner = el("div", "banner");
      banner.appendChild(el("div", null,
        (state.lastError && state.lastError.message) || "Disconnected."));
      if (state.lastError && state.lastError.hint) {
        banner.appendChild(el("div", "small muted", state.lastError.hint));
      }
      root.appendChild(banner);
      root.appendChild(button("Reconnect", "block", () => send("reconnect")));
    }

    const card = el("div", "card");
    card.appendChild(el("div", "title", s.title || "Session"));
    const meta = el("div", "small muted");
    meta.appendChild(document.createTextNode(
      (state.isHost ? "you are the host" : "host " + (s.hostName || "?")) +
      " \\u00b7 " + state.status +
      (state.role && !state.isHost ? " \\u00b7 " + state.role : "")));
    card.appendChild(meta);

    if (state.isHost && s.joinCode) {
      const code = el("div", "code", s.joinCode);
      code.title = "Click to copy";
      code.addEventListener("click", () => send("copyCode"));
      const holder = el("div");
      holder.style.margin = "9px 0 8px";
      holder.appendChild(code);
      card.appendChild(holder);

      const row = el("div", "row");
      row.appendChild(button("Copy link", "secondary tiny", () => send("copyLink")));
      row.appendChild(button("Open page", "secondary tiny", () => send("openPage")));
      card.appendChild(row);
    }
    root.appendChild(card);

    if (state.status === "pending") {
      root.appendChild(el("p", "muted small", "Waiting for the host to let you in."));
    }

    const actions = el("div", "row");
    if (state.isHost) {
      if (state.status === "paused") {
        actions.appendChild(button("Resume", null, () => send("resume")));
      } else {
        actions.appendChild(button("Pause", "secondary", () => send("pause"),
          state.status !== "active"));
      }
      actions.appendChild(button("Push workspace", "secondary", () => send("push"),
        state.status === "disconnected"));
      actions.appendChild(button("End session", "danger", () => send("end")));
    } else {
      actions.appendChild(button("Resync", "secondary", () => send("resync"),
        state.status === "pending"));
      actions.appendChild(button("Leave", "danger", () => send("leave")));
    }
    root.appendChild(actions);

    if (state.status === "pending") return;

    root.appendChild(el("h2", null, "People (" + state.participants.length + ")"));
    if (!state.participants.length) {
      root.appendChild(el("p", "muted small", "Nobody else yet."));
      return;
    }

    const list = el("div", "card");
    state.participants.forEach((p) => {
      const row = el("div", "person");
      row.appendChild(el("span", "dot" + (p.connected ? " on" : "")));

      const who = el("div", "who");
      who.appendChild(el("div", null, p.name));
      who.appendChild(el("div", "file",
        p.state === "pending"
          ? "wants to join"
          : p.role + (p.activeFile ? " \\u00b7 " + p.activeFile : "") +
            (p.edits ? " \\u00b7 " + p.edits + " edits" : "")));

      if (state.isHost && p.role !== "host") {
        const acts = el("div", "acts");
        if (p.state === "pending") {
          acts.appendChild(button("Admit as editor", "tiny",
            () => send("approve", { id: p.id, role: "editor" })));
          acts.appendChild(button("View only", "secondary tiny",
            () => send("approve", { id: p.id, role: "viewer" })));
          acts.appendChild(button("Refuse", "secondary tiny",
            () => send("deny", { id: p.id })));
        } else {
          acts.appendChild(button(
            p.role === "editor" ? "Make view-only" : "Allow editing",
            "secondary tiny",
            () => send("role", { id: p.id, role: p.role === "editor" ? "viewer" : "editor" })));
          acts.appendChild(button("Remove", "secondary tiny",
            () => send("remove", { id: p.id })));
        }
        who.appendChild(acts);
      }

      row.appendChild(who);
      list.appendChild(row);
    });
    root.appendChild(list);
  }

  function render() {
    if (!state) return;
    root.textContent = "";

    if (state.busy) root.appendChild(el("div", "busy", state.busy + "\\u2026"));

    if (state.inSession) renderSession();
    else renderIdle();

    const foot = el("div", "foot");
    foot.appendChild(el("div", null, state.server));
    foot.appendChild(button("Show log", "secondary tiny", () => send("showLog")));
    root.appendChild(foot);
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "state") {
      // Keep whatever is half-typed in the name box across re-renders.
      const typed = document.getElementById("name");
      state = message;
      if (typed && typed.value.trim()) state.displayName = typed.value;
      render();
    }
  });

  send("ready");
})();
</script>
</body>
</html>`;
  }
}

module.exports = { SessionPanel };
