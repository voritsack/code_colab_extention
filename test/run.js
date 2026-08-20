"use strict";

/**
 * Integration test for the extension against a running CodeColab server.
 *
 *   node test/run.js [serverUrl]
 *
 * Phase 1 drives the extension as the host with a scripted guest on a raw
 * socket; phase 2 flips it, so both directions of the protocol are exercised
 * by the code that actually ships.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const stub = require("./vscode-stub");
stub.install();

const WebSocket = require("ws");
const { vscode, state, emitters } = stub;

const SERVER = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/+$/, "");
const WS_BASE = SERVER.replace(/^http/, "ws");
state.settings["codecolab.serverUrl"] = SERVER;

const { request } = require("../src/http");
const { Auth } = require("../src/auth");
const { Api } = require("../src/api");
const { SessionController } = require("../src/session");
const { normalizeCode } = require("../src/code");
const paths = require("../src/paths");

const failures = [];
let checks = 0;

function check(label, condition, extra) {
  checks += 1;
  if (condition) {
    console.log("[PASS] " + label);
  } else {
    failures.push(label + (extra ? " — " + extra : ""));
    console.log("[FAIL] " + label + (extra ? " — " + extra : ""));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

function makeContext() {
  const store = new Map();
  return {
    subscriptions: [],
    secrets: {
      get: async (key) => store.get(key),
      store: async (key, value) => void store.set(key, value),
      delete: async (key) => void store.delete(key),
    },
  };
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
            frame.type === "error"
              ? " " + frame.code + ": " + frame.message
              : "";
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

/**
 * Fixed test accounts, so repeated runs do not walk into the registration
 * rate limit. Log in if the account is already there, register if it is not.
 */
