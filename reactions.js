const express = require("express");
const crypto  = require("crypto");

const router    = express.Router();
const reactions = new Map(); // ownerCode → { songKey, reactions: [] }

const cleanCode = (v) => String(v ?? "").trim().toUpperCase();
const cleanStr  = (v) => String(v ?? "").trim();
const now       = ()  => new Date().toISOString();

// Build a key for the current song so we can auto-clear when it changes
function songKey(session) {
  return session?.currentSong?.songTitle
    ? `${session.currentSong.songTitle}::${session.currentSong.artistNames}`
    : null;
}

function getStore(ownerCode) {
  if (!reactions.has(ownerCode)) {
    reactions.set(ownerCode, { songKey: null, list: [] });
  }
  return reactions.get(ownerCode);
}

// Called by the poller in server.js whenever the song changes
function clearReactionsIfSongChanged(ownerCode, currentSongKey) {
  if (!reactions.has(ownerCode)) return;
  const store = reactions.get(ownerCode);
  if (store.songKey !== currentSongKey) {
    reactions.set(ownerCode, { songKey: currentSongKey, list: [] });
  }
}

// ─────────────────────────────────────────────────────────────
// POST /reactions/send
// Body: { toCode, fromCode, fromName, text }
// ─────────────────────────────────────────────────────────────
router.post("/send", (req, res) => {
  const toCode   = cleanCode(req.body?.toCode);
  const fromCode = cleanCode(req.body?.fromCode);
  const fromName = cleanStr(req.body?.fromName) || fromCode;
  const text     = cleanStr(req.body?.text).slice(0, 60);

  if (!toCode || !fromCode || !text) {
    return res.status(400).json({ error: "Missing toCode, fromCode, or text" });
  }

  // Get current song key from session
  const session    = req.app.locals.sessionsStore?.get(toCode);
  const currentKey = songKey(session);

  const store = getStore(toCode);

  // Auto-clear if song changed
  if (store.songKey !== currentKey) {
    store.songKey = currentKey;
    store.list    = [];
  }

  const reaction = {
    id:        crypto.randomUUID(),
    fromCode,
    fromName,
    text,
    createdAt: now(),
  };

  store.list.push(reaction);

  // Keep max 100 reactions per song
  if (store.list.length > 100) store.list = store.list.slice(-100);

  console.log(`[reaction] ${fromCode} → ${toCode}: "${text}"`);
  return res.status(201).json(reaction);
});

// ─────────────────────────────────────────────────────────────
// GET /reactions/for/:ownerCode
// Returns all reactions for the current song
// ─────────────────────────────────────────────────────────────
router.get("/for/:ownerCode", (req, res) => {
  const ownerCode  = cleanCode(req.params.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });

  const session    = req.app.locals.sessionsStore?.get(ownerCode);
  const currentKey = songKey(session);
  const store      = getStore(ownerCode);

  // Auto-clear stale reactions
  if (store.songKey !== currentKey) {
    store.songKey = currentKey;
    store.list    = [];
  }

  return res.json({
    ownerCode,
    songKey:   currentKey,
    reactions: store.list,
  });
});

// ─────────────────────────────────────────────────────────────
// DELETE /reactions/clear/:ownerCode
// Manually clear reactions (e.g. called from iOS)
// ─────────────────────────────────────────────────────────────
router.delete("/clear/:ownerCode", (req, res) => {
  const ownerCode = cleanCode(req.params.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  reactions.set(ownerCode, { songKey: null, list: [] });
  return res.json({ ok: true });
});

module.exports = { reactionsRouter: router, clearReactionsIfSongChanged };
