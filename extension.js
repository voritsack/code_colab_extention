const vscode = require("vscode");
const WebSocket = require("ws");
const http = require("http");
const https = require("https");

const CLIENT_ID = "vscode_" + Math.random().toString(36).substring(2, 11);

let ws = null;
let currentTargetId = null;
let isApplyingRemoteChange = false;

const DEFAULT_SERVER_URL = "http://127.0.0.1:8000";

/**
 * Resolve the backend origin. Precedence:
 *   1. BLOGAPP_SERVER_URL environment variable
 *   2. the "blogapp.serverUrl" VS Code setting
 *   3. DEFAULT_SERVER_URL
 * Read lazily so a settings/env change is picked up without a reload.
 */
function getServerUrl() {
  const fromEnv = process.env.BLOGAPP_SERVER_URL;
  const fromSettings = vscode.workspace
    .getConfiguration("blogapp")
    .get("serverUrl");
  const url = fromEnv || fromSettings || DEFAULT_SERVER_URL;
  return String(url).replace(/\/+$/, "");
}

/**
 * Resolve the WebSocket origin. Uses BLOGAPP_WS_URL / "blogapp.wsUrl" when set,
 * otherwise derives it from the server URL (http -> ws, https -> wss).
 */
function getWsUrl() {
  const fromEnv = process.env.BLOGAPP_WS_URL;
  const fromSettings = vscode.workspace
    .getConfiguration("blogapp")
    .get("wsUrl");
  const url = fromEnv || fromSettings;
  if (url) return String(url).replace(/\/+$/, "");
  return getServerUrl().replace(/^http/, "ws");
}

function makeRequest(urlString, method, headers = {}, bodyData = null) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(urlString);
      const client = parsedUrl.protocol === "https:" ? https : http;
      const reqHeaders = { ...headers };

      let payload = null;
      if (bodyData) {
        payload =
          typeof bodyData === "string" ? bodyData : JSON.stringify(bodyData);
        reqHeaders["Content-Length"] = Buffer.byteLength(payload);
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method,
        headers: reqHeaders,
      };

      const req = client.request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const data = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (e) {
              resolve(data);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on("error", (err) => reject(err));
      if (payload) req.write(payload);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function getOrLoginToken(context) {
  let token = await context.secrets.get("blogapp_token");
  if (token) return token;

  const email = await vscode.window.showInputBox({
    prompt: "Email для BlogApp",
    ignoreFocusOut: true,
  });
  if (!email) return null;

  const password = await vscode.window.showInputBox({
    prompt: "Пароль",
    ignoreFocusOut: true,
    password: true,
  });
  if (!password) return null;

  try {
    const authData = await makeRequest(
      `${getServerUrl()}/api/token/`,
      "POST",
      { "Content-Type": "application/json" },
      { email, password },
    );

    const receivedToken =
      authData.access || authData.token || authData.key || authData.auth_token;

    if (!receivedToken) throw new Error("Токен не получен");
    await context.secrets.store("blogapp_token", receivedToken);
    return receivedToken;
  } catch (err) {
    vscode.window.showErrorMessage(`Ошибка входа: ${err.message}`);
    return null;
  }
}

async function ensureFileExists(relativePath, initialContent = "") {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return null;
  const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, relativePath);
  try {
    await vscode.workspace.fs.stat(fileUri);
  } catch (err) {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(fileUri, ".."),
    );
    await vscode.workspace.fs.writeFile(
      fileUri,
      Buffer.from(initialContent, "utf8"),
    );
  }
  return fileUri;
}

async function handleRemoteContentUpdate(filePath, newCode) {
  isApplyingRemoteChange = true;
  try {
    const fileUri = await ensureFileExists(
      filePath.replace(/\\/g, "/"),
      newCode,
    );
    if (!fileUri) return;
    const doc = await vscode.workspace.openTextDocument(fileUri);
    if (doc.getText() !== newCode) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        doc.uri,
        new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length),
        ),
        newCode,
      );
      await vscode.workspace.applyEdit(edit);
    }
  } finally {
    setTimeout(() => {
      isApplyingRemoteChange = false;
    }, 50);
  }
}

function setupWebSocketListeners(socket) {
  socket.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.client_id === CLIENT_ID) return;

      if (message.type === "request_full_project") {
        const relativeFiles = await vscode.workspace.findFiles(
          "**/*",
          "**/{node_modules,.git,dist,build}/**",
        );
        const filesPayload = await Promise.all(
          relativeFiles.map(async (uri) => ({
            path: vscode.workspace.asRelativePath(uri),
            code: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
              "utf8",
            ),
          })),
        );
        socket.send(
          JSON.stringify({
            type: "project_structure",
            files: filesPayload,
            sender: "vscode",
            client_id: CLIENT_ID,
          }),
        );
      }

      if (
        (message.type === "file_update" || message.type === "code_updated") &&
        message.code !== undefined
      ) {
        await handleRemoteContentUpdate(message.file_path, message.code);
      }
    } catch (err) {
      console.error(err);
    }
  });
}