async function ensureAccount(tag) {
  const email = "ext-" + tag + "@example.com";
  const password = "SuperSecret123!";
  try {
    const tokens = await request(SERVER + "/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    return { email, tokens };
  } catch (err) {
    if (!err.status || err.status !== 401) throw err;
  }
  const tokens = await request(SERVER + "/api/auth/register", {
    method: "POST",
    body: { email, name: "Ext " + tag, password },
  });
  return { email, tokens };
}

// --------------------------------------------------------------------------

async function unitTests() {
  console.log("\n— unit —");
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
}

async function hostPhase() {
  console.log("\n— extension as host —");
  const dir = tempWorkspace("codecolab-host-");
  state.workspaceRoot = dir;
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.js"), "console.log(1);\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# host project\n");
  fs.mkdirSync(path.join(dir, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "junk", "index.js"), "// ignore me\n");

  const context = makeContext();
  const auth = new Auth(context);
  const api = new Api(auth);
  const controller = new SessionController(api, auth);

  const host = await ensureAccount("host");
  await auth.store(host.tokens);

  const session = await controller.startHosting({
    title: "Extension host test",
    allowGuests: true,
    requireApproval: true,
  });
  check("host: session created", Boolean(session.publicId && session.joinCode));
  check("host: code shape", /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(session.joinCode), session.joinCode);
  await waitFor(() => controller.status === "active", { what: "host active" });
  check("host: socket connected and active", controller.status === "active");
  check("host: role is host", controller.isHost);

  // The guest joins on a raw socket.
  const joined = await request(SERVER + "/api/sessions/join", {
    method: "POST",
    body: { code: session.joinCode, display_name: "Raw Guest" },
  });
  check("host: guest is pending", joined.state === "pending", joined.state);

  const guest = new RawPeer("guest");
  await guest.connect(session.publicId, joined.session_token);
  await guest.waitFrame("pending");

  await waitFor(
    () => controller.participants.some((p) => p.state === "pending"),
    { what: "roster shows the pending guest" }
  );
  check("host: roster shows pending guest", true);

  controller.approve(joined.participant_id, "editor");
  const snapshot = await guest.waitFrame("snapshot");
  const shared = snapshot.files.map((f) => f.path).sort();
  check(
    "host: snapshot contains workspace files",
    shared.includes("README.md") && shared.includes("src/app.js"),
    shared.join(", ")
  );
  check(
    "host: node_modules excluded",
    !shared.some((p) => p.indexOf("node_modules") !== -1),
    shared.join(", ")
  );

  // The host types.
  const doc = stub.openDocument(path.join(dir, "src", "app.js"), "console.log(1);\n");
  doc.setText("console.log('typed by host');\n");
  emitters.changeText.fire({ document: doc, contentChanges: [{}] });

  const update = await waitFor(
    () => guest.frames.find((f) => f.type === "file_update" && f.path === "src/app.js"),
    { what: "guest receives the host's edit" }
  );
  check("host: edit propagated", update.content.indexOf("typed by host") !== -1);

  // Pause freezes propagation.
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

  // Demote and confirm the server agrees.
  controller.setRole(joined.participant_id, "viewer");
  const roleFrame = await guest.waitFrame("role_changed");
  check("host: demotion delivered", roleFrame.role === "viewer", roleFrame.role);

  await controller.end();
  guest.close();
  check("host: reset after end", !controller.inSession);

  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

async function guestPhase() {
  console.log("\n— extension as guest —");
  const dir = tempWorkspace("codecolab-guest-");
  state.workspaceRoot = dir;

  // A raw host sets up the session.
  const hostAccount = await ensureAccount("rawhost");
  const created = await request(SERVER + "/api/sessions", {
    method: "POST",
    headers: { Authorization: "Bearer " + hostAccount.tokens.access_token },
    body: {
      title: "Raw host test",
      workspace_name: "raw",
      allow_guests: true,
      require_approval: true,
    },
  });
  await request(SERVER + "/api/sessions/" + created.public_id + "/files", {
    method: "PUT",
    headers: { Authorization: "Bearer " + hostAccount.tokens.access_token },
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

  // The extension joins as a guest.
  const context = makeContext();
  const auth = new Auth(context);
  const api = new Api(auth);
  const controller = new SessionController(api, auth);

  const result = await controller.joinWithCode(created.join_code, {
    displayName: "Extension Guest",
    asGuest: true,
  });
  check("guest: join accepted", Boolean(result.session_token));
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

  // A remote edit lands on disk.
  rawHost.send({
    type: "file_update",
    path: "notes.md",
    content: "# notes\nsecond line\n",
  });
  await waitFor(
    () => fs.readFileSync(path.join(dir, "notes.md"), "utf8").indexOf("second line") !== -1,
    { what: "remote edit written" }
  );
  check("guest: remote edit written", true);

  // A hostile path must not escape the workspace.
  const escapeTarget = path.join(path.dirname(dir), "codecolab-ESCAPED.txt");
  fs.rmSync(escapeTarget, { force: true });
  rawHost.send({
    type: "file_update",
    path: "../codecolab-ESCAPED.txt",
    content: "pwned",
  });
  rawHost.send({ type: "file_update", path: "safe-after-attack.txt", content: "ok" });
  await waitFor(() => fs.existsSync(path.join(dir, "safe-after-attack.txt")), {
    what: "follow-up write proves the attack frame was processed",
  });
  check("guest: traversal did not escape the workspace", !fs.existsSync(escapeTarget));

  // The guest types; the host sees it.
  const doc = stub.openDocument(path.join(dir, "notes.md"), fs.readFileSync(path.join(dir, "notes.md"), "utf8"));
  doc.setText("# notes\nedited by the guest\n");
  emitters.changeText.fire({ document: doc, contentChanges: [{}] });
  const echoed = await waitFor(
    () => rawHost.frames.find((f) => f.type === "file_update" && f.content.indexOf("edited by the guest") !== -1),
    { what: "host receives the guest edit" }
  );
  check("guest: local edit propagated", Boolean(echoed));

  // Removal tears the session down on this side.
  rawHost.send({
    type: "remove_participant",
    participant_id: requestFrame.participant.participant_id,
  });
  await waitFor(() => !controller.inSession, { what: "guest removed" });
  check("guest: removal ends the local session", !controller.inSession);

  rawHost.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * What happens when something in front of the server answers the WebSocket
 * upgrade with plain HTTP - a proxy with WebSockets switched off.
 *
 * The session must survive it: losing the invite link and the participant
 * list over a transport problem is what sends the view back to its welcome
 * screen while the server still thinks the session is live.
 */
async function disconnectPhase() {
  console.log("\n— proxy without websocket support —");
  const dir = tempWorkspace("codecolab-offline-");
  state.workspaceRoot = dir;
  fs.writeFileSync(path.join(dir, "notes.txt"), "hello\n");

  // Stands in for the proxy: answers every request, upgrade or not, with 404.
  const http = require("http");
  const blocker = http.createServer((req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"detail":"Not found"}');
  });
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const blockerUrl = "ws://127.0.0.1:" + blocker.address().port;

  const context = makeContext();
  const auth = new Auth(context);
  const controller = new SessionController(new Api(auth), auth);
  await auth.store((await ensureAccount("host")).tokens);

  const session = await controller.startHosting({
    title: "Offline test",
    allowGuests: true,
    requireApproval: true,
  });
  await waitFor(() => controller.status === "active", { what: "connected" });
  const code = session.joinCode;
  const url = session.joinUrl;

  // Now the proxy stops upgrading.
  state.settings["codecolab.wsUrl"] = blockerUrl;
  controller.ws.close();

  await waitFor(() => controller.isDisconnected, {
    timeout: 15000,
    what: "controller to report a handshake rejection",
  });

  check("offline: status is disconnected", controller.status === "disconnected");
  check("offline: still in a session", controller.inSession === true);
  check("offline: join code kept", controller.session.joinCode === code, controller.session.joinCode);
  check("offline: invite link kept", controller.session.joinUrl === url);
  check(
    "offline: reports the handshake status, not a generic timeout",
    Boolean(controller.lastError) &&
      controller.lastError.message.indexOf("404") !== -1,
    controller.lastError && controller.lastError.message
  );
  check(
    "offline: hint names the proxy",
    Boolean(controller.lastError) &&
      controller.lastError.hint.toLowerCase().indexOf("websocket") !== -1
  );
  check("offline: editing is refused while down", controller.canEdit === false);

  // It gave up quickly rather than retrying a hopeless handshake six times.
  check("offline: did not enter the retry backoff", controller._reconnectTimer === null);

  // Proxy fixed.
  state.settings["codecolab.wsUrl"] = "";
  const back = await controller.reconnect();
  check("offline: reconnect succeeds once the proxy is fixed", back === true);
  await waitFor(() => controller.status === "active", { what: "back online" });
  check("offline: back to active", controller.status === "active");
  check("offline: error cleared", controller.lastError === null);
  check("offline: same session, not a new one", controller.session.joinCode === code);

  await controller.end();
  blocker.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  console.log("CodeColab extension tests against " + SERVER);
  try {
    await request(SERVER + "/healthz", { timeoutMs: 5000 });
  } catch (err) {
    console.error("\nServer is not reachable at " + SERVER + " — start it first.");
    process.exit(2);
  }

  await unitTests();
  await hostPhase();
  await guestPhase();
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
