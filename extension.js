"use strict";

/**
 * CodeColab — live collaborative coding for VS Code.
 *
 * The host shares the folder they already have open and gets a link plus a
 * short code. Anyone opening the link is handed to VS Code, asks to join, and
 * waits until the host admits them. The host can pause, resume and end the
 * session, and change anyone's role while it runs.
 */

const vscode = require("vscode");

const config = require("./src/config");
const log = require("./src/log");
const workspace = require("./src/workspace");
const { Auth } = require("./src/auth");
const { Api } = require("./src/api");
const { SessionController } = require("./src/session");
const { SessionTreeProvider } = require("./src/tree");
const { StatusBar } = require("./src/status");
const { normalizeCode } = require("./src/code");

let controller = null;
let auth = null;
let api = null;

function activate(context) {
  log.info("CodeColab activated");

  auth = new Auth(context);
  api = new Api(auth);
  controller = new SessionController(api, auth);

  const tree = new SessionTreeProvider(controller);
  const view = vscode.window.createTreeView("codecolab.sessionView", {
    treeDataProvider: tree,
  });
  const status = new StatusBar(controller);

  vscode.commands.executeCommand("setContext", "codecolab.inSession", false);
  vscode.commands.executeCommand("setContext", "codecolab.isHost", false);

  const register = (name, handler) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(name, (...args) =>
        Promise.resolve()
          .then(() => handler(...args))
          .catch((err) => {
            log.error(name + ": " + (err && err.stack ? err.stack : err));
            vscode.window.showErrorMessage(
              "CodeColab: " + (err && err.message ? err.message : String(err))
            );
          })
      )
    );

  register("codecolab.startSession", () => startSession());
  register("codecolab.joinSession", (prefill) => joinSession(prefill));
  register("codecolab.copyInvite", () => copyInvite());
  register("codecolab.copyCode", () => copyCode());
  register("codecolab.pauseSession", () => requireHost().pause());
  register("codecolab.resumeSession", () => requireHost().resume());
  register("codecolab.endSession", () => endSession());
  register("codecolab.leaveSession", () => leaveSession());
  register("codecolab.resync", () => controller.resync());
  register("codecolab.pushWorkspace", () => controller.pushWorkspace());
  register("codecolab.approve", (node) => admit(node, "editor"));
  register("codecolab.deny", (node) => withParticipant(node, (id) => controller.deny(id)));
  register("codecolab.makeEditor", (node) =>
    withParticipant(node, (id) => controller.setRole(id, "editor"))
  );
  register("codecolab.makeViewer", (node) =>
    withParticipant(node, (id) => controller.setRole(id, "viewer"))
  );
  register("codecolab.removeParticipant", (node) => removeParticipant(node));
  register("codecolab.signIn", () => auth.signIn());
  register("codecolab.signOut", () => auth.signOut());
  register("codecolab.register", () => auth.register());
  register("codecolab.showLog", () => log.show());
  register("codecolab.showPanelOrStart", () => {
    if (controller.inSession) {
      return vscode.commands.executeCommand("codecolab.sessionView.focus");
    }
    return startSession();
  });

  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri: (uri) => handleUri(uri) })
  );

  context.subscriptions.push(view, status, controller, {
    dispose: () => log.dispose(),
  });
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

function requireHost() {
  if (!controller.inSession) throw new Error("You are not in a session.");
  if (!controller.isHost) throw new Error("Only the host can do that.");
  return controller;
}

async function startSession() {
  if (controller.inSession) {
    const choice = await vscode.window.showWarningMessage(
      "A session is already running.",
      "Show it",
      "End it and start a new one"
    );
    if (choice === "Show it") {
      return vscode.commands.executeCommand("codecolab.sessionView.focus");
    }
    if (choice !== "End it and start a new one") return undefined;
    await controller.end();
  }

  const folder = workspace.rootFolder();
  if (!folder) {
    const choice = await vscode.window.showErrorMessage(
      "Open a folder before starting a session — that folder is what you share.",
      "Open folder…"
    );
    if (choice) vscode.commands.executeCommand("vscode.openFolder");
    return undefined;
  }

  if (!(await auth.isSignedIn())) {
    const record = await auth.signIn();
    if (!record) return undefined;
  }

  const title = await vscode.window.showInputBox({
    title: "Start a CodeColab session",
    prompt: "What is this session called?",
    value: folder.name,
    ignoreFocusOut: true,
    validateInput: (value) => (value && value.trim() ? null : "Required"),
  });
  if (!title) return undefined;

  const audience = await vscode.window.showQuickPick(
    [
      {
        label: "$(globe) Anyone with the link",
        detail: "Guests enter a display name. You still admit each one.",
        guests: true,
      },
      {
        label: "$(shield) Signed-in accounts only",
        detail: "Everyone must have an account on this server.",
        guests: false,
      },
    ],
    { title: "Who can join?", ignoreFocusOut: true }
  );
  if (!audience) return undefined;

  const admission = await vscode.window.showQuickPick(
    [
      {
        label: "$(person-add) I admit each person",
        detail: "You get a prompt when somebody asks to join.",
        approve: true,
      },
      {
        label: "$(unlock) Anyone with the code walks in",
        detail: "No prompt. Use this only for a code you keep private.",
        approve: false,
      },
    ],
    { title: "Admission", ignoreFocusOut: true }
  );
  if (!admission) return undefined;

  const session = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "CodeColab: starting session" },
    () =>
      controller.startHosting({
        title: title.trim(),
        allowGuests: audience.guests,
        requireApproval: admission.approve,
      })
  );

  await vscode.env.clipboard.writeText(session.joinUrl);
  if (config.autoOpenPanel()) {
    vscode.commands.executeCommand("codecolab.sessionView.focus");
  }

  const choice = await vscode.window.showInformationMessage(
    "Session live. The invite link is on your clipboard.",
    { modal: true, detail: "Link: " + session.joinUrl + "\nCode: " + session.joinCode },
    "Copy code",
    "Open link in browser"
  );
  if (choice === "Copy code") {
    await vscode.env.clipboard.writeText(session.joinCode);
  } else if (choice === "Open link in browser") {
    await vscode.env.openExternal(vscode.Uri.parse(session.joinUrl));
  }
  return session;
}

