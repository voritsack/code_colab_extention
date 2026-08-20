"use strict";

/**
 * Per-person colour and initials.
 *
 * Derived from the participant id rather than handed out by the server, so
 * every peer independently arrives at the same colour for the same person
 * without anything having to be synchronised.
 */

// Picked for legibility on both light and dark editor backgrounds, and to
// stay distinguishable from each other for the most common colour vision
// deficiencies (no red/green pair adjacent in the rotation).
const PALETTE = [
  { name: "blue", hex: "#1ABCFE" },
  { name: "orange", hex: "#F24E1E" },
  { name: "purple", hex: "#A259FF" },
  { name: "green", hex: "#0ACF83" },
  { name: "pink", hex: "#FF4D8D" },
  { name: "amber", hex: "#FFC02E" },
  { name: "teal", hex: "#00B5AD" },
  { name: "salmon", hex: "#FF7262" },
];

function colorFor(participantId) {
  const index = Math.abs(Number(participantId) || 0) % PALETTE.length;
  return PALETTE[index];
}

/** Same colour at low alpha, for selection fills. */
function withAlpha(hex, alpha) {
  const value = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, "0");
  return hex + value;
}

/**
 * Text is drawn on the participant's colour, so pick black or white by
 * perceived brightness rather than always using one.
 */
function readableInk(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#101418" : "#ffffff";
}

/** "Ada Lovelace" -> "AL", "davit" -> "DA". */
function initials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

module.exports = { PALETTE, colorFor, withAlpha, readableInk, initials };
