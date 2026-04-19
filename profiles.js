\const express  = require("express");
const router   = express.Router();
const profiles = new Map();

const cleanCode = (v) => String(v ?? "").trim().toUpperCase();
const cleanStr  = (v) => String(v ?? "").trim();
const now       = ()  => new Date().toISOString();
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

function getProfile(ownerCode) {
  if (!profiles.has(ownerCode)) {
    profiles.set(ownerCode, { ownerCode, avatar: null, status: "", updatedAt: now() });
  }
  return profiles.get(ownerCode);
}

// POST /profiles/avatar
router.post("/avatar", (req, res) => {
  const ownerCode   = cleanCode(req.body?.ownerCode);
  const imageBase64 = cleanStr(req.body?.imageBase64);
  const mimeType    = cleanStr(req.body?.mimeType) || "image/jpeg";

  if (!ownerCode)   return res.status(400).json({ error: "Missing ownerCode" });
  if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });

  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowed.includes(mimeType)) return res.status(400).json({ error: "Unsupported image type" });
  if (imageBase64.length > MAX_AVATAR_BYTES) return res.status(413).json({ error: "Image too large (max 2MB)" });

  const profile     = getProfile(ownerCode);
  profile.avatar    = `data:${mimeType};base64,${imageBase64}`;
  profile.updatedAt = now();
  profiles.set(ownerCode, profile);
  console.log(`[profile] Avatar set for ${ownerCode}`);
  return res.json({ ok: true, ownerCode });
});

// DELETE /profiles/avatar  — proper clear endpoint, no empty-base64 hack
router.delete("/avatar", (req, res) => {
  const ownerCode = cleanCode(req.body?.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  const profile     = getProfile(ownerCode);
  profile.avatar    = null;
  profile.updatedAt = now();
  profiles.set(ownerCode, profile);
  console.log(`[profile] Avatar cleared for ${ownerCode}`);
  return res.json({ ok: true, ownerCode });
});

// POST /profiles/status  — single source of truth (server.js /set-status removed)
router.post("/status", (req, res) => {
  const ownerCode = cleanCode(req.body?.ownerCode);
  const status    = cleanStr(req.body?.status).slice(0, 60);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  const profile     = getProfile(ownerCode);
  profile.status    = status;
  profile.updatedAt = now();
  profiles.set(ownerCode, profile);
  console.log(`[profile] Status set for ${ownerCode}: "${status}"`);
  return res.json({ ok: true, ownerCode, status });
});

// GET /profiles/batch?codes=AAA,BBB  — MUST be above /:ownerCode
router.get("/batch", (req, res) => {
  const raw = cleanStr(req.query.codes);
  if (!raw) return res.status(400).json({ error: "Missing codes" });
  const codes = raw.split(",").map(cleanCode).filter(Boolean).slice(0, 50);
  return res.json(codes.map(getProfile));
});

// GET /profiles/:ownerCode  — MUST be below /batch
router.get("/:ownerCode", (req, res) => {
  const ownerCode = cleanCode(req.params.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  return res.json(getProfile(ownerCode));
});

module.exports = { profilesRouter: router, profilesStore: profiles };
