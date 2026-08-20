"use strict";

/**
 * Minimal JSON HTTP client on node's built-ins.
 *
 * No dependency worth adding for this: a handful of requests, all JSON, all
 * to one origin.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, body, url) {
    super(HttpError.describe(status, body));
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.url = url;
  }

  static describe(status, body) {
    if (body && typeof body === "object") {
      if (typeof body.detail === "string") return body.detail;
      // FastAPI validation errors arrive as a list of objects.
      if (Array.isArray(body.detail) && body.detail.length) {
        const first = body.detail[0];
        if (first && first.msg) {
          const where = Array.isArray(first.loc) ? first.loc.join(".") + ": " : "";
          return where + first.msg;
        }
      }
    }
    if (typeof body === "string" && body.trim()) return body.slice(0, 300);
    return "HTTP " + status;
  }
}

/**
 * @param {string} url
 * @param {{method?: string, headers?: object, body?: any, timeoutMs?: number}} options
 */
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error("Invalid URL: " + url));
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(new Error("Only http and https are supported"));
      return;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const headers = Object.assign({ Accept: "application/json" }, options.headers);

    let payload = null;
    if (options.body !== undefined && options.body !== null) {
      if (typeof options.body === "string") {
        payload = Buffer.from(options.body, "utf8");
      } else {
        payload = Buffer.from(JSON.stringify(options.body), "utf8");
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
      }
      headers["Content-Length"] = payload.length;
    }

    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("Response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body = text;
          const type = res.headers["content-type"] || "";
          if (type.indexOf("application/json") !== -1 && text) {
            try {
              body = JSON.parse(text);
            } catch (err) {
              /* keep the raw text */
            }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new HttpError(res.statusCode, body, url));
          }
        });
      }
    );

    req.setTimeout(options.timeoutMs || DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Stream a URL to a file, returning the sha256 of what actually arrived.
 *
 * Used to fetch extension builds, so the caller can check the digest before
 * doing anything with the file.
 */
function download(url, destination, { timeoutMs = 120000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const fs = require("fs");
  const crypto = require("crypto");

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error("Invalid URL: " + url));
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(new Error("Only http and https are supported"));
      return;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(new URL(res.headers.location, url).toString(), destination, {
          timeoutMs,
          maxBytes,
        }).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new HttpError(res.statusCode, "", url));
        return;
      }

      const hash = crypto.createHash("sha256");
      const file = fs.createWriteStream(destination);
      let size = 0;

      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error("Download too large"));
          return;
        }
        hash.update(chunk);
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve({ sha256: hash.digest("hex"), size })));
      file.on("error", reject);
      res.on("error", reject);
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error("Download timed out")));
    req.on("error", reject);
  });
}

module.exports = { request, download, HttpError };
