"use strict";

/**
 * CodeColab - live collaborative coding for VS Code.
 *
 * The host shares the folder they already have open and gets a link plus a
 * short code. Anyone opening the link is handed to VS Code, asks to join, and
 * waits until the host admits them.
 *
 * There are no accounts. You pick a display name, and what you are allowed to
 * do comes from the session token you were issued when you started or joined.
 */

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const config = require("./src/config");
const log = require("./src/log");
const workspace = require("./src/workspace");
const { Api } = require("./src/api");
const { Identity } = require("./src/identity");
const { SessionController } = require("./src/session");
const { SessionPanel } = require("./src/panel");
const { PresenceView } = require("./src/presence");
const { StatusBar } = require("./src/status");
const { Updater } = require("./src/updater");
const { normalizeCode } = require("./src/code");

const SESSION_KEY = "codecolab.session";

let controller = null;
let identity = null;
let panel = null;
let presence = null;
let updater = null;
let api = null;

function activate(context) {
  log.info("CodeColab activated");

  api = new Api();
  identity = new Identity(context);

  // Remembered per window: a session belongs to the folder that is open, so
  // reloading the window should walk back into it rather than orphan it.
  const store = {
    read: () => context.workspaceState.get(SESSION_KEY) || null,
    write: (value) => context.workspaceState.update(SESSION_KEY, value),
    clear: () => context.workspaceState.update(SESSION_KEY, undefined),
  };

  controller = new SessionController(api, store);
  panel = new SessionPanel(
    controller,
    identity,
    handleIntent,
    vscode.Uri.joinPath(context.extensionUri, "media")
  );
  presence = new PresenceView(controller);
  // A silent update reloads the window when it is done, so it has to know
  // whether that would interrupt anything.
  updater = new Updater(context, { isBusy: () => controller.inSession });

  const status = new StatusBar(controller);

  context.subscriptions.push(
    controller.onDidChangePresence((event) =>
      presence.update(event.participantId, event.presence)
    ),
    presence.onDidChange(() => panel.setFollowing(presence.following))
  );

  vscode.commands.executeCommand("setContext", "codecolab.inSession", false);
  vscode.commands.executeCommand("setContext", "codecolab.isHost", false);

  const register = (name, handler) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(name, (...args) => run(name, handler, args))
    );

  register("codecolab.startSession", () => startSession());
  register("codecolab.joinSession", (prefill) => joinSession(prefill));
  register("codecolab.copyInvite", () => copy("joinUrl", "Invite link"));
  register("codecolab.copyCode", () => copy("joinCode", "Join code"));
  register("codecolab.pauseSession", () => requireHost().pause());
  register("codecolab.resumeSession", () => requireHost().resume());
  register("codecolab.endSession", () => endSession());
  register("codecolab.leaveSession", () => leaveSession());
  register("codecolab.reconnect", () => reconnect());
  register("codecolab.resync", () => controller.resync());
  register("codecolab.pushWorkspace", () => pushWorkspace());
  register("codecolab.setName", () => changeName());
  register("codecolab.showLog", () => log.show());
  register("codecolab.showPanel", () => panel.reveal());
  register("codecolab.checkForUpdates", () => updater.check({ force: true }));
  register("codecolab.syncSharedFiles", () => syncSharedFiles());
  register("codecolab.rejoinSession", () => restoreSession({ announce: true }));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codecolab.sessionView", panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerUriHandler({ handleUri: (uri) => handleUri(uri) }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => panel.render()),
    status,
    presence,
    controller,
    { dispose: () => log.dispose() }
  );

  // Neither of these should hold up activation.
  restoreSession({ announce: false }).catch((err) =>
    log.warn("Could not restore the previous session: " + (err && err.message))
  );
  updater.check().catch((err) => log.info("Update check skipped: " + (err && err.message)));
  context.subscriptions.push(updater.poll());
}

/**
 * Walk back into the session this window was in before it was reloaded.
 * Without this a restart orphans the session: it stays live on the server
 * with nobody able to control it.
 */
