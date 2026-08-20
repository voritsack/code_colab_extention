"use strict";

/**
 * Integration test for the extension against a running CodeColab server.
 *
 *   node test/run.js [serverUrl]
 *
 * Drives the real extension modules through a stand-in for the `vscode`
 * module: once as the host with a scripted guest on a raw socket, once as the
 * guest with a scripted host, and once against a proxy that refuses to
 * upgrade. There are no accounts anywhere - identity is a display name.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const stub = require("./vscode-stub");
stub.install();

const WebSocket = require("ws");
const { state, emitters } = stub;

const SERVER = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/+$/, "");
const WS_BASE = SERVER.replace(/^http/, "ws");
state.settings["codecolab.serverUrl"] = SERVER;

const { request } = require("../src/http");
const { Api } = require("../src/api");
const { Identity } = require("../src/identity");
const { SessionController } = require("../src/session");
const { SessionPanel } = require("../src/panel");
const { PresenceView } = require("../src/presence");
const { isNewer, trustedTransport } = require("../src/updater");
const { colorFor, initials } = require("../src/colors");
const { normalizeCode } = require("../src/code");
const paths = require("../src/paths");

const failures = [];
let checks = 0;

function check(label, condition, extra) {
  checks += 1;
  if (condition) {
    console.log("[PASS] " + label);
  } else {
    failures.push(label + (extra ? " - " + extra : ""));
    console.log("[FAIL] " + label + (extra ? " - " + extra : ""));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 8000, interval = 60, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error("Timed out waiting for " + what);
}

function tempWorkspace(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeContext() {
  const store = new Map();
  return {
    subscriptions: [],
    globalState: {
      get: (key) => store.get(key),
      update: async (key, value) => void store.set(key, value),
    },
    secrets: {
      get: async (key) => store.get(key),
      store: async (key, value) => void store.set(key, value),
      delete: async (key) => void store.delete(key),
    },
  };
}

function memoryStore() {
  let value = null;
  return {
    read: () => value,
    write: (v) => {
      value = v;
    },
    clear: () => {
      value = null;
    },
    peek: () => value,
  };
}

function newController(store) {
  return new SessionController(new Api(), store);
}

/** A scripted participant on a raw socket. */
class RawPeer {
  constructor(name) {
    this.name = name;
    this.frames = [];
    this.ws = null;
  }

