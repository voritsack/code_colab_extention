"use strict";

/**
 * The backend's REST surface.
 *
 * Every authenticated call carries a session token: the one minted when you
 * created the session (role=host) or when you joined it. There are no
 * accounts and nothing longer-lived than a session.
 */

const config = require("./config");
const { request, download } = require("./http");
const { upload } = require("./multipart");

function bearer(token) {
  return { Authorization: "Bearer " + token };
}

class Api {
  base() {
    return config.serverUrl();
  }

  /** Server capabilities, reachable without any token. */
  info() {
    return request(this.base() + "/api/info", { timeoutMs: 8000 });
  }

  createSession(payload) {
    return request(this.base() + "/api/sessions", {
      method: "POST",
      body: payload,
      timeoutMs: 30000,
    });
  }

  join({ code, displayName, clientId }) {
    return request(this.base() + "/api/sessions/join", {
      method: "POST",
      body: { code, display_name: displayName, client_id: clientId },
    });
  }

  peek(code) {
    return request(this.base() + "/api/sessions/by-code/" + encodeURIComponent(code), {
      timeoutMs: 8000,
    });
  }

  uploadSnapshot(publicId, sessionToken, files) {
    return request(this.base() + "/api/sessions/" + publicId + "/files", {
      method: "PUT",
      headers: bearer(sessionToken),
      body: { files },
      timeoutMs: 180000,
    });
  }

  downloadSnapshot(publicId, sessionToken) {
    return request(this.base() + "/api/sessions/" + publicId + "/files", {
      headers: bearer(sessionToken),
      timeoutMs: 120000,
    });
  }

  // -- attachments: files passed round the session, not part of the project --

  attachmentsUrl(publicId) {
    return this.base() + "/api/sessions/" + publicId + "/attachments";
  }

  listAttachments(publicId, sessionToken) {
    return request(this.attachmentsUrl(publicId), { headers: bearer(sessionToken) });
  }

  uploadAttachment(publicId, sessionToken, filePath, fileName, contentType) {
    return upload(this.attachmentsUrl(publicId), filePath, {
      fileName,
      contentType,
      headers: bearer(sessionToken),
    });
  }

  downloadAttachment(publicId, sessionToken, attachmentId, destination) {
    return download(
      this.attachmentsUrl(publicId) + "/" + attachmentId,
      destination,
      { headers: bearer(sessionToken) }
    );
  }

  downloadBundle(publicId, sessionToken, destination) {
    return download(this.attachmentsUrl(publicId) + "/bundle.zip", destination, {
      headers: bearer(sessionToken),
    });
  }

  detachAttachment(publicId, sessionToken, attachmentId) {
    return request(this.attachmentsUrl(publicId) + "/" + attachmentId, {
      method: "DELETE",
      headers: bearer(sessionToken),
    });
  }

  lifecycle(publicId, sessionToken, action) {
    return request(this.base() + "/api/sessions/" + publicId + "/" + action, {
      method: "POST",
      headers: bearer(sessionToken),
    });
  }
}

module.exports = { Api, bearer };