async function restoreSession({ announce }) {
  if (controller.inSession) {
    if (announce) panel.reveal();
    return null;
  }
  const session = await controller.restore();
  if (session) {
    log.info("Rejoined " + session.title);
    vscode.window.setStatusBarMessage("$(broadcast) Rejoined " + session.title, 5000);
  } else if (announce) {
    vscode.window.showInformationMessage("CodeColab: no previous session to rejoin.");
  }
  return session;
}

function run(name, handler, args) {
  return Promise.resolve()
    .then(() => handler(...args))
    .catch((err) => {
      log.error(name + ": " + (err && err.stack ? err.stack : err));
      vscode.window.showErrorMessage(
        "CodeColab: " + (err && err.message ? err.message : String(err))
      );
    });
}

// --------------------------------------------------------------------------
// Panel intents
// --------------------------------------------------------------------------

async function handleIntent(message) {
  const host = () => requireHost();

  const actions = {
    openFolder: () => vscode.commands.executeCommand("vscode.openFolder"),
    start: () =>
      startSession({
        displayName: message.displayName,
        title: message.title,
        requireApproval: message.requireApproval,
        allowGuests: message.allowGuests,
      }),
    join: () => joinSession(message.code, { displayName: message.displayName }),
    copyCode: () => copy("joinCode", "Join code"),
    copyLink: () => copy("joinUrl", "Invite link"),
    openPage: () => openInvitePage(),
    pause: () => host().pause(),
    resume: () => host().resume(),
    end: () => endSession(),
    leave: () => leaveSession(),
    push: () => pushWorkspace(),
    resync: () => controller.resync(),
    reconnect: () => reconnect(),
    follow: () => presence.follow(message.id),
    attach: () => attachFiles(),
    saveAttachment: () => saveAttachment(message.id),
    saveAll: () => saveAllAttachments(),
    detach: () => detachAttachment(message.id),
    searchFiles: () => searchFiles(message.query),
    shareFile: () => shareFile(message.path),
    unshareFile: () => controller.unshareFile(message.path),
    chat: () => controller.sendChat(message.text),
    draw: () => controller.sendStroke(message.stroke),
    boardClear: () => controller.clearBoard(message.scope),
    requestEdit: () => controller.requestEdit(),
    approve: () => host().approve(message.id, message.role),
    deny: () => host().deny(message.id),
    role: () => host().setRole(message.id, message.role),
    remove: () => removeParticipant(message.id),
    showLog: () => log.show(),
    checkUpdates: () => updater.check({ force: true }),
    syncSharedFiles: () => syncSharedFiles(),
  };

  const action = actions[message.type];
  if (!action) {
    log.warn("Unknown panel intent: " + message.type);
    return;
  }
  await run("panel:" + message.type, action, []);
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

function requireHost() {
  if (!controller.inSession) throw new Error("You are not in a session.");
  if (!controller.isHost) throw new Error("Only the host can do that.");
  return controller;
}

async function startSession(options = {}) {
  if (controller.inSession) {
    const choice = await vscode.window.showWarningMessage(
      "A session is already running.",
      "Show it",
      "End it and start a new one"
    );
    if (choice === "Show it") return panel.reveal();
    if (choice !== "End it and start a new one") return undefined;
    await controller.end();
  }

  const folder = workspace.rootFolder();
  if (!folder) {
    const choice = await vscode.window.showErrorMessage(
      "Open a folder before starting a session - that folder is what you share.",
      "Open folder…"
    );
    if (choice) vscode.commands.executeCommand("vscode.openFolder");
    return undefined;
  }

  const displayName = options.displayName
    ? await identity.set(options.displayName)
    : await identity.require("What name should other people see?");
  if (!displayName) return undefined;

  let title = options.title;
  if (!title) {
    title = await vscode.window.showInputBox({
      title: "Start a CodeColab session",
      prompt: "What is this session called?",
      value: folder.name,
      ignoreFocusOut: true,
      validateInput: (value) => (value && value.trim() ? null : "Required"),
    });
    if (!title) return undefined;
  }

  panel.reveal();
  panel.setBusy("Starting session");
  let session;
  try {
    session = await controller.startHosting({
      title: title.trim(),
      displayName,
      allowGuests: options.allowGuests !== false,
      requireApproval: options.requireApproval !== false,
    });
  } finally {
    panel.setBusy(null);
  }

  await vscode.env.clipboard.writeText(session.joinUrl);
  if (controller.isDisconnected) {
    // The session exists on the server but the socket never came up, and the
    // reason has already been reported. Do not call it live.
    return session;
  }

  vscode.window.showInformationMessage(
    "Session live - invite link copied. Code: " + session.joinCode
  );
  return session;
}

async function joinSession(prefill, options = {}) {
  if (controller.inSession) {
    const choice = await vscode.window.showWarningMessage(
      "You are already in a session.",
      "Leave it and join the new one"
    );
    if (choice !== "Leave it and join the new one") return undefined;
    controller.leave();
  }

  let raw = typeof prefill === "string" ? prefill : null;
  if (!raw) {
    raw = await vscode.window.showInputBox({
      title: "Join a CodeColab session",
      prompt: "Paste the invite link or type the code",
      placeHolder: "abc-defg-hij",
      ignoreFocusOut: true,
      validateInput: (value) =>
        value && normalizeCode(value) ? null : "Enter a code or an invite link",
    });
  }
  if (!raw) return undefined;

  const code = normalizeCode(raw);
  if (!code) throw new Error("That does not look like a join code.");

  let preview;
  try {
    preview = await api.peek(code);
  } catch (err) {
    throw new Error(
      "No live session for code " + code + " on " + config.serverUrl() + "."
    );
  }

  const displayName = options.displayName
    ? await identity.set(options.displayName)
    : await identity.require("What name should the host see?");
  if (!displayName) return undefined;

  if (!(await confirmWorkspaceOverwrite(preview))) return undefined;

  panel.reveal();
  panel.setBusy("Joining");
  let result;
  try {
    result = await controller.joinWithCode(code, { displayName });
  } finally {
    panel.setBusy(null);
  }

  if (result.state === "pending" && !controller.isDisconnected) {
    vscode.window.showInformationMessage(
      "Asked " + result.host_name + " to let you in. Hang tight."
    );
  }
  return result;
}

/**
 * Joining pulls the host's project into this folder, which overwrites files.
 * That is destructive, so it is always confirmed.
 */
async function confirmWorkspaceOverwrite(preview) {
  const folder = workspace.rootFolder();
  if (!folder) {
    const choice = await vscode.window.showErrorMessage(
      "Open a folder first - the host's files are written into it.",
      "Open folder…"
    );
    if (choice) vscode.commands.executeCommand("vscode.openFolder");
    return false;
  }

  if (await workspace.looksEmpty()) return true;

  const choice = await vscode.window.showWarningMessage(
    "Joining will write the host's files into this folder.",
    {
      modal: true,
      detail:
        "Folder: " + folder.uri.fsPath +
        '\nSession: "' + preview.title + '" hosted by ' + preview.host_name +
        "\n\nFiles with the same path will be overwritten. Open an empty folder instead if you want to keep what is here.",
    },
    "Join and overwrite"
  );
  return choice === "Join and overwrite";
}

// --------------------------------------------------------------------------
// Attachments and the file search
// --------------------------------------------------------------------------

function requireSession() {
  if (!controller.inSession) throw new Error("You are not in a session.");
  if (controller.status === "pending") {
    throw new Error("Wait until the host admits you.");
  }
  return controller;
}

async function attachFiles() {
  requireSession();
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "Attach",
    title: "Send these to everyone in the session",
  });
  if (!picked || !picked.length) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "CodeColab: sending files",
      cancellable: false,
    },
    async (progress) => {
      let done = 0;
      for (const uri of picked) {
        const name = path.basename(uri.fsPath);
        progress.report({ message: name });
        try {
          await controller.attachFile(uri.fsPath, name, workspace.contentTypeFor(name));
          done += 1;
        } catch (err) {
          // One rejected file should not abandon the rest of the batch.
          const reason = err && err.message ? err.message : String(err);
          vscode.window.showWarningMessage(
            "CodeColab: could not send " + name + " - " + reason
          );
        }
      }
      if (done) {
        vscode.window.setStatusBarMessage(
          "$(check) Sent " + done + " file(s)",
          4000
        );
      }
    }
  );
  await controller.refreshAttachments();
}

