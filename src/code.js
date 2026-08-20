"use strict";

/**
 * Join-code parsing.
 *
 * Accepts whatever a person is likely to paste: the bare code, the code in
 * caps, the code with spaces instead of dashes, a full invite URL, or the
 * `vscode://` deep link.
 */

const SHAPE = [3, 4, 3];
const TOTAL = SHAPE.reduce((a, b) => a + b, 0);

function normalizeCode(raw) {
  let value = String(raw || "").trim().toLowerCase();
  if (!value) return "";

  // vscode://codecolab.codecolab/join?code=abc-defg-hij
  const codeParam = value.match(/[?&]code=([^&]+)/);
  if (codeParam) {
    value = decodeURIComponent(codeParam[1]);
  } else if (value.indexOf("/") !== -1) {
    // https://host/j/abc-defg-hij
    value = value.replace(/[?#].*$/, "").replace(/\/+$/, "");
    value = value.split("/").pop();
  }

  const letters = value.replace(/[^a-z0-9]/g, "");
  if (letters.length !== TOTAL) return "";

  const parts = [];
  let index = 0;
  for (const size of SHAPE) {
    parts.push(letters.slice(index, index + size));
    index += size;
  }
  return parts.join("-");
}

module.exports = { normalizeCode, SHAPE, TOTAL };
