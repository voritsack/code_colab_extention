"use strict";

/**
 * The backend's REST surface.
 *
 * Every authenticated call carries a session token: the one minted when you
 * created the session (role=host) or when you joined it. There are no
 * accounts and nothing longer-lived than a session.
 */

const config = require("./config");
const { request } = require("./http");

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

  lifecycle(publicId, sessionToken, action) {
    return request(this.base() + "/api/sessions/" + publicId + "/" + action, {
      method: "POST",
      headers: bearer(sessionToken),
    });
  }
}

module.exports = { Api, bearer };