async function chooseFolder(title) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Save here",
    title,
  });
  return picked && picked.length ? picked[0].fsPath : null;
}

async function saveAttachment(id) {
  requireSession();
  const item = controller.attachments.find((a) => a.id === id);
  if (!item) throw new Error("That file is no longer attached.");

  const folder = await chooseFolder("Where should " + item.name + " go?");
  if (!folder) return;

  const target = uniquePath(path.join(folder, item.name));
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "CodeColab: saving " + item.name },
    () => controller.saveAttachment(id, target)
  );

  const choice = await vscode.window.showInformationMessage(
    "Saved " + path.basename(target),
    "Open folder"
  );
  if (choice === "Open folder") {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target));
  }
}

async function saveAllAttachments() {
  requireSession();
  if (!controller.attachments.length) throw new Error("Nothing attached yet.");

  const folder = await chooseFolder("Where should the archive go?");
  if (!folder) return;

  const name = (controller.session.title || "session").replace(/[^\w .-]+/g, "_");
  const target = uniquePath(path.join(folder, name + "-files.zip"));
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "CodeColab: building the archive" },
    () => controller.saveAllAttachments(target)
  );

  const choice = await vscode.window.showInformationMessage(
    "Saved " + path.basename(target),
    "Open folder"
  );
  if (choice === "Open folder") {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target));
  }
}

