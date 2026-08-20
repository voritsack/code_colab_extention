"use strict";

/**
 * A small stand-in for the `vscode` module.
 *
 * Enough of the API surface for the extension's own modules to run outside
 * VS Code, so `npm test` can drive a real session against a real server.
 * Prompts are scripted rather than shown; the filesystem is real.
 */

const fs = require("fs");
const path = require("path");
const nodePath = path;

const state = {
  workspaceRoot: null,
  settings: {},
  answers: [], // queued responses for showInputBox / showQuickPick
  messages: [],
  contexts: {},
  clipboard: "",
  documents: new Map(), // fsPath -> { text }
};

// --- events ---------------------------------------------------------------

class EventEmitter {
  constructor() {
    this.handlers = new Set();
    this.event = (handler) => {
      this.handlers.add(handler);
      return { dispose: () => this.handlers.delete(handler) };
    };
  }
  fire(value) {
    for (const handler of Array.from(this.handlers)) handler(value);
  }
  dispose() {
    this.handlers.clear();
  }
}

const emitters = {
  changeText: new EventEmitter(),
  saveText: new EventEmitter(),
  createFiles: new EventEmitter(),
  deleteFiles: new EventEmitter(),
  renameFiles: new EventEmitter(),
  activeEditor: new EventEmitter(),
  selection: new EventEmitter(),
};

// --- Uri ------------------------------------------------------------------

