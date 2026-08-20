"use strict";

/**
 * The session controller: everything that happens between "start" and "end".
 *
 * It owns the WebSocket, the local edit listeners, and the participant roster,
 * and it is the only place that decides whether a keystroke leaves this
 * machine or a remote edit lands on disk.
 */

const vscode = require("vscode");
const WebSocket = require("ws");

const config = require("./config");
const log = require("./log");
const workspace = require("./workspace");
const { sanitizeRelativePath } = require("./paths");

const CLOSE = {
  UNAUTHORIZED: 4001,
  BAD_MESSAGE: 4002,
  DENIED: 4003,
  REPLACED: 4004,
  REMOVED: 4005,
  ENDED: 4006,
  TOO_FAST: 4008,
  TOO_LARGE: 4009,
};

const TERMINAL_CLOSE_CODES = new Set([
  CLOSE.DENIED,
  CLOSE.REMOVED,
  CLOSE.ENDED,
  CLOSE.REPLACED,
  CLOSE.UNAUTHORIZED,
]);

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

// Reverse proxies close idle upstream connections - nginx defaults to 60
// seconds - and a session where nobody is typing is idle by definition. A
// heartbeat well inside that window keeps the socket alive whatever the proxy
// in front is configured to do, and doubles as dead-peer detection: TCP alone
// can take minutes to notice a connection that is gone.
const HEARTBEAT_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 70000;