/** Never silently write over something already sitting there. */
function uniquePath(candidate) {
  if (!fs.existsSync(candidate)) return candidate;
  const dir = path.dirname(candidate);
  const ext = path.extname(candidate);
  const stem = path.basename(candidate, ext);
  for (let i = 2; i < 500; i += 1) {
    const next = path.join(dir, stem + " (" + i + ")" + ext);
    if (!fs.existsSync(next)) return next;
  }
  return path.join(dir, stem + "-" + Date.now() + ext);
}

async function detachAttachment(id) {
  requireSession();
  const item = controller.attachments.find((a) => a.id === id);
  const choice = await vscode.window.showWarningMessage(
    "Remove " + (item ? item.name : "this file") + " from the session?",
    { modal: true, detail: "Nobody will be able to download it afterwards." },
    "Remove"
  );
  if (choice !== "Remove") return;
  await controller.detachAttachment(id);
  await controller.refreshAttachments();
}

/**
 * Write every shared file into the folder now.
 *
 * This happens by itself whenever the list changes; the command exists for
 * the case where somebody turned that off, or joined after the fact.
 */
async function syncSharedFiles() {
  requireSession();
  panel.setBusy("Writing shared files");
  let written;
  try {
    written = await controller.pullSharedFiles({ force: true });
  } finally {
    panel.setBusy(null);
  }
  vscode.window.setStatusBarMessage(
    written.length
      ? "$(check) Wrote " + written.length + " shared file(s)"
      : "$(check) Every shared file is already up to date",
    4000
  );
}

async function searchFiles(query) {
  const items = await workspace.listCandidates(query);
  panel.postCandidates(items);
}

async function shareFile(relativePath) {
  requireSession();
  const result = await controller.shareFile(relativePath);
  if (result && result.mode === "file") {
    // Too big or too binary for the live sync, so the bytes went over the
    // attachment transport - but tagged with this path, so everyone writes
    // it into their folder instead of it landing in a list.
    vscode.window.setStatusBarMessage("$(check) Shared " + relativePath, 4000);
  } else {
    vscode.window.setStatusBarMessage("$(check) Sharing " + relativePath, 4000);
  }
  await searchFiles(undefined);
}

