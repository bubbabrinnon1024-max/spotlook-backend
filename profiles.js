const express = require("express");
const router = express.Router();
const profiles = new Map();
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

function cleanCode(v) { return String(v == null ? "" : v).trim().toUpperCase(); }
function cleanStr(v) { return String(v == null ? "" : v).trim(); }
function now() { return new Date().toISOString(); }

function getProfile(ownerCode) {
  if (!profiles.has(ownerCode)) {
    profiles.set(ownerCode, { ownerCode: ownerCode, avatar: null, status: "", updatedAt: now() });
  }
  return profiles.get(ownerCode);
}

router.post("/avatar", function(req, res) {
  var ownerCode = cleanCode(req.body && req.body.ownerCode);
  var imageBase64 = cleanStr(req.body && req.body.imageBase64);
  var mimeType = cleanStr(req.body && req.body.mimeType) || "image/jpeg";
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });
  var allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (allowed.indexOf(mimeType) === -1) return res.status(400).json({ error: "Unsupported image type" });
  if (imageBase64.length > MAX_AVATAR_BYTES) return res.status(413).json({ error: "Image too large" });
  var profile = getProfile(ownerCode);
  profile.avatar = "data:" + mimeType + ";base64," + imageBase64;
  profile.updatedAt = now();
  profiles.set(ownerCode, profile);
  return res.json({ ok: true, ownerCode: ownerCode });
});

router.delete("/avatar", function(req, res) {
  var ownerCode = cleanCode(req.body && req.body.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  var profile = getProfile(ownerCode);
  profile.avatar = null;
  profile.updatedAt = now();
  profiles.set(ownerCode, profile);
  return res.json({ ok: true, ownerCode: ownerCode });
});

router.post("/status", function(req, res) {
  var ownerCode = cleanCode(req.body && req.body.ownerCode);
  var status = cleanStr(req.body && req.body.status).slice(0, 60);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  var profile = getProfile(ownerCode);
  profile.status = status;
  profile.updatedAt = now();
  profiles.set(ownerCode, profile);
  return res.json({ ok: true, ownerCode: ownerCode, status: status });
});

router.get("/batch", function(req, res) {
  var raw = cleanStr(req.query.codes);
  if (!raw) return res.status(400).json({ error: "Missing codes" });
  var codes = raw.split(",").map(cleanCode).filter(Boolean).slice(0, 50);
  return res.json(codes.map(getProfile));
});

router.get("/:ownerCode", function(req, res) {
  var ownerCode = cleanCode(req.params.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  return res.json(getProfile(ownerCode));
});

module.exports = { profilesRouter: router, profilesStore: profiles };