  connect(publicId, token) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_BASE + "/ws/session/" + publicId, {
        headers: { Authorization: "Bearer " + token },
      });
      this.ws.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        this.frames.push(frame);
        if (process.env.CODECOLAB_TEST_VERBOSE) {
          const detail =
            frame.type === "error" ? " " + frame.code + ": " + frame.message : "";
          console.log("  <" + this.name + "> " + frame.type + detail);
        }
      });
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  waitFrame(type, timeout = 8000) {
    return waitFor(() => this.frames.find((f) => f.type === type), {
      timeout,
      what: this.name + " frame " + type,
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

// --------------------------------------------------------------------------

async function unitTests() {
  console.log("\n- unit -");
  check("code: bare", normalizeCode("abc-defg-hij") === "abc-defg-hij");
  check("code: caps and spaces", normalizeCode("ABC DEFG HIJ") === "abc-defg-hij");
  check("code: from url", normalizeCode("https://x.io/j/abc-defg-hij") === "abc-defg-hij");
  check(
    "code: from deep link",
    normalizeCode("vscode://local.codecolab/join?code=abc-defg-hij&server=http://x") ===
      "abc-defg-hij"
  );
  check("code: rejects junk", normalizeCode("hello") === "");

  check("path: normalises separators", paths.sanitizeRelativePath("src\\main.py") === "src/main.py");
  check("path: collapses dot segments", paths.sanitizeRelativePath("./a//b.txt") === "a/b.txt");
  ["../x", "/etc/passwd", "C:/Windows/a", "//srv/x", "a/../b", "con.txt", ""].forEach(
    (bad) => check("path: rejects " + JSON.stringify(bad), !paths.isSafePath(bad))
  );

  check("update: 2.10.0 beats 2.9.0", isNewer("2.10.0", "2.9.0"));
  check("update: 2.0.0 does not beat 2.0.0", !isNewer("2.0.0", "2.0.0"));
  check("update: 1.9.9 does not beat 2.0.0", !isNewer("1.9.9", "2.0.0"));
  check("update: https is trusted for silent install", trustedTransport("https://x.io/a"));
  check("update: localhost is trusted", trustedTransport("http://127.0.0.1:8000/a"));
  check(
    "update: plain http on a public host is not",
    !trustedTransport("http://example.com/a")
  );

  check("colour: stable for an id", colorFor(7).hex === colorFor(7).hex);
  check("colour: differs across ids", colorFor(1).hex !== colorFor(2).hex);
  check("initials: two words", initials("Ada Lovelace") === "AL");
  check("initials: one word", initials("davit") === "DA");

  const identity = new Identity(makeContext());
  check("identity: empty until set", identity.get() === "");
  await identity.set("  Ada Lovelace  ");
  check("identity: trims and remembers", identity.get() === "Ada Lovelace");
  let rejected = false;
  try {
    await identity.set("x");
  } catch (err) {
    rejected = true;
  }
  check("identity: refuses a one-character name", rejected);
}

async function hostPhase() {
  console.log("\n- extension as host -");
  const dir = tempWorkspace("codecolab-host-");
  state.workspaceRoot = dir;
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.js"), "console.log(1);\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# host project\n");
  fs.mkdirSync(path.join(dir, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "junk", "index.js"), "// ignore me\n");

  const controller = newController();

  const session = await controller.startHosting({
    title: "Extension host test",
    displayName: "Ada Host",
    allowGuests: true,
    requireApproval: true,
  });
  check("host: session created with no account", Boolean(session.publicId && session.joinCode));
  check("host: code shape", /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(session.joinCode), session.joinCode);
  await waitFor(() => controller.status === "active", { what: "host active" });
  check("host: socket connected and active", controller.status === "active");
  check("host: role is host", controller.isHost);

  check("host: heartbeat armed", controller._heartbeat !== null);
  const pongBefore = controller._lastPong;
  await sleep(5);
  controller.send({ type: "ping", t: Date.now() });
  await waitFor(() => controller._lastPong > pongBefore, {
    timeout: 6000,
    what: "a pong back from the server",
  });
  check("host: server answers the heartbeat", controller._lastPong > pongBefore);

  // The panel renders from the controller, so check what it would show.
  const identity = new Identity(makeContext());
  await identity.set("Ada Host");
  const posted = [];
  const panel = new SessionPanel(controller, identity, () => {});
  panel.view = {
    webview: { postMessage: (m) => posted.push(m) },
    show: () => {},
  };
  panel.render();
  const view = posted[posted.length - 1];
  check("panel: reports the session", view.inSession === true && view.isHost === true);
  check("panel: exposes the join code", view.session.joinCode === session.joinCode);
  check("panel: exposes the invite link", view.session.joinUrl === session.joinUrl);

  // The guest joins on a raw socket.
  const joined = await request(SERVER + "/api/sessions/join", {
    method: "POST",
    body: { code: session.joinCode, display_name: "Raw Guest" },
  });
  check("host: guest is pending", joined.state === "pending", joined.state);

  const guest = new RawPeer("guest");
  await guest.connect(session.publicId, joined.session_token);
  await guest.waitFrame("pending");

  await waitFor(() => controller.participants.some((p) => p.state === "pending"), {
    what: "roster shows the pending guest",
  });
  check("host: roster shows the pending guest", true);

  posted.length = 0;
  panel.render();
  const waiting = posted[posted.length - 1].participants.find((p) => p.state === "pending");
  check("panel: shows who is waiting", Boolean(waiting) && waiting.name === "Raw Guest");

  controller.approve(joined.participant_id, "editor");
  const snapshot = await guest.waitFrame("snapshot");
  const shared = snapshot.files.map((f) => f.path).sort();
  check(
    "host: snapshot contains workspace files",
    shared.includes("README.md") && shared.includes("src/app.js"),
    shared.join(", ")
  );
  check("host: node_modules excluded", !shared.some((p) => p.indexOf("node_modules") !== -1));

  const doc = stub.openDocument(path.join(dir, "src", "app.js"), "console.log(1);\n");
  doc.setText("console.log('typed by host');\n");
  emitters.changeText.fire({ document: doc, contentChanges: [{}] });

  const update = await waitFor(
    () => guest.frames.find((f) => f.type === "file_update" && f.path === "src/app.js"),
    { what: "guest receives the host's edit" }
  );
  check("host: edit propagated", update.content.indexOf("typed by host") !== -1);

  const before = guest.frames.length;
  controller.pause();
  await waitFor(() => controller.status === "paused", { what: "paused" });
  check("host: pause applied", controller.status === "paused");

  doc.setText("console.log('while paused');\n");
  emitters.changeText.fire({ document: doc, contentChanges: [{}] });
  await sleep(600);
  const leaked = guest.frames
    .slice(before)
    .some((f) => f.type === "file_update" && f.content.indexOf("while paused") !== -1);
  check("host: nothing propagates while paused", !leaked);

  controller.resume();
  await waitFor(() => controller.status === "active", { what: "resumed" });
  check("host: resume applied", controller.status === "active");

  controller.setRole(joined.participant_id, "viewer");
  const roleFrame = await guest.waitFrame("role_changed");
  check("host: demotion delivered", roleFrame.role === "viewer", roleFrame.role);

  await controller.end();
  guest.close();
  check("host: reset after end", !controller.inSession);

  fs.rmSync(dir, { recursive: true, force: true });
}

async function guestPhase() {
  console.log("\n- extension as guest -");
  const dir = tempWorkspace("codecolab-guest-");
  state.workspaceRoot = dir;

  const created = await request(SERVER + "/api/sessions", {
    method: "POST",
    body: {
      title: "Raw host test",
      display_name: "Raw Host",
      workspace_name: "raw",
      allow_guests: true,
      require_approval: true,
    },
  });
  await request(SERVER + "/api/sessions/" + created.public_id + "/files", {
    method: "PUT",
    headers: { Authorization: "Bearer " + created.session_token },
    body: {
      files: [
        { path: "lesson/step1.py", content: "print('step one')\n" },
        { path: "notes.md", content: "# notes\n" },
      ],
    },
  });

  const rawHost = new RawPeer("host");
  await rawHost.connect(created.public_id, created.session_token);
  await rawHost.waitFrame("hello");

  const controller = newController();
  const result = await controller.joinWithCode(created.join_code, {
    displayName: "Extension Guest",
  });
  check("guest: join accepted with just a name", Boolean(result.session_token));
  check("guest: starts pending", controller.status === "pending", controller.status);

  const requestFrame = await rawHost.waitFrame("join_request");
  check("guest: host was notified", requestFrame.participant.display_name === "Extension Guest");

  rawHost.send({
    type: "approve_join",
    participant_id: requestFrame.participant.participant_id,
    role: "editor",
  });

  await waitFor(() => fs.existsSync(path.join(dir, "lesson", "step1.py")), {
    what: "snapshot written to disk",
  });
  check("guest: snapshot written to disk", true);
  check(
    "guest: nested file content",
    fs.readFileSync(path.join(dir, "lesson", "step1.py"), "utf8").indexOf("step one") !== -1
  );
  await waitFor(() => controller.role === "editor", { what: "promoted to editor" });
  check("guest: role is editor", controller.role === "editor");

  rawHost.send({ type: "file_update", path: "notes.md", content: "# notes\nsecond line\n" });
  await waitFor(
    () => fs.readFileSync(path.join(dir, "notes.md"), "utf8").indexOf("second line") !== -1,
    { what: "remote edit written" }
  );
  check("guest: remote edit written", true);

  const escapeTarget = path.join(path.dirname(dir), "codecolab-ESCAPED.txt");
  fs.rmSync(escapeTarget, { force: true });
  rawHost.send({ type: "file_update", path: "../codecolab-ESCAPED.txt", content: "pwned" });
  rawHost.send({ type: "file_update", path: "safe-after-attack.txt", content: "ok" });
  await waitFor(() => fs.existsSync(path.join(dir, "safe-after-attack.txt")), {
    what: "follow-up write proves the attack frame was processed",
  });
  check("guest: traversal did not escape the workspace", !fs.existsSync(escapeTarget));

  // Deliberately a different file from the one the raw host just wrote: that
  // one is briefly held by them, which has its own phase.
  const doc = stub.openDocument(
    path.join(dir, "lesson", "step1.py"),
    fs.readFileSync(path.join(dir, "lesson", "step1.py"), "utf8")
  );
  doc.setText("print('edited by the guest')\n");
  emitters.changeText.fire({ document: doc, contentChanges: [{}] });
  const echoed = await waitFor(
    () =>
      rawHost.frames.find(
        (f) => f.type === "file_update" && f.content.indexOf("edited by the guest") !== -1
      ),
    { what: "host receives the guest edit" }
  );
  check("guest: local edit propagated", Boolean(echoed));

  rawHost.send({
    type: "remove_participant",
    participant_id: requestFrame.participant.participant_id,
  });
  await waitFor(() => !controller.inSession, { what: "guest removed" });
  check("guest: removal ends the local session", !controller.inSession);

  rawHost.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * A proxy that answers the WebSocket upgrade with plain HTTP. The session has
 * to survive it, or the view falls back to its start screen while the server
 * still believes the session is live.
 */
async function disconnectPhase() {
  console.log("\n- proxy without websocket support -");
  const dir = tempWorkspace("codecolab-offline-");
  state.workspaceRoot = dir;
  fs.writeFileSync(path.join(dir, "notes.txt"), "hello\n");

  const http = require("http");
  const blocker = http.createServer((req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"detail":"Not found"}');
  });
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const blockerUrl = "ws://127.0.0.1:" + blocker.address().port;

  const controller = newController();
  const session = await controller.startHosting({
    title: "Offline test",
    displayName: "Ada Host",
    allowGuests: true,
    requireApproval: true,
  });
  await waitFor(() => controller.status === "active", { what: "connected" });
  const code = session.joinCode;

  state.settings["codecolab.wsUrl"] = blockerUrl;
  controller.ws.close();

  await waitFor(() => controller.isDisconnected, {
    timeout: 15000,
    what: "controller to report a handshake rejection",
  });

  check("offline: status is disconnected", controller.status === "disconnected");
  check("offline: still in a session", controller.inSession === true);
  check("offline: join code kept", controller.session.joinCode === code);
  check(
    "offline: reports the handshake status, not a generic timeout",
    Boolean(controller.lastError) && controller.lastError.message.indexOf("404") !== -1,
    controller.lastError && controller.lastError.message
  );
  check("offline: editing is refused while down", controller.canEdit === false);
  check("offline: did not enter the retry backoff", controller._reconnectTimer === null);

  state.settings["codecolab.wsUrl"] = "";
  const back = await controller.reconnect();
  check("offline: reconnect succeeds once the proxy is fixed", back === true);
  await waitFor(() => controller.status === "active", { what: "back online" });
  check("offline: same session, not a new one", controller.session.joinCode === code);
  check("offline: error cleared", controller.lastError === null);

  await controller.end();
  blocker.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Chat, the shared board, cursor decorations, file locks, asking to edit,
 * and coming back after a window reload.
 */
async function extrasPhase() {
  console.log("\n- presence, chat, board, locks -");
  const dir = tempWorkspace("codecolab-extras-");
  state.workspaceRoot = dir;
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.js"), "line one\nline two\nline three\n");

  const store = memoryStore();
  const controller = newController(store);
  const presence = new PresenceView(controller);
  controller.onDidChangePresence((event) =>
    presence.update(event.participantId, event.presence)
  );

  const session = await controller.startHosting({
    title: "Extras test",
    displayName: "Ada Host",
    allowGuests: true,
    requireApproval: false,
  });
  await waitFor(() => controller.status === "active", { what: "host active" });

  const joined = await request(SERVER + "/api/sessions/join", {
    method: "POST",
    body: { code: session.joinCode, display_name: "Bob Guest" },
  });
  const guest = new RawPeer("guest");
  await guest.connect(session.publicId, joined.session_token);
  await guest.waitFrame("hello");
  await waitFor(
    () => controller.participants.some((p) => p.participant_id === joined.participant_id),
    { what: "guest on the roster" }
  );
  controller.setRole(joined.participant_id, "editor");
  await guest.waitFrame("role_changed");

  // ---- cursors ----------------------------------------------------------
  stub.showEditorFor(path.join(dir, "src", "app.js"), "line one\nline two\nline three\n");
  state.decorations.length = 0;
  guest.send({
    type: "presence",
    path: "src/app.js",
    line: 2,
    column: 3,
    selection: { start_line: 2, start_column: 1, end_line: 2, end_column: 5 },
  });
  await waitFor(() => state.decorations.some((d) => d.ranges.length), {
    what: "a cursor to be drawn",
  });
  const drawn = state.decorations.filter((d) => d.ranges.length);
  check("presence: remote cursor drawn in the editor", drawn.length >= 1);
  check(
    "presence: label carries the name",
    drawn.some(
      (d) => d.type.options.after && d.type.options.after.contentText.indexOf("Bob") !== -1
    )
  );
  check(
    "presence: selection highlighted too",
    drawn.some((d) => d.type.options.backgroundColor)
  );
  check(
    "presence: colour matches the shared palette",
    drawn.some((d) => d.type.options.borderColor === colorFor(joined.participant_id).hex)
  );

  // ---- chat --------------------------------------------------------------
  controller.sendChat("hello everyone");
  const chatFrame = await guest.waitFrame("chat");
  check("chat: reached the guest", chatFrame.text === "hello everyone", chatFrame.text);
  guest.send({ type: "chat", text: "hi back" });
  await waitFor(() => controller.chat.some((m) => m.text === "hi back"), {
    what: "the reply to arrive",
  });
  check("chat: reply reached the host", true);
  check(
    "chat: both messages kept in order",
    controller.chat.length >= 2 &&
      controller.chat[controller.chat.length - 1].text === "hi back"
  );

  // ---- board -------------------------------------------------------------
  controller.sendStroke({
    color: "#FF4D8D",
    width: 4,
    tool: "pen",
    points: [[0.1, 0.1], [0.5, 0.5], [0.9, 0.2]],
  });
  const strokeFrame = await guest.waitFrame("draw");
  check("board: stroke reached the guest", strokeFrame.stroke.points.length === 3);
  check("board: colour preserved", strokeFrame.stroke.color === "#FF4D8D");

  guest.send({
    type: "draw",
    stroke: { color: "#0ACF83", width: 2, tool: "pen", points: [[0.2, 0.8], [0.4, 0.7]] },
  });
  await waitFor(() => controller.board.some((st) => st.color === "#0ACF83"), {
    what: "the guest's stroke to arrive",
  });
  check("board: guest stroke reached the host", true);

  // Points outside the canvas are clamped rather than trusted.
  guest.send({
    type: "draw",
    stroke: { color: "#fff", width: 3, tool: "pen", points: [[-5, 9], [0.5, 0.5]] },
  });
  await waitFor(
    () => controller.board.some((st) => st.points.some((p) => p[0] === 0 && p[1] === 1)),
    { what: "an out-of-range point to be clamped" }
  );
  check("board: out-of-range points clamped to the canvas", true);

  // ---- file locks --------------------------------------------------------
  const doc = stub.openDocument(
    path.join(dir, "src", "app.js"),
    "line one\nline two\nline three\n"
  );
  doc.setText("host was here\n");
  emitters.changeText.fire({ document: doc, contentChanges: [{}] });
  await guest.waitFrame("file_update");

  guest.frames.length = 0;
  guest.send({ type: "file_update", path: "src/app.js", content: "guest tries to win\n" });
  const denied = await guest.waitFrame("error");
  check("locks: second writer is refused", denied.code === "locked", denied.code);
  check("locks: told who has the file", denied.message.indexOf("Ada Host") !== -1, denied.message);
  await waitFor(() => Object.keys(controller.locks).length > 0, { what: "lock state" });
  check("locks: broadcast to everyone", controller.locks["src/app.js"] === controller.participantId);

  // ---- asking to edit ----------------------------------------------------
  controller.setRole(joined.participant_id, "viewer");
  await guest.waitFrame("role_changed");
  guest.frames.length = 0;
  guest.send({ type: "request_edit" });
  await guest.waitFrame("edit_requested");
  check("request edit: the asker gets an acknowledgement", true);

  // ---- surviving a reload ------------------------------------------------
  check("restore: session was remembered", Boolean(store.peek()));
  const remembered = store.peek().joinCode;
  controller.detachWorkspaceListeners();
  if (controller.ws) {
    controller.ws.removeAllListeners();
    controller.ws.close();
  }
  controller.ws = null;
  controller.session = null;
  controller.sessionToken = null;
  controller.status = "idle";

  const reborn = newController(store);
  const restored = await reborn.restore();
  check("restore: walked back into the same session", Boolean(restored));
  check("restore: same join code", restored && restored.joinCode === remembered);
  await waitFor(() => reborn.status === "active", { what: "restored session live" });
  check("restore: connected again", reborn.status === "active");
  check("restore: still the host", reborn.isHost);

  await reborn.end();
  check("restore: ending clears what was remembered", store.peek() === null);

  presence.dispose();
  guest.close();
  state.editors = [];
  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  console.log("CodeColab extension tests against " + SERVER);
  try {
    await request(SERVER + "/healthz", { timeoutMs: 5000 });
  } catch (err) {
    console.error("\nServer is not reachable at " + SERVER + " - start it first.");
    process.exit(2);
  }

  await unitTests();
  await hostPhase();
  await guestPhase();
  await extrasPhase();
  await disconnectPhase();

  console.log("\n" + checks + " checks, " + failures.length + " failure(s)");
  if (failures.length) {
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("ALL CHECKS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nHarness error: " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