async function copy(field, label) {
  if (!controller.inSession || !controller.session[field]) {
    throw new Error("Nothing to copy yet.");
  }
  await vscode.env.clipboard.writeText(controller.session[field]);
  vscode.window.setStatusBarMessage("$(check) " + label + " copied", 3000);
}

async function openInvitePage() {
  if (!controller.inSession || !controller.session.joinUrl) {
    throw new Error("No invite link yet.");
  }
  await vscode.env.openExternal(vscode.Uri.parse(controller.session.joinUrl));
}

async function pushWorkspace() {
  requireHost();
  panel.setBusy("Sharing workspace");
  try {
    await controller.pushWorkspace();
  } finally {
    panel.setBusy(null);
  }
}

async function reconnect() {
  if (!controller.inSession) throw new Error("You are not in a session.");
  panel.setBusy("Reconnecting");
  let ok;
  try {
    ok = await controller.reconnect();
  } finally {
    panel.setBusy(null);
  }
  if (ok) vscode.window.showInformationMessage("CodeColab: back in the session.");
  return ok;
}

async function endSession() {
  requireHost();
  const choice = await vscode.window.showWarningMessage(
    'End "' + controller.session.title + '"?',
    { modal: true, detail: "Everyone is disconnected and the link stops working." },
    "End session"
  );
  if (choice !== "End session") return;
  await controller.end();
  vscode.window.showInformationMessage("CodeColab: session ended.");
}

async function leaveSession() {
  if (!controller.inSession) throw new Error("You are not in a session.");
  controller.leave();
  vscode.window.showInformationMessage("CodeColab: you left the session.");
}

async function removeParticipant(id) {
  requireHost();
  const person = controller.participants.find((p) => p.participant_id === id);
  const choice = await vscode.window.showWarningMessage(
    "Remove " + (person ? person.display_name : "this participant") + " from the session?",
    { modal: true },
    "Remove"
  );
  if (choice === "Remove") controller.removeParticipant(id);
}

async function changeName() {
  const answer = await vscode.window.showInputBox({
    title: "CodeColab",
    prompt: "What name should other people see?",
    value: identity.get() || identity.suggest(),
    ignoreFocusOut: true,
    validateInput: (value) =>
      value && value.trim().length >= 2 ? null : "At least 2 characters",
  });
  if (!answer) return;
  await identity.set(answer);
  panel.render();
  vscode.window.showInformationMessage("CodeColab: you are now " + answer.trim() + ".");
}

// --------------------------------------------------------------------------
// vscode://voritsack.codecolab/join?code=…&server=…
// --------------------------------------------------------------------------

async function handleUri(uri) {
  log.info("Handling URI " + uri.toString());
  const params = new URLSearchParams(uri.query || "");
  const code = normalizeCode(params.get("code") || "");
  const server = (params.get("server") || "").replace(/\/+$/, "");

  if (uri.path !== "/join" || !code) {
    vscode.window.showWarningMessage("CodeColab: that link is not a join link.");
    return;
  }

  if (server && server !== config.serverUrl()) {
    // A link can point anywhere, so switching servers is always confirmed:
    // the new server would receive this workspace's contents.
    const choice = await vscode.window.showWarningMessage(
      "This invite is for a different CodeColab server.",
      {
        modal: true,
        detail:
          "Currently configured: " + config.serverUrl() +
          "\nInvite points at:    " + server +
          "\n\nJoining sends the contents of your open folder to that server. Only continue if you trust it.",
      },
      "Trust and switch",
      "Join without switching"
    );
    if (!choice) return;
    if (choice === "Trust and switch") await config.setServerUrl(server);
  }

  await run("uri:join", () => joinSession(code), []);
}

function deactivate() {
  if (controller) controller.dispose();
}

module.exports = { activate, deactivate };