class Uri {
  constructor(fsPath) {
    this.scheme = "file";
    this.fsPath = fsPath;
    this.path = fsPath.replace(/\\/g, "/");
  }
  toString() {
    return "file://" + this.path;
  }
  static file(p) {
    return new Uri(p);
  }
  static parse(value) {
    return new Uri(String(value).replace(/^file:\/\//, ""));
  }
  static joinPath(base, ...parts) {
    return new Uri(nodePath.resolve(base.fsPath, ...parts));
  }
}

// --- filesystem -----------------------------------------------------------

const fsApi = {
  async readFile(uri) {
    return new Uint8Array(fs.readFileSync(uri.fsPath));
  },
  async writeFile(uri, bytes) {
    fs.mkdirSync(nodePath.dirname(uri.fsPath), { recursive: true });
    fs.writeFileSync(uri.fsPath, Buffer.from(bytes));
  },
  async createDirectory(uri) {
    fs.mkdirSync(uri.fsPath, { recursive: true });
  },
  async stat(uri) {
    const s = fs.statSync(uri.fsPath);
    return { type: s.isDirectory() ? 2 : 1, size: s.size };
  },
  async delete(uri) {
    fs.rmSync(uri.fsPath, { force: true, recursive: false });
  },
  async readDirectory(uri) {
    return fs
      .readdirSync(uri.fsPath, { withFileTypes: true })
      .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
  },
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// --- documents ------------------------------------------------------------

class TextDocument {
  constructor(uri, text) {
    this.uri = uri;
    this._text = text;
    this.isClosed = false;
  }
  getText() {
    return this._text;
  }
  positionAt(offset) {
    return { offset };
  }
  setText(text) {
    this._text = text;
  }
}

function openDocument(fsPath, text) {
  const uri = Uri.file(fsPath);
  const doc = new TextDocument(uri, text);
  state.documents.set(fsPath, doc);
  return doc;
}

// --- configuration --------------------------------------------------------

const DEFAULTS = {
  serverUrl: "http://127.0.0.1:8000",
  wsUrl: "",
  exclude: [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
  ],
  maxFileBytes: 512000,
  maxFiles: 2000,
  syncDelayMs: 20,
  autoOpenPanel: false,
};

function getConfiguration(section) {
  return {
    get(key) {
      const scoped = state.settings[section + "." + key];
      if (scoped !== undefined) return scoped;
      return DEFAULTS[key];
    },
    async update(key, value) {
      state.settings[section + "." + key] = value;
    },
  };
}

// --- window ---------------------------------------------------------------

function nextAnswer(label) {
  if (!state.answers.length) {
    throw new Error("vscode-stub: no scripted answer for " + label);
  }
  return state.answers.shift();
}

const vscode = {
  EventEmitter,
  Uri,
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class ThemeIcon {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class MarkdownString {
    constructor(value) {
      this.value = value;
    }
  },
  TreeItem: class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  Range: class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  Position: class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  WorkspaceEdit: class WorkspaceEdit {
    constructor() {
      this.edits = [];
    }
    replace(uri, range, text) {
      this.edits.push({ uri, text });
    }
  },
  StatusBarAlignment: { Left: 1, Right: 2 },

  env: {
    clipboard: {
      async writeText(value) {
        state.clipboard = value;
      },
      async readText() {
        return state.clipboard;
      },
    },
    async openExternal() {
      return true;
    },
  },

  commands: {
    async executeCommand(name, key, value) {
      if (name === "setContext") state.contexts[key] = value;
      return undefined;
    },
    registerCommand(name, handler) {
      return { dispose() {}, name, handler };
    },
  },

  window: {
    activeTextEditor: undefined,
    createOutputChannel() {
      return {
        appendLine(line) {
          if (process.env.CODECOLAB_TEST_VERBOSE) console.log("  | " + line);
        },
        show() {},
        dispose() {},
      };
    },
    createStatusBarItem() {
      return { show() {}, hide() {}, dispose() {}, text: "", tooltip: "" };
    },
    createTreeView(id, options) {
      return { dispose() {}, provider: options.treeDataProvider };
    },
    registerUriHandler() {
      return { dispose() {} };
    },
    setStatusBarMessage(message) {
      state.messages.push(["status", message]);
      return { dispose() {} };
    },
    showInformationMessage(message) {
      state.messages.push(["info", message]);
      return Promise.resolve(undefined);
    },
    showWarningMessage(message) {
      state.messages.push(["warn", message]);
      return Promise.resolve(undefined);
    },
    showErrorMessage(message) {
      state.messages.push(["error", message]);
      return Promise.resolve(undefined);
    },
    showInputBox(options) {
      return Promise.resolve(nextAnswer("input:" + (options && options.prompt)));
    },
    showQuickPick(items) {
      const answer = nextAnswer("quickpick");
      if (typeof answer === "number") return Promise.resolve(items[answer]);
      return Promise.resolve(answer);
    },
    withProgress(_options, task) {
      return task(
        { report() {} },
        { isCancellationRequested: false, onCancellationRequested() {} }
      );
    },
    onDidChangeActiveTextEditor: emitters.activeEditor.event,
    onDidChangeTextEditorSelection: emitters.selection.event,
  },

  workspace: {
    get workspaceFolders() {
      return state.workspaceRoot
        ? [{ uri: Uri.file(state.workspaceRoot), name: nodePath.basename(state.workspaceRoot), index: 0 }]
        : undefined;
    },
    get textDocuments() {
      return Array.from(state.documents.values());
    },
    getConfiguration,
    fs: fsApi,
    asRelativePath(uri) {
      if (!state.workspaceRoot) return uri.fsPath;
      const relative = nodePath.relative(state.workspaceRoot, uri.fsPath);
      return relative || uri.fsPath;
    },
    async findFiles(pattern, exclude, max) {
      if (!state.workspaceRoot) return [];
      const excludeRe = exclude
        ? exclude
            .replace(/^\{|\}$/g, "")
            .split(",")
            .map((glob) => globToRe(glob))
        : [];
      const files = walk(state.workspaceRoot)
        .map((full) => nodePath.relative(state.workspaceRoot, full).replace(/\\/g, "/"))
        .filter((rel) => !excludeRe.some((re) => re.test(rel)))
        .slice(0, max || 5000);
      return files.map((rel) => Uri.file(nodePath.join(state.workspaceRoot, rel)));
    },
    async applyEdit(edit) {
      for (const item of edit.edits) {
        const doc = state.documents.get(item.uri.fsPath);
        if (doc) doc.setText(item.text);
        fs.mkdirSync(nodePath.dirname(item.uri.fsPath), { recursive: true });
        fs.writeFileSync(item.uri.fsPath, item.text, "utf8");
      }
      return true;
    },
    onDidChangeTextDocument: emitters.changeText.event,
    onDidSaveTextDocument: emitters.saveText.event,
    onDidCreateFiles: emitters.createFiles.event,
    onDidDeleteFiles: emitters.deleteFiles.event,
    onDidRenameFiles: emitters.renameFiles.event,
  },
};

function globToRe(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$.|+()[]{}?".indexOf(ch) !== -1) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp("^" + out + "$");
}

// --- install --------------------------------------------------------------

function install() {
  const Module = require("module");
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return vscode;
    return original.call(this, request, parent, isMain);
  };
}

module.exports = { vscode, state, emitters, install, openDocument, TextDocument };
