"use strict";

/**
 * Uploading one file as multipart/form-data.
 *
 * Hand-rolled rather than pulling in a dependency: the shape is fixed - one
 * file, plus a handful of short text fields - and the body is streamed off
 * disk, so a 25 MB attachment is never held in memory on top of the copy
 * already on the filesystem.
 */

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { URL } = require("url");

const { HttpError } = require("./http");

const CRLF = "\r\n";
// A quote or a newline in a field name would break out of the header.
const UNSAFE_FIELD_CHARS = /["\r\n]/g;

function upload(
  url,
  filePath,
  {
    fieldName = "file",
    fileName,
    contentType = "application/octet-stream",
    fields = {},
    headers = {},
    timeoutMs = 300000,
  } = {}
) {
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

    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch (err) {
      reject(new Error("Cannot read " + filePath));
      return;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const boundary = "----codecolab" + crypto.randomBytes(16).toString("hex");
    // A quote in a filename would otherwise break out of the header field.
    const name = (fileName || path.basename(filePath)).replace(/["\r\n]/g, "");

    // Text fields first: the server reads them off the parsed form, but a
    // streaming parser reaching the file last is the friendlier order.
    let prefix = "";
    for (const key of Object.keys(fields)) {
      const value = fields[key];
      if (value === undefined || value === null || value === "") continue;
      prefix +=
        "--" + boundary + CRLF +
        'Content-Disposition: form-data; name="' + key.replace(UNSAFE_FIELD_CHARS, "") + '"' +
        CRLF + CRLF + String(value) + CRLF;
    }

    const head = Buffer.from(
      prefix +
        "--" + boundary + CRLF +
        'Content-Disposition: form-data; name="' + fieldName +
        '"; filename="' + name + '"' + CRLF +
        "Content-Type: " + contentType + CRLF + CRLF,
      "utf8"
    );
    const tail = Buffer.from(CRLF + "--" + boundary + "--" + CRLF, "utf8");

    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: Object.assign({}, headers, {
          "Content-Type": "multipart/form-data; boundary=" + boundary,
          "Content-Length": head.length + size + tail.length,
          Accept: "application/json",
        }),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body = text;
          try {
            body = JSON.parse(text);
          } catch (err) {
            /* keep the raw text */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
          else reject(new HttpError(res.statusCode, body, url));
        });
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error("Upload timed out")));
    req.on("error", reject);

    req.write(head);
    const stream = fs.createReadStream(filePath);
    stream.on("error", (err) => {
      req.destroy(err);
      reject(err);
    });
    stream.on("end", () => {
      req.end(tail);
    });
    stream.pipe(req, { end: false });
  });
}

module.exports = { upload };