function connectWS(context, url, targetId) {
  if (ws) {
    ws.removeAllListeners();
    ws.close();
  }
  currentTargetId = targetId;
  context.secrets.get("blogapp_token").then((token) => {
    ws = new WebSocket(`${url}?token=${token}`);
    setupWebSocketListeners(ws);
  });
}

// --- Основная активация ---

function activate(context) {
  // 1. Трансляция проекта
  let startProjectCmd = vscode.commands.registerCommand(
    "blogapp.startProjectSync",
    async () => {
      let token = await getOrLoginToken(context);
      if (!token) return;

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage("Откройте папку проекта в VS Code!");
        return;
      }

      const folderPath = workspaceFolders[0].uri.fsPath;
      const projectName = folderPath.split(/[\\/]/).pop();

      try {
        const relativeFiles = await vscode.workspace.findFiles(
          "**/*",
          "**/{node_modules,.git,dist,build}/**",
        );

        // Используем поле 'code' вместо 'content' для предотвращения KeyError на бэкенде
        const filesPayload = await Promise.all(
          relativeFiles.map(async (uri) => ({
            path: vscode.workspace.asRelativePath(uri),
            code: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
              "utf8",
            ),
          })),
        );

        const res = await makeRequest(
          `${getServerUrl()}/apiP/projects/sync/`,
          "POST",
          {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          {
            project_name: projectName,
            files: filesPayload,
          },
        );

        const projectId = res.project_id || res.id;
        if (!projectId) {
          throw new Error("Не удалось получить ID проекта от сервера");
        }

        connectWS(context, `${getWsUrl()}/ws/project/${projectId}/`, projectId);
        vscode.window.showInformationMessage(
          `🚀 Трансляция проекта "${projectName}" (ID: ${projectId}) успешно запущена!`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Ошибка запуска трансляции: ${err.message}`,
        );
      }
    },
  );

  // 2. Трансляция файла
  let startSingleFileCmd = vscode.commands.registerCommand(
    "blogapp.startSingleFileSync",
    async () => {
      let token = await getOrLoginToken(context);
      if (!token) return;

      const fileId = await vscode.window.showInputBox({
        prompt: "Введите ID файла на сайте для трансляции",
        ignoreFocusOut: true,
      });
      if (!fileId) return;

      connectWS(context, `${getWsUrl()}/ws/file/${fileId}/`, fileId);
      vscode.window.showInformationMessage("🚀 Трансляция файла активна.");
    },
  );

  // 3. Сохранение проекта
  let saveProjectCmd = vscode.commands.registerCommand(
    "blogapp.saveProject",
    async () => {
      let token = await getOrLoginToken(context);
      if (!token) return;

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage("Нет открытой папки проекта!");
        return;
      }

      try {
        const relativeFiles = await vscode.workspace.findFiles(
          "**/*",
          "**/{node_modules,.git,dist,build}/**",
        );
        const filesPayload = await Promise.all(
          relativeFiles.map(async (uri) => ({
            path: vscode.workspace.asRelativePath(uri),
            code: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
              "utf8",
            ),
          })),
        );

        await makeRequest(
          `${getServerUrl()}/api/save-project/`,
          "POST",
          {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          { files: filesPayload },
        );

        vscode.window.showInformationMessage(
          "💾 Проект успешно сохранен на сайте!",
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Ошибка сохранения: ${err.message}`);
      }
    },
  );

  // 4. Выход из аккаунта
  let logoutCmd = vscode.commands.registerCommand(
    "blogapp.logout",
    async () => {
      await context.secrets.delete("blogapp_token");
      vscode.window.showInformationMessage("Выход из аккаунта выполнен.");
    },
  );

  // 5. Подключение к комнатам
  let connectRoomCmd = vscode.commands.registerCommand(
    "blogapp.connectToRoom",
    async () => {
      let userToken = await getOrLoginToken(context);
      if (!userToken) return;

      const roomId = await vscode.window.showInputBox({
        prompt: "Введите ID комнаты",
      });
      if (!roomId) return;

      connectWS(context, `${getWsUrl()}/ws/room/${roomId}/`, roomId);
      vscode.window.showInformationMessage(
        `👥 Подключено к комнате #${roomId}`,
      );
    },
  );

  let joinProjectSyncCmd = vscode.commands.registerCommand(
    "blogapp.joinProjectSync",
    async () => {
      vscode.commands.executeCommand("blogapp.connectToRoom");
    },
  );

  // 6. Отслеживание изменений в файлах для отправки по WebSocket
  let changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (isApplyingRemoteChange || event.contentChanges.length === 0) return;
    if (ws && ws.readyState === WebSocket.OPEN && currentTargetId) {
      ws.send(
        JSON.stringify({
          type: "file_update",
          file_path: vscode.workspace.asRelativePath(event.document.uri),
          code: event.document.getText(),
          sender: "vscode",
          client_id: CLIENT_ID,
        }),
      );
    }
  });

  context.subscriptions.push(
    startProjectCmd,
    startSingleFileCmd,
    saveProjectCmd,
    logoutCmd,
    connectRoomCmd,
    joinProjectSyncCmd,
    changeListener,
  );
}

function deactivate() {
  if (ws) ws.close();
}

module.exports = { activate, deactivate };
