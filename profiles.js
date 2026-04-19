const express = require("express");

const router  = express.Router();
const profiles = new Map(); // ownerCode → { avatar, status, updatedAt }

const cleanCode = (v) => String(v ?? "").trim().toUpperCase();
const cleanStr  = (v) => String(v ?? "").trim();
const now       = ()  => new Date().toISOString();

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB base64 limit

function getProfile(ownerCode) {
  if (!profiles.has(ownerCode)) {
    profiles.set(ownerCode, { ownerCode, avatar: null, status: "", updatedAt: now() });
  }
  return profiles.get(ownerCode);
}

// ─────────────────────────────────────────────────────────────
// POST /profiles/avatar
// Body: { ownerCode, imageBase64, mimeType }
// mimeType: "image/jpeg" | "image/png" | "image/webp"
// ─────────────────────────────────────────────────────────────
router.post("/avatar", (req, res) => {
  const ownerCode   = cleanCode(req.body?.ownerCode);
  const imageBase64 = cleanStr(req.body?.imageBase64);
  const mimeType    = cleanStr(req.body?.mimeType) || "image/jpeg";

  if (!ownerCode || !imageBase64) {
    return res.status(400).json({ error: "Missing ownerCode or imageBase64" });
  }

  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowedTypes.includes(mimeType)) {
    return res.status(400).json({ error: "Unsupported image type" });
  }

  if (imageBase64.length > MAX_AVATAR_BYTES) {
    return res.status(413).json({ error: "Image too large (max 2MB)" });
  }

  const profile = getProfile(ownerCode);
  profile.avatar    = `data:${mimeType};base64,${imageBase64}`;
  profile.updatedAt = now();
  profiles.set(ownerCode, profile);

  console.log(`[profile] Avatar updated for ${ownerCode}`);
  return res.json({ ok: true, ownerCode });
});

// ─────────────────────────────────────────────────────────────
// POST /profiles/status
// Body: { ownerCode, status }
// ─────────────────────────────────────────────────────────────
router.post("/status", (req, res) => {
  const ownerCode = cleanCode(req.body?.ownerCode);
  const status    = cleanStr(req.body?.status).slice(0, 60);

  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });

  const profile     = getProfile(ownerCode);
  profile.status    = status;
  profile.updatedAt = now();
  profiles.set(ownerCode, profile);

  console.log(`[profile] Status updated for ${ownerCode}: "${status}"`);
  return res.json({ ok: true, ownerCode, status });
});

// ─────────────────────────────────────────────────────────────
// GET /profiles/:ownerCode
// Returns avatar + status for a user
// ─────────────────────────────────────────────────────────────
router.get("/:ownerCode", (req, res) => {
  const ownerCode = cleanCode(req.params.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });

  const profile = getProfile(ownerCode);
  return res.json(profile);
});

// ─────────────────────────────────────────────────────────────
// GET /profiles/batch?codes=AAA,BBB,CCC
// Fetch multiple profiles at once (for home feed)
// ─────────────────────────────────────────────────────────────
router.get("/batch", (req, res) => {
  const raw   = cleanStr(req.query.codes);
  if (!raw) return res.status(400).json({ error: "Missing codes" });

  const codes  = raw.split(",").map(cleanCode).filter(Boolean).slice(0, 50);
  const result = codes.map(c => getProfile(c));
  return res.json(result);
});

module.exports = { profilesRouter: router, profilesStore: profiles };
