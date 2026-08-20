"use strict";

/**
 * The CodeColab view in the activity bar.
 *
 * A webview rather than a tree, because everything you can do to a session
 * should be a button or a field you can see, not a command you have to know
 * the name of. Three tabs: who is here, chat, and a shared drawing board.
 *
 * The extension owns all state; the view renders whatever the controller last
 * reported and posts intents back.
 */

const vscode = require("vscode");
const config = require("./config");
const workspace = require("./workspace");
const { colorFor, readableInk, initials } = require("./colors");

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
  constructor(controller, identity, onIntent, mediaRoot) {
    this.controller = controller;
    this.identity = identity;
    this.onIntent = onIntent;
    this.mediaRoot = mediaRoot || null;
    this.view = null;
    this.busy = null;
    this.followingId = null;

    controller.onDidChange(() => this.render());
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: this.mediaRoot ? [this.mediaRoot] : [],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message.type !== "string") return;
      if (message.type === "ready") {
        this.render();
        return;
      }
      await this.onIntent(message);
    });

    view.onDidChangeVisibility(() => {
      if (view.visible) this.render();
    });

    this.render();
  }

  reveal() {
    if (this.view) this.view.show(true);
    else vscode.commands.executeCommand("codecolab.sessionView.focus");
  }

  setBusy(label) {
    this.busy = label || null;
    this.render();
  }

  setFollowing(participantId) {
    this.followingId = participantId;
    this.render();
  }

  /** Decorate a participant with the colour and initials everyone agrees on. */
  decorate(participant) {
    const { hex } = colorFor(participant.participant_id);
    return {
      id: participant.participant_id,
      name: participant.display_name,
      role: participant.role,
      state: participant.state,
      connected: participant.connected,
      activeFile: participant.active_file,
      edits: participant.edits || 0,
      color: hex,
      ink: readableInk(hex),
      initials: initials(participant.display_name),
    };
  }

  render() {
    if (!this.view) return;
    const c = this.controller;
    const me = colorFor(c.participantId || 0);

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
      followingId: this.followingId,
      myId: c.participantId,
      myColor: me.hex,
      session: c.session
        ? {
            title: c.session.title,
            joinCode: c.session.joinCode,
            joinUrl: c.session.joinUrl,
            hostName: c.session.hostName,
          }
        : null,
      participants: c.participants.map((p) => this.decorate(p)),
      chat: c.chat,
      board: c.board,
      locks: c.locks,
    });
  }

  html(webview) {
    const n = nonce();
    const logo =
      this.mediaRoot && webview
        ? webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, "logo.png"))
        : null;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview ? webview.cspSource : ''} data:; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<style nonce="${n}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 10px 10px 18px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
    color: var(--vscode-descriptionForeground);
    margin: 16px 0 7px; font-weight: 600;
  }
  h2:first-of-type { margin-top: 2px; }
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
  input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
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
    border-radius: 4px; padding: 9px; margin-bottom: 9px;
  }
  .title { font-weight: 600; margin-bottom: 2px; word-break: break-word; }
  .code {
    font-family: var(--vscode-editor-font-family); font-size: 15px;
    letter-spacing: .09em; padding: 5px 9px; border-radius: 3px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.16));
    cursor: pointer; display: inline-block;
  }
  .banner {
    border-left: 3px solid var(--vscode-errorForeground);
    padding: 7px 9px; margin-bottom: 9px; font-size: 12px;
    background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.08));
  }
  .busy { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }

  /* --- avatars --- */
  .avatar {
    width: 26px; height: 26px; border-radius: 50%; flex: none;
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; letter-spacing: .02em;
    border: 2px solid transparent; cursor: pointer; user-select: none;
  }
  .avatar.small { width: 20px; height: 20px; font-size: 8.5px; }
  .avatar.off { opacity: .4; }
  .avatar.following { border-color: var(--vscode-focusBorder); }
  .stack { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }

  /* --- tabs --- */
  .tabs {
    display: flex; gap: 2px; margin-bottom: 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
  }
  .tab {
    padding: 5px 9px; font-size: 11px; cursor: pointer;
    border: none; background: none; border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground);
  }
  .tab:hover { color: var(--vscode-foreground); background: none; }
  .tab.on {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
  }
  .badge {
    display: inline-block; min-width: 15px; padding: 0 4px; margin-left: 4px;
    border-radius: 8px; font-size: 9px; line-height: 14px; text-align: center;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }

  /* --- people --- */
  .person {
    display: flex; align-items: flex-start; gap: 8px; padding: 7px 0;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
  }
  .person:last-child { border-bottom: none; }
  .who { flex: 1; min-width: 0; }
  .file {
    font-family: var(--vscode-editor-font-family); font-size: 10px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .acts { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 5px; }

  /* --- chat --- */
  .log {
    max-height: 320px; overflow-y: auto; margin-bottom: 8px;
    display: flex; flex-direction: column; gap: 7px;
  }
  .msg { display: flex; gap: 7px; align-items: flex-start; }
  .msg .body { min-width: 0; }
  .msg .from { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .msg .text { font-size: 12px; word-wrap: break-word; white-space: pre-wrap; }
  .composer { display: flex; gap: 5px; }
  .composer input { flex: 1; }

  /* --- board --- */
  .boardwrap {
    position: relative; width: 100%; margin-bottom: 8px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    border-radius: 4px; overflow: hidden;
    background: var(--vscode-editor-background, #1e1e1e);
  }
  canvas { display: block; width: 100%; touch-action: none; cursor: crosshair; }
  .tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .swatch {
    width: 18px; height: 18px; border-radius: 50%; cursor: pointer;
    border: 2px solid transparent;
  }
  .swatch.on { border-color: var(--vscode-focusBorder); }
  .sizes { display: flex; gap: 4px; }

  .foot {
    margin-top: 16px; padding-top: 9px; font-size: 10px;
    color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
    word-break: break-all;
  }
  .foot button { margin-top: 6px; }
  .brandbar {
    display: flex; align-items: center; gap: 7px; margin-bottom: 10px;
    font-weight: 600; font-size: 12px;
  }
  .brandbar img { border-radius: 4px; }
</style>
</head>
<body>
${logo ? `<div class="brandbar"><img src="${logo}" width="20" height="20" alt=""><span>CodeColab</span></div>` : ""}
<div id="root"></div>
<script nonce="${n}">
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const PALETTE = ["#1ABCFE","#F24E1E","#A259FF","#0ACF83","#FF4D8D","#FFC02E","#00B5AD","#FF7262"];

  let state = null;
  let tab = "people";
  let seenChat = 0;
  let pen = { color: null, width: 3, tool: "pen" };
  let board = { canvas: null, ctx: null, drawn: 0, stroke: null };

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

  function checkbox(labelText, isChecked, id) {
    const wrap = el("div", "check");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = !!isChecked;
    wrap.appendChild(input);
    wrap.appendChild(el("span", null, labelText));
    return wrap;
  }

  const val = (id) => {
    const node = document.getElementById(id);
    return node ? node.value.trim() : "";
  };
  const isChecked = (id) => {
    const node = document.getElementById(id);
    return node ? node.checked : false;
  };

  function avatar(person, size, onClick) {
    const node = el("div", "avatar" + (size ? " " + size : ""), person.initials);
    node.style.background = person.color;
    node.style.color = person.ink;
    if (!person.connected) node.classList.add("off");
    if (state.followingId === person.id) node.classList.add("following");
    node.title =
      person.name + " \\u00b7 " + person.role +
      (person.activeFile ? "\\n" + person.activeFile : "") +
      (person.id === state.myId ? "\\n(you)" : "\\nClick to follow");
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }

  // ---- idle ---------------------------------------------------------------

  function renderIdle() {
    root.appendChild(field("Your name", state.displayName, "name", "Shown to everyone"));

    root.appendChild(el("h2", null, "Start a session"));
    if (!state.hasFolder) {
      root.appendChild(el("p", "muted small",
        "Open a folder first - that folder is what you share."));
      root.appendChild(button("Open folder\\u2026", "secondary block", () => send("openFolder")));
    } else {
      root.appendChild(field("Session name", state.folder, "title", state.folder));
      root.appendChild(checkbox("I admit each person", true, "approve"));
      root.appendChild(checkbox("Anyone with the code can ask to join", true, "guests"));
      root.appendChild(button("Start session", "block", () => {
        send("start", {
          displayName: val("name"),
          title: val("title") || state.folder,
          requireApproval: isChecked("approve"),
          allowGuests: isChecked("guests")
        });
      }));
    }

    root.appendChild(el("h2", null, "Join a session"));
    root.appendChild(field("Code or invite link", "", "code", "abc-defg-hij"));
    root.appendChild(button("Join", "secondary block", () => {
      send("join", { displayName: val("name"), code: val("code") });
    }));
  }

  // ---- session header -----------------------------------------------------

  function renderHeader() {
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
    card.appendChild(el("div", "small muted",
      (state.isHost ? "you are the host" : "host " + (s.hostName || "?")) +
      " \\u00b7 " + state.status +
      (state.role && !state.isHost ? " \\u00b7 " + state.role : "")));

    if (state.isHost && s.joinCode) {
      const code = el("div", "code", s.joinCode);
      code.title = "Click to copy";
      code.addEventListener("click", () => send("copyCode"));
      const holder = el("div");
      holder.style.margin = "8px 0 7px";
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
      return false;
    }

    // Avatar row - click one to follow them around the project.
    const others = state.participants.filter((p) => p.state === "approved");
    if (others.length) {
      const stack = el("div", "stack");
      others.forEach((p) => {
        stack.appendChild(avatar(p, null, () => {
          if (p.id !== state.myId) send("follow", { id: p.id });
        }));
      });
      root.appendChild(stack);
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
      if (state.role === "viewer") {
        actions.appendChild(button("Ask to edit", null, () => send("requestEdit")));
      }
      actions.appendChild(button("Resync", "secondary", () => send("resync")));
      actions.appendChild(button("Leave", "danger", () => send("leave")));
    }
    root.appendChild(actions);
    return true;
  }

  function renderTabs() {
    const bar = el("div", "tabs");
    const unread = Math.max(state.chat.length - seenChat, 0);

    [["people", "People", state.participants.length],
     ["chat", "Chat", tab === "chat" ? 0 : unread],
     ["board", "Board", 0]].forEach(([key, label, count]) => {
      const b = el("button", "tab" + (tab === key ? " on" : ""), label);
      if (count) b.appendChild(el("span", "badge", count));
      b.addEventListener("click", () => {
        tab = key;
        if (key === "chat") seenChat = state.chat.length;
        board.drawn = 0;
        render();
      });
      bar.appendChild(b);
    });
    root.appendChild(bar);
  }

  // ---- people -------------------------------------------------------------

  function renderPeople() {
    if (!state.participants.length) {
      root.appendChild(el("p", "muted small", "Nobody else yet."));
      return;
    }
    const list = el("div", "card");
    state.participants.forEach((p) => {
      const row = el("div", "person");
      row.appendChild(avatar(p, "small", () => {
        if (p.id !== state.myId) send("follow", { id: p.id });
      }));

      const who = el("div", "who");
      who.appendChild(el("div", null, p.name + (p.id === state.myId ? " (you)" : "")));
      who.appendChild(el("div", "file",
        p.state === "pending"
          ? "wants to join"
          : p.role + (p.connected ? "" : " \\u00b7 offline") +
            (p.activeFile ? " \\u00b7 " + p.activeFile : "") +
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
            p.role === "editor" ? "Make view-only" : "Allow editing", "secondary tiny",
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

  // ---- chat ---------------------------------------------------------------

  function renderChat() {
    const log = el("div", "log");
    if (!state.chat.length) {
      log.appendChild(el("p", "muted small", "No messages yet."));
    } else {
      state.chat.forEach((m) => {
        const person = state.participants.find((p) => p.id === m.participantId);
        const colour = person ? person.color : PALETTE[Math.abs(m.participantId || 0) % PALETTE.length];
        const row = el("div", "msg");
        const dot = el("div", "avatar small",
          person ? person.initials : (m.displayName || "?").slice(0, 2).toUpperCase());
        dot.style.background = colour;
        dot.style.color = person ? person.ink : "#fff";
        dot.style.cursor = "default";
        row.appendChild(dot);
        const body = el("div", "body");
        body.appendChild(el("div", "from", m.displayName));
        body.appendChild(el("div", "text", m.text));
        row.appendChild(body);
        log.appendChild(row);
      });
    }
    root.appendChild(log);
    log.scrollTop = log.scrollHeight;

    const composer = el("div", "composer");
    const input = document.createElement("input");
    input.type = "text";
    input.id = "chatText";
    input.placeholder = "Message everyone";
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      send("chat", { text });
      input.value = "";
    };
    composer.appendChild(input);
    composer.appendChild(button("Send", null, submit));
    root.appendChild(composer);
    seenChat = state.chat.length;
  }

  // ---- board --------------------------------------------------------------

  function renderBoard() {
    if (!pen.color) pen.color = state.myColor || PALETTE[0];

    const tools = el("div", "tools");
    PALETTE.forEach((hex) => {
      const sw = el("div", "swatch" + (pen.color === hex && pen.tool === "pen" ? " on" : ""));
      sw.style.background = hex;
      sw.title = "Draw in this colour";
      sw.addEventListener("click", () => {
        pen.color = hex;
        pen.tool = "pen";
        render();
      });
      tools.appendChild(sw);
    });
    tools.appendChild(button("Eraser", pen.tool === "eraser" ? "tiny" : "secondary tiny",
      () => { pen.tool = pen.tool === "eraser" ? "pen" : "eraser"; render(); }));
    [2, 4, 8].forEach((w) => {
      tools.appendChild(button(String(w), pen.width === w ? "tiny" : "secondary tiny",
        () => { pen.width = w; render(); }));
    });
    root.appendChild(tools);

    const wrap = el("div", "boardwrap");
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    root.appendChild(wrap);

    const clear = el("div", "row");
    clear.appendChild(button("Clear mine", "secondary tiny", () => send("boardClear", { scope: "mine" })));
    if (state.isHost) {
      clear.appendChild(button("Clear everything", "secondary tiny",
        () => send("boardClear", { scope: "all" })));
    }
    root.appendChild(clear);
    root.appendChild(el("p", "muted small",
      "Everyone sees this, including people in view-only mode."));

    board.canvas = canvas;
    board.ctx = canvas.getContext("2d");
    board.drawn = 0;
    sizeCanvas();
    attachDrawing();
  }

  function sizeCanvas() {
    if (!board.canvas) return;
    const width = board.canvas.clientWidth || 260;
    const height = Math.round(width * 0.72);
    const ratio = window.devicePixelRatio || 1;
    board.canvas.width = Math.round(width * ratio);
    board.canvas.height = Math.round(height * ratio);
    board.canvas.style.height = height + "px";
    board.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    board.drawn = 0;
    paintBoard();
  }

  function strokePath(stroke) {
    const ctx = board.ctx;
    const w = board.canvas.clientWidth;
    const h = parseFloat(board.canvas.style.height) || w * 0.72;
    const points = stroke.points || [];
    if (!points.length) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke.width || 3;
    if (stroke.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = (stroke.width || 3) * 3;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = stroke.color || "#1ABCFE";
    }
    ctx.beginPath();
    ctx.moveTo(points[0][0] * w, points[0][1] * h);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i][0] * w, points[i][1] * h);
    }
    if (points.length === 1) ctx.lineTo(points[0][0] * w + 0.1, points[0][1] * h);
    ctx.stroke();
    ctx.restore();
  }

  function paintBoard() {
    if (!board.ctx || tab !== "board") return;
    const strokes = state.board || [];
    if (board.drawn > strokes.length) board.drawn = 0;
    if (board.drawn === 0) {
      board.ctx.clearRect(0, 0, board.canvas.width, board.canvas.height);
    }
    for (let i = board.drawn; i < strokes.length; i += 1) strokePath(strokes[i]);
    board.drawn = strokes.length;
  }

  function attachDrawing() {
    const canvas = board.canvas;
    const at = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [
        Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1),
        Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1)
      ];
    };

    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      board.stroke = { color: pen.color, width: pen.width, tool: pen.tool, points: [at(event)] };
    });

    canvas.addEventListener("pointermove", (event) => {
      if (!board.stroke) return;
      board.stroke.points.push(at(event));
      // Draw the tail as it happens; the finished stroke is sent on release.
      strokePath({
        color: board.stroke.color,
        width: board.stroke.width,
        tool: board.stroke.tool,
        points: board.stroke.points.slice(-2)
      });
    });

    const finish = () => {
      if (!board.stroke) return;
      const stroke = board.stroke;
      board.stroke = null;
      if (stroke.points.length) {
        board.drawn += 1; // the controller appends it locally too
        send("draw", { stroke });
      }
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);
    canvas.addEventListener("pointerleave", finish);
  }

  // ---- shell --------------------------------------------------------------

  function render() {
    if (!state) return;
    const chatText = document.getElementById("chatText");
    const keptChat = chatText ? chatText.value : "";

    root.textContent = "";
    board.canvas = null;
    board.ctx = null;

    if (state.busy) root.appendChild(el("div", "busy", state.busy + "\\u2026"));

    if (!state.inSession) {
      renderIdle();
    } else if (renderHeader()) {
      renderTabs();
      if (tab === "people") renderPeople();
      else if (tab === "chat") renderChat();
      else renderBoard();
    }

    const foot = el("div", "foot");
    foot.appendChild(el("div", null, state.server));
    foot.appendChild(button("Show log", "secondary tiny", () => send("showLog")));
    root.appendChild(foot);

    if (keptChat) {
      const restored = document.getElementById("chatText");
      if (restored) restored.value = keptChat;
    }
  }

  window.addEventListener("resize", () => {
    if (tab === "board") sizeCanvas();
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "state") return;

    const typed = document.getElementById("name");
    const boardGrew =
      state && tab === "board" && (message.board || []).length !== (state.board || []).length;
    const shallow =
      state &&
      state.inSession === message.inSession &&
      state.status === message.status &&
      tab === "board";

    state = message;
    if (typed && typed.value.trim()) state.displayName = typed.value;

    // While drawing, repaint the canvas instead of rebuilding the whole view -
    // rebuilding would throw away the stroke in progress.
    if (shallow && board.ctx) {
      if (boardGrew) paintBoard();
      return;
    }
    render();
  });

  send("ready");
})();
</script>
</body>
</html>`;
  }
}

module.exports = { SessionPanel };
