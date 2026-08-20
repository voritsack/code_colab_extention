"use strict";

/** Thin wrappers over the backend's REST surface. */

const config = require("./config");
const { request } = require("./http");

function bearer(token) {
  return { Authorization: "Bearer " + token };
}

class Api {
  /** @param {import("./auth").Auth} auth */
  constructor(auth) {
    this.auth = auth;
  }

  base() {
    return config.serverUrl();
  }

  /** Server capabilities, reachable without a token. */
  info() {
    return request(this.base() + "/api/info", { timeoutMs: 8000 });
  }

  me() {
    return this.auth.withToken((token) =>
      request(this.base() + "/api/auth/me", { headers: bearer(token) })
    );
  }

  createSession(payload) {
    return this.auth.withToken((token) =>
      request(this.base() + "/api/sessions", {
        method: "POST",
        headers: bearer(token),
        body: payload,
      })
    );
  }

  mySessions() {
    return this.auth.withToken((token) =>
      request(this.base() + "/api/sessions/mine", { headers: bearer(token) })
    );
  }

  uploadSnapshot(publicId, files) {
    return this.auth.withToken((token) =>
      request(this.base() + "/api/sessions/" + publicId + "/files", {
        method: "PUT",
        headers: bearer(token),
        body: { files },
        timeoutMs: 120000,
      })
    );
  }

  /** Resync using the session token rather than the account token. */
  downloadSnapshot(publicId, sessionToken) {
    return request(this.base() + "/api/sessions/" + publicId + "/files", {
      headers: bearer(sessionToken),
      timeoutMs: 120000,
    });
  }

  peek(code) {
    return request(this.base() + "/api/sessions/by-code/" + encodeURIComponent(code), {
      timeoutMs: 8000,
    });
  }

  /**
   * Join as a signed-in user when `accessToken` is given, otherwise as a guest.
   */
  join({ code, displayName, clientId, accessToken }) {
    return request(this.base() + "/api/sessions/join", {
      method: "POST",
      headers: accessToken ? bearer(accessToken) : {},
      body: { code, display_name: displayName, client_id: clientId },
    });
  }

  lifecycle(publicId, action) {
    return this.auth.withToken((token) =>
      request(this.base() + "/api/sessions/" + publicId + "/" + action, {
        method: "POST",
        headers: bearer(token),
      })
    );
  }
}

module.exports = { Api, bearer };