async function joinSession(prefill) {
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

  let preview = null;
  try {
    preview = await api.peek(code);
  } catch (err) {
    throw new Error(
      "No live session for code " + code + " on " + config.serverUrl() + "."
    );
  }

  if (!(await confirmWorkspaceOverwrite(preview))) return undefined;

  let asGuest = false;
  let displayName;
  const signedIn = await auth.isSignedIn();

  if (!signedIn) {
    if (!preview.allow_guests) {
      const record = await auth.signIn(
        "This session only accepts signed-in accounts."
      );
      if (!record) return undefined;
    } else {
      const how = await vscode.window.showQuickPick(
        [
          { label: "$(person) Join as a guest", detail: "Just a display name.", guest: true },
          { label: "$(account) Sign in", detail: "Use an account on this server.", guest: false },
        ],
        { title: "Join \"" + preview.title + "\" hosted by " + preview.host_name, ignoreFocusOut: true }
      );
      if (!how) return undefined;
      if (how.guest) {
        asGuest = true;
        displayName = await vscode.window.showInputBox({
          title: "Your display name",
          prompt: "What should the host see?",
          ignoreFocusOut: true,
          validateInput: (value) =>
            value && value.trim().length >= 2 ? null : "At least 2 characters",
        });
        if (!displayName) return undefined;
      } else {
        const record = await auth.signIn();
        if (!record) return undefined;
      }
    }
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "CodeColab: joining" },
    () => controller.joinWithCode(code, { displayName, asGuest })
  );

  if (config.autoOpenPanel()) {
    vscode.commands.executeCommand("codecolab.sessionView.focus");
  }

  if (result.state === "pending") {
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
      "Open a folder first — the host's files are written into it.",
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
        'Folder: ' + folder.uri.fsPath +
        '\nSession: "' + preview.title + '" hosted by ' + preview.host_name +
        "\n\nFiles with the same path will be overwritten. Open an empty folder instead if you want to keep what is here.",
    },
    "Join and overwrite"
  );
  return choice === "Join and overwrite";
}

async function copyInvite() {
  if (!controller.inSession || !controller.session.joinUrl) {
    throw new Error("No invite link yet.");
  }
  await vscode.env.clipboard.writeText(controller.session.joinUrl);
  vscode.window.setStatusBarMessage("$(check) Invite link copied", 3000);
}

async function copyCode() {
  if (!controller.inSession || !controller.session.joinCode) {
    throw new Error("No join code yet.");
  }
  await vscode.env.clipboard.writeText(controller.session.joinCode);
  vscode.window.setStatusBarMessage("$(check) Join code copied", 3000);
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

function withParticipant(node, action) {
  requireHost();
  const id = node && node.participantId;
  if (!id) throw new Error("Select a participant first.");
  action(id);
}

async function admit(node, defaultRole) {
  requireHost();
  const id = node && node.participantId;
  if (!id) throw new Error("Select a participant first.");

  const choice = await vscode.window.showQuickPick(
    [
      { label: "$(edit) Allow editing", role: "editor" },
      { label: "$(eye) View only", role: "viewer" },
    ],
    { title: "Admit " + (node.label || "participant") + " as", ignoreFocusOut: true }
  );
  controller.approve(id, choice ? choice.role : defaultRole);
}

async function removeParticipant(node) {
  requireHost();
  const id = node && node.participantId;
  if (!id) throw new Error("Select a participant first.");
  const choice = await vscode.window.showWarningMessage(
    "Remove " + (node.label || "this participant") + " from the session?",
    { modal: true },
    "Remove"
  );
  if (choice === "Remove") controller.removeParticipant(id);
}

// --------------------------------------------------------------------------
// vscode://local.codecolab/join?code=…&server=…
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
    if (choice === "Trust and switch") {
      await config.setServerUrl(server);
    }
  }

  await joinSession(code);
}

function deactivate() {
  if (controller) controller.dispose();
}

module.exports = { activate, deactivate };
