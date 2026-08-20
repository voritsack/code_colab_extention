"use strict";

/**
 * Other people, drawn in your editor.
 *
 * Each participant gets a stable colour, a caret with their name beside it, a
 * tinted selection and an initialled dot in the gutter - the same set of cues
 * a multiplayer design tool gives you, expressed with the decoration API.
 *
 * Decoration types are expensive and must be disposed, so one pair is created
 * per participant and reused until they leave.
 */

const vscode = require("vscode");
const workspace = require("./workspace");
const log = require("./log");
const { colorFor, withAlpha, readableInk, initials } = require("./colors");

/** A gutter dot with the person's initials, as an inline SVG. */
function avatarIcon(name, hex) {
  const ink = readableInk(hex);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    `<circle cx="8" cy="8" r="7.5" fill="${hex}"/>` +
    `<text x="8" y="11.4" font-family="system-ui,sans-serif" font-size="8"` +
    ` font-weight="700" text-anchor="middle" fill="${ink}">${initials(name)}</text>` +
    "</svg>";
  return vscode.Uri.parse(
    "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64")
  );
}

class PresenceView {
  /** @param {import("./session").SessionController} controller */
  constructor(controller) {
    this.controller = controller;
    /** @type {Map<number, {cursor: vscode.TextEditorDecorationType, selection: vscode.TextEditorDecorationType, name: string}>} */
    this.decorations = new Map();
    this.following = null;
    this._lastFollowed = "";

    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;

    this._subscriptions = [
      vscode.window.onDidChangeVisibleTextEditors(() => this.draw()),
      controller.onDidChange(() => this.prune()),
    ];
  }

  // -- decoration types --------------------------------------------------

  typesFor(participantId, name) {
    const existing = this.decorations.get(participantId);
    if (existing && existing.name === name) return existing;
    if (existing) this.disposeTypes(existing);

    const { hex } = colorFor(participantId);
    const created = {
      name,
      cursor: vscode.window.createTextEditorDecorationType({
        borderStyle: "solid",
        borderWidth: "0 0 0 2px",
        borderColor: hex,
        gutterIconPath: avatarIcon(name, hex),
        gutterIconSize: "auto",
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        after: {
          contentText: " " + name + " ",
          backgroundColor: hex,
          color: readableInk(hex),
          margin: "0 0 0 6px",
          fontWeight: "600",
          textDecoration: "none; border-radius: 3px; font-size: 0.82em; padding: 0 1px;",
        },
      }),
      selection: vscode.window.createTextEditorDecorationType({
        backgroundColor: withAlpha(hex, 0.22),
        borderRadius: "2px",
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      }),
    };
    this.decorations.set(participantId, created);
    return created;
  }

  disposeTypes(entry) {
    entry.cursor.dispose();
    entry.selection.dispose();
  }

  // -- drawing -----------------------------------------------------------

  /** Redraw every visible editor from the controller's presence map. */
  draw() {
    const people = this.controller.presence;
    const editors = vscode.window.visibleTextEditors;
    if (!editors.length) return;

    for (const editor of editors) {
      const relative = workspace.relativePathOf(editor.document.uri);

      for (const [participantId, entry] of this.decorations) {
        const presence = people.get(participantId);
        const here = presence && relative && presence.path === relative;

        if (!here) {
          editor.setDecorations(entry.cursor, []);
          editor.setDecorations(entry.selection, []);
          continue;
        }

        editor.setDecorations(entry.cursor, [this.caretRange(editor, presence)]);
        const selection = this.selectionRange(editor, presence);
        editor.setDecorations(entry.selection, selection ? [selection] : []);
      }
    }
  }

  caretRange(editor, presence) {
    const line = clampLine(editor, (presence.line || 1) - 1);
    const column = clampColumn(editor, line, (presence.column || 1) - 1);
    const position = new vscode.Position(line, column);
    return new vscode.Range(position, position);
  }

  selectionRange(editor, presence) {
    const s = presence.selection;
    if (!s) return null;
    const startLine = clampLine(editor, (s.start_line || 1) - 1);
    const endLine = clampLine(editor, (s.end_line || 1) - 1);
    const start = new vscode.Position(
      startLine,
      clampColumn(editor, startLine, (s.start_column || 1) - 1)
    );
    const end = new vscode.Position(
      endLine,
      clampColumn(editor, endLine, (s.end_column || 1) - 1)
    );
    if (start.isEqual(end)) return null;
    return new vscode.Range(start, end);
  }

  /** Called when presence arrives for someone. */
  update(participantId, presence) {
    this.typesFor(participantId, presence.displayName || "?");
    this.draw();
    if (this.following === participantId) {
      this.jumpTo(presence).catch((err) =>
        log.warn("Follow failed: " + (err && err.message))
      );
    }
  }

  /** Drop anyone who is no longer in the session. */
  prune() {
    const live = new Set(
      this.controller.participants
        .filter((p) => p.state === "approved")
        .map((p) => p.participant_id)
    );
    for (const [participantId, entry] of Array.from(this.decorations)) {
      if (live.has(participantId)) continue;
      this.disposeTypes(entry);
      this.decorations.delete(participantId);
      if (this.following === participantId) this.unfollow();
    }
    this.draw();
  }

  // -- follow ------------------------------------------------------------

  isFollowing(participantId) {
    return this.following === participantId;
  }

  async follow(participantId) {
    if (this.following === participantId) return this.unfollow();

    this.following = participantId;
    this._lastFollowed = "";
    this._onDidChange.fire();

    const presence = this.controller.presence.get(participantId);
    if (presence) await this.jumpTo(presence);
    return true;
  }

  unfollow() {
    this.following = null;
    this._onDidChange.fire();
    return false;
  }

  async jumpTo(presence) {
    if (!presence || !presence.path) return;

    // Opening the same place repeatedly steals focus on every keystroke the
    // other person makes, so only move when the target actually moved.
    const marker = presence.path + ":" + (presence.line || 1);
    if (marker === this._lastFollowed) return;
    this._lastFollowed = marker;

    const uri = workspace.resolve(presence.path);
    if (!uri) return;

    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, {
      preserveFocus: true,
      preview: true,
    });
    const line = clampLine(editor, (presence.line || 1) - 1);
    editor.revealRange(
      new vscode.Range(line, 0, line, 0),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
    this.draw();
  }

  dispose() {
    this._subscriptions.forEach((d) => d.dispose());
    for (const entry of this.decorations.values()) this.disposeTypes(entry);
    this.decorations.clear();
    this._onDidChange.dispose();
  }
}

function clampLine(editor, line) {
  const max = Math.max(editor.document.lineCount - 1, 0);
  return Math.min(Math.max(line, 0), max);
}

function clampColumn(editor, line, column) {
  const max = editor.document.lineAt(line).text.length;
  return Math.min(Math.max(column, 0), max);
}

module.exports = { PresenceView, avatarIcon };