class SessionController {
  /**
   * @param {import("./api").Api} api
   */
  constructor(api) {
    this.api = api;
    this.clientId = "vscode-" + Math.random().toString(36).slice(2, 11);

    this.session = null; // { publicId, title, joinCode, joinUrl, ... }
    this.participants = [];
    this.status = "idle"; // idle | connecting | active | paused | pending | ended
    this.role = null;
    this.participantId = null;
    this.sessionToken = null;

    this.ws = null;
    this.lastError = null; // { message, hint } while status is "disconnected"
    this._closing = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;

    this._listeners = [];
    this._heartbeat = null;
    this._lastPong = 0;
    this._pending = new Map(); // path -> timer
    this._lastRemote = new Map(); // path -> content we just applied
    this._presenceTimer = null;

    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  // -- state ------------------------------------------------------------

  get isHost() {
    return this.role === "host";
  }

  get inSession() {
    return this.session !== null;
  }

  get canEdit() {
    return (
      (this.role === "host" || this.role === "editor") && this.status === "active"
    );
  }

  get isDisconnected() {
    return this.status === "disconnected";
  }

  changed() {
    this._onDidChange.fire(this);
    vscode.commands.executeCommand("setContext", "codecolab.inSession", this.inSession);
    vscode.commands.executeCommand("setContext", "codecolab.isHost", this.isHost);
    vscode.commands.executeCommand("setContext", "codecolab.status", this.status);
  }

  // -- starting ---------------------------------------------------------

  /** Create a session from the current workspace and return the invite. */
  async startHosting({ title, displayName, allowGuests, requireApproval, accessCode }) {
    if (this.inSession) {
      throw new Error("Already in a session. End it first.");
    }
    if (!workspace.rootFolder()) {
      throw new Error("Open a folder in VS Code before starting a session.");
    }

    const created = await this.api.createSession({
      title,
      display_name: displayName,
      workspace_name: workspace.rootName(),
      allow_guests: allowGuests,
      require_approval: requireApproval,
      access_code: accessCode || null,
    });

    this.session = {
      publicId: created.public_id,
      title: created.title,
      joinCode: created.join_code,
      joinUrl: created.join_url,
      vscodeLink: created.vscode_link,
      allowGuests: created.allow_guests,
      requireApproval: created.require_approval,
      hostName: created.host_name,
    };
    this.role = "host";
    this.participantId = created.participant_id;
    this.sessionToken = created.session_token;
    this.status = "connecting";
    this.changed();

    await this.pushWorkspace({ silent: true });
    await this.connect();
    return this.session;
  }

  /** Join an existing session. Returns the join result. */
  async joinWithCode(code, { displayName } = {}) {
    if (this.inSession) {
      throw new Error("Already in a session. Leave it first.");
    }

    const result = await this.api.join({
      code,
      displayName,
      clientId: this.clientId,
    });

    this.session = {
      publicId: result.public_id,
      title: result.title,
      hostName: result.host_name,
      joinCode: code,
      joinUrl: config.serverUrl() + "/j/" + code,
    };
    this.role = result.role;
    this.participantId = result.participant_id;
    this.sessionToken = result.session_token;
    this.status = result.state === "pending" ? "pending" : "connecting";
    this.changed();

    await this.connect();
    return result;
  }

  // -- socket -----------------------------------------------------------

  connect() {
    if (!this.session || !this.sessionToken) return Promise.resolve(false);

    const url = config.wsUrl() + "/ws/session/" + this.session.publicId;
    log.info("Connecting to " + url);

    return new Promise((resolve) => {
      let settled = false;
      const socket = new WebSocket(url, {
        headers: { Authorization: "Bearer " + this.sessionToken },
        handshakeTimeout: 15000,
      });
      this.ws = socket;
      this._closing = false;

      socket.on("open", () => {
        log.info("Socket open");
        this._reconnectAttempt = 0;
        this.attachWorkspaceListeners();
        this.startHeartbeat();
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });

      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch (err) {
          log.warn("Ignored malformed frame");
          return;
        }
        this.handleMessage(message).catch((err) =>
          log.error("Handler failed: " + (err && err.message))
        );
      });

      // Fires when the server answers the upgrade request with an ordinary
      // HTTP response instead of 101. Listening for it means ws hands us the
      // status and leaves cleanup to us: no "error" or "close" will follow.
      socket.on("unexpected-response", (request, response) => {
        const httpStatus = response.statusCode;
        response.resume();
        request.destroy();
        this.ws = null;
        this.detachWorkspaceListeners();
        if (!settled) {
          settled = true;
          resolve(false);
        }
        this.onHandshakeRejected(httpStatus);
      });

      socket.on("error", (err) => {
        log.error("Socket error: " + err.message);
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });

      socket.on("close", (code, reasonBuffer) => {
        const reason = reasonBuffer ? reasonBuffer.toString() : "";
        log.info("Socket closed (" + code + ") " + reason);
        this.stopHeartbeat();
        this.detachWorkspaceListeners();
        if (!settled) {
          settled = true;
          resolve(false);
        }
        this.onSocketClosed(code, reason);
      });
    });
  }

  onSocketClosed(code, reason) {
    if (this._closing) return;

    if (TERMINAL_CLOSE_CODES.has(code)) {
      const messages = {
        [CLOSE.DENIED]: "The host did not admit you.",
        [CLOSE.REMOVED]: "The host removed you from the session.",
        [CLOSE.ENDED]: "The session has ended.",
        [CLOSE.REPLACED]: "This session was opened in another window.",
        [CLOSE.UNAUTHORIZED]: "The session rejected your token: " + reason,
      };
      // These are decisions about your membership, not transport problems:
      // the session really is over for you, so clearing it is right.
      vscode.window.showWarningMessage("CodeColab: " + messages[code]);
      this.reset();
      return;
    }

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this._reconnectAttempt += 1;
    if (this._reconnectAttempt > RECONNECT_DELAYS_MS.length) {
      this.goOffline({
        message: "Lost the connection and could not get it back.",
        hint: "The session is still on the server - reconnect when you are ready.",
      });
      return;
    }

    this.status = "connecting";
    this.changed();
    log.info("Reconnecting in " + delay + "ms (attempt " + this._reconnectAttempt + ")");
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * The server answered the upgrade request with plain HTTP.
   *
   * Nearly always a proxy that does not forward WebSocket connections, and
   * retrying will never fix that - so say what is actually wrong instead of
   * counting down six attempts and reporting "lost the connection".
   */
  onHandshakeRejected(httpStatus) {
    if (this._closing) return;

    log.error("WebSocket handshake rejected with HTTP " + httpStatus);

    if (httpStatus === 401 || httpStatus === 403) {
      this.goOffline({
        message: "The server refused this session (HTTP " + httpStatus + ").",
        hint: "Sign in again, or ask the host for a fresh invite.",
      });
      return;
    }

    if (httpStatus >= 500) {
      // The origin is having a bad time, and that can pass. Keep retrying.
      this.onSocketClosed(1006, "server error during handshake");
      return;
    }

    this.goOffline({
      message:
        "The server would not upgrade the connection to a WebSocket (HTTP " +
        httpStatus +
        ").",
      hint:
        "Something in front of " +
        config.wsUrl() +
        " is not forwarding WebSocket connections. On Cloudflare, turn on " +
        "Network > WebSockets; on nginx the location needs " +
        "proxy_http_version 1.1 with the Upgrade and Connection headers. " +
        "Live editing cannot work until that is fixed.",
    });
  }

  /**
   * Drop the socket but keep the session.
   *
   * Clearing it here would throw away the invite link and the participant
   * list over what is usually a temporary network problem - and the server
   * would still consider the session live, so there would be nothing to
   * rejoin with.
   */
  goOffline(error) {
    this.stopHeartbeat();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.detachWorkspaceListeners();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (err) {
        /* already gone */
      }
      this.ws = null;
    }

    this.status = "disconnected";
    this.lastError = error;
    this.changed();

    vscode.window
      .showErrorMessage(
        "CodeColab: " + error.message + " " + error.hint,
        "Reconnect",
        "Show log",
        "Leave session"
      )
      .then((choice) => {
        if (choice === "Reconnect") {
          vscode.commands.executeCommand("codecolab.reconnect");
        } else if (choice === "Show log") {
          log.show();
        } else if (choice === "Leave session") {
          this.reset();
        }
      });
  }

  /** Manual retry after goOffline. */
  async reconnect() {
    if (!this.session || !this.sessionToken) {
      throw new Error("No session to reconnect to.");
    }
    this._reconnectAttempt = 0;
    this._closing = false;
    this.lastError = null;
    this.status = "connecting";
    this.changed();

    const ok = await this.connect();
    if (!ok && this.status === "connecting") {
      // connect() gave up without any handler having reported a reason.
      this.goOffline({
        message: "Could not reach the session.",
        hint: "Check the server URL and your network, then try again.",
      });
    }
    return ok;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this._lastPong = Date.now();
    this._heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      if (Date.now() - this._lastPong > HEARTBEAT_TIMEOUT_MS) {
        // Frames are going out and nothing is coming back: the connection is
        // gone even though the socket still looks open. Kill it so the normal
        // reconnect path runs instead of waiting on TCP.
        log.warn("No response to heartbeat - dropping the connection");
        try {
          this.ws.terminate();
        } catch (err) {
          /* already gone */
        }
        return;
      }

      this.send({ type: "ping", t: Date.now() });
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      log.warn("Send failed: " + err.message);
      return false;
    }
  }

  // -- incoming ---------------------------------------------------------

  async handleMessage(message) {
    switch (message.type) {
      case "hello":
        this.role = message.you.role;
        this.participantId = message.you.participant_id;
        this.status = message.you.state === "pending" ? "pending" : message.session.status;
        this.session = Object.assign({}, this.session, {
          title: message.session.title,
          joinCode: message.session.join_code || this.session.joinCode,
          allowGuests: message.session.allow_guests,
          requireApproval: message.session.require_approval,
          workspaceName: message.session.workspace_name,
        });
        this.changed();
        break;

      case "pending":
        this.status = "pending";
        this.changed();
        vscode.window.setStatusBarMessage(
          "$(clock) CodeColab: waiting for the host to admit you",
          8000
        );
        break;

      case "approved":
        this.role = message.role;
        this.status = message.session.status;
        this.changed();
        vscode.window.showInformationMessage(
          "CodeColab: you are in — " +
            (message.role === "editor" ? "you can edit." : "view-only.")
        );
        break;

      case "denied":
      case "removed":
        vscode.window.showWarningMessage("CodeColab: " + message.reason);
        this.reset();
        break;

      case "snapshot":
        await this.applySnapshot(message.files, message.status);
        break;

      case "file_update":
        await this.applyRemoteFile(message.path, message.content);
        break;

      case "file_deleted":
        await this.applyRemoteDelete(message.path);
        break;

      case "participants":
        this.participants = message.participants || [];
        this.changed();
        break;

      case "participant_joined":
        vscode.window.setStatusBarMessage(
          "$(person-add) " + message.participant.display_name + " joined",
          5000
        );
        break;

      case "participant_left":
        this.participants = this.participants.filter(
          (p) => p.participant_id !== message.participant_id
        );
        this.changed();
        break;

      case "join_request":
        await this.promptAdmit(message.participant);
        break;

      case "role_changed":
        this.role = message.role;
        this.changed();
        vscode.window.showInformationMessage(
          "CodeColab: the host set you to " + message.role + "."
        );
        break;

      case "session_state":
        this.status = message.status;
        this.changed();
        vscode.window.showInformationMessage(
          message.status === "paused"
            ? "CodeColab: the host paused the session — edits are frozen."
            : "CodeColab: the session is live again."
        );
        break;

      case "session_ended":
        vscode.window.showInformationMessage("CodeColab: " + message.reason);
        this.reset();
        break;

      case "presence":
        this.notePresence(message);
        break;

      case "error":
        this.handleServerError(message);
        break;

      case "pong":
        this._lastPong = Date.now();
        break;

      default:
        log.info("Unhandled frame: " + message.type);
    }
  }

  handleServerError(message) {
    if (message.code === "paused") {
      vscode.window.setStatusBarMessage(
        "$(debug-pause) CodeColab: the session is paused",
        4000
      );
      return;
    }
    if (message.code === "forbidden") {
      vscode.window.setStatusBarMessage("$(lock) CodeColab: " + message.message, 4000);
      return;
    }
    log.warn("Server: " + message.code + " - " + message.message);
    if (message.code === "file_too_large" || message.code === "bad_path") {
      vscode.window.showWarningMessage("CodeColab: " + message.message);
    }
  }

  notePresence(message) {
    const person = this.participants.find(
      (p) => p.participant_id === message.participant_id
    );
    if (person) {
      person.active_file = message.path;
      this.changed();
    }
  }

  async promptAdmit(participant) {
    if (!this.isHost) return;
    const who =
      participant.display_name + (participant.is_guest ? " (guest)" : "");
    const choice = await vscode.window.showInformationMessage(
      who + " wants to join \"" + this.session.title + "\"",
      { modal: false },
      "Admit as editor",
      "Admit view-only",
      "Refuse"
    );
    if (choice === "Admit as editor") {
      this.approve(participant.participant_id, "editor");
    } else if (choice === "Admit view-only") {
      this.approve(participant.participant_id, "viewer");
    } else if (choice === "Refuse") {
      this.deny(participant.participant_id);
    }
    // Dismissing the notification leaves them waiting in the view, where the
    // host can still admit or refuse them.
  }

  // -- applying remote changes ------------------------------------------

  async applySnapshot(files, status) {
    if (status) this.status = status;
    if (!Array.isArray(files) || !files.length) {
      this.changed();
      return;
    }

    let written = 0;
    for (const file of files) {
      if (typeof file.path !== "string" || typeof file.content !== "string") continue;
      if (await this.applyRemoteFile(file.path, file.content)) written += 1;
    }
    log.info("Applied snapshot: " + written + " file(s)");
    this.changed();
  }

  async applyRemoteFile(path, content) {
    if (typeof content !== "string") return false;
    let safe;
    try {
      safe = sanitizeRelativePath(path);
    } catch (err) {
      log.warn("Refused remote path " + path + ": " + err.message);
      return false;
    }
    this._lastRemote.set(safe, content);
    try {
      return await workspace.writeContent(safe, content);
    } catch (err) {
      log.error("Could not write " + safe + ": " + err.message);
      return false;
    }
  }

  async applyRemoteDelete(path) {
    try {
      const safe = sanitizeRelativePath(path);
      this._lastRemote.delete(safe);
      await workspace.deleteContent(safe);
      return true;
    } catch (err) {
      log.warn("Could not delete " + path + ": " + err.message);
      return false;
    }
  }

  // -- outgoing ---------------------------------------------------------

  attachWorkspaceListeners() {
    if (this._listeners.length) return;

    this._listeners.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!event.contentChanges.length) return;
        this.queueEdit(event.document);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => this.queueEdit(doc, true)),
      vscode.workspace.onDidCreateFiles((event) => {
        event.files.forEach((uri) => this.sendFileFromDisk(uri));
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        event.files.forEach((uri) => {
          const relative = workspace.relativePathOf(uri);
          if (relative && this.canEdit) {
            this.send({ type: "file_delete", path: relative });
          }
        });
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        event.files.forEach(({ oldUri, newUri }) => {
          const from = workspace.relativePathOf(oldUri);
          if (from && this.canEdit) this.send({ type: "file_delete", path: from });
          this.sendFileFromDisk(newUri);
        });
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.sendPresence(editor)),
      vscode.window.onDidChangeTextEditorSelection((event) =>
        this.sendPresence(event.textEditor)
      )
    );

    this.sendPresence(vscode.window.activeTextEditor);
  }

  detachWorkspaceListeners() {
    this._listeners.forEach((d) => d.dispose());
    this._listeners = [];
    this._pending.forEach((timer) => clearTimeout(timer));
    this._pending.clear();
  }

  queueEdit(document, immediate = false) {
    if (!this.canEdit) return;
    const relative = workspace.relativePathOf(document.uri);
    if (!relative) return;

    const text = document.getText();
    // Do not echo back the edit we have just applied on this peer's behalf.
    if (this._lastRemote.get(relative) === text) return;

    if (Buffer.byteLength(text, "utf8") > config.maxFileBytes()) {
      return;
    }

    const existing = this._pending.get(relative);
    if (existing) clearTimeout(existing);

    const flush = () => {
      this._pending.delete(relative);
      if (!this.canEdit) return;
      const current = document.isClosed ? text : document.getText();
      if (this._lastRemote.get(relative) === current) return;
      this._lastRemote.delete(relative);
      this.send({ type: "file_update", path: relative, content: current });
    };

    if (immediate) {
      flush();
    } else {
      this._pending.set(relative, setTimeout(flush, config.syncDelayMs()));
    }
  }

  async sendFileFromDisk(uri) {
    if (!this.canEdit) return;
    const relative = workspace.relativePathOf(uri);
    if (!relative) return;
    try {
      const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
      if (bytes.length > config.maxFileBytes()) return;
      if (bytes.includes(0)) return; // binary
      this.send({ type: "file_update", path: relative, content: bytes.toString("utf8") });
    } catch (err) {
      /* the file may have vanished again already */
    }
  }

  sendPresence(editor) {
    if (!this.inSession || this.status === "pending") return;
    if (this._presenceTimer) clearTimeout(this._presenceTimer);
    this._presenceTimer = setTimeout(() => {
      const relative = editor ? workspace.relativePathOf(editor.document.uri) : null;
      const position = editor ? editor.selection.active : null;
      this.send({
        type: "presence",
        path: relative,
        line: position ? position.line + 1 : null,
        column: position ? position.character + 1 : null,
      });
    }, 400);
  }

  /** Upload the whole workspace, replacing whatever the server holds. */
  async pushWorkspace({ silent = false } = {}) {
    if (!this.session) throw new Error("No session");
    if (!this.isHost) throw new Error("Only the host can push the workspace");

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "CodeColab: sharing workspace", cancellable: true },
      async (progress, token) => {
        progress.report({ message: "reading files…" });
        const scan = await workspace.collectFiles(token);
        if (token.isCancellationRequested) return null;
        progress.report({ message: "uploading " + scan.files.length + " file(s)…" });
        await this.api.uploadSnapshot(
          this.session.publicId,
          this.sessionToken,
          scan.files
        );
        return scan;
      }
    );

    if (!result) return null;

    if (result.truncated) {
      vscode.window.showWarningMessage(
        "CodeColab: only the first " +
          config.maxFiles() +
          " files were shared. Narrow the folder or adjust codecolab.maxFiles."
      );
    }
    if (result.skipped.length) {
      log.info("Skipped " + result.skipped.length + " file(s): " + result.skipped.join(", "));
    }
    if (!silent) {
      vscode.window.showInformationMessage(
        "CodeColab: shared " + result.files.length + " file(s)."
      );
    }
    return result;
  }

  async resync() {
    if (!this.session || !this.sessionToken) return;
    const snapshot = await this.api.downloadSnapshot(
      this.session.publicId,
      this.sessionToken
    );
    await this.applySnapshot(snapshot.files, snapshot.status);
    vscode.window.showInformationMessage(
      "CodeColab: resynchronised " + snapshot.files.length + " file(s)."
    );
  }

  // -- host controls ----------------------------------------------------

  pause() {
    this.send({ type: "pause" });
  }

  resume() {
    this.send({ type: "resume" });
  }

  approve(participantId, role) {
    this.send({ type: "approve_join", participant_id: participantId, role });
  }

  deny(participantId) {
    this.send({ type: "deny_join", participant_id: participantId });
  }

  setRole(participantId, role) {
    this.send({ type: "set_role", participant_id: participantId, role });
  }

  removeParticipant(participantId) {
    this.send({ type: "remove_participant", participant_id: participantId });
  }

  async end() {
    if (!this.session) return;
    this.send({ type: "end_session" });
    // Fall back to REST in case the socket is already gone.
    try {
      await this.api.lifecycle(this.session.publicId, this.sessionToken, "end");
    } catch (err) {
      log.warn("REST end failed: " + err.message);
    }
    this.reset();
  }

  leave() {
    this.reset();
  }

  reset() {
    this._closing = true;
    this.stopHeartbeat();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.detachWorkspaceListeners();
    if (this._presenceTimer) {
      clearTimeout(this._presenceTimer);
      this._presenceTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (err) {
        /* already gone */
      }
      this.ws = null;
    }
    this.session = null;
    this.participants = [];
    this.role = null;
    this.participantId = null;
    this.sessionToken = null;
    this.status = "idle";
    this.lastError = null;
    this._lastRemote.clear();
    this._reconnectAttempt = 0;
    this.changed();
  }

  dispose() {
    this.reset();
    this._onDidChange.dispose();
  }
}

module.exports = { SessionController, CLOSE };
