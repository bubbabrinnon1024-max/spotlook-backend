const express = require("express");
const crypto  = require("crypto");

const router    = express.Router();
const reactions = new Map();

const cleanCode = (v) => String(v ?? "").trim().toUpperCase();
const cleanStr  = (v) => String(v ?? "").trim();
const now       = ()  => new Date().toISOString();

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

function clearReactionsIfSongChanged(ownerCode, currentSongKey) {
  if (!reactions.has(ownerCode)) return;
  const store = reactions.get(ownerCode);
  if (store.songKey !== currentSongKey) {
    reactions.set(ownerCode, { songKey: currentSongKey, list: [] });
  }
}

// POST /reactions/send
router.post("/send", (req, res) => {
  const toCode   = cleanCode(req.body?.toCode);
  const fromCode = cleanCode(req.body?.fromCode);
  const fromName = cleanStr(req.body?.fromName) || fromCode;
  const text     = cleanStr(req.body?.text).slice(0, 60);

  if (!toCode || !fromCode || !text) {
    return res.status(400).json({ error: "Missing toCode, fromCode, or text" });
  }

  const session    = req.app.locals.sessionsStore?.get(toCode);
  const currentKey = songKey(session);
  const store      = getStore(toCode);

  if (store.songKey !== currentKey) {
    store.songKey = currentKey;
    store.list    = [];
  }

  const reaction = { id: crypto.randomUUID(), fromCode, fromName, text, createdAt: now() };
  store.list.push(reaction);
  if (store.list.length > 100) store.list = store.list.slice(-100);

  console.log(`[reaction] ${fromCode} → ${toCode}: "${text}"`);
  return res.status(201).json(reaction);
});

// GET /reactions/for/:ownerCode
router.get("/for/:ownerCode", (req, res) => {
  const ownerCode  = cleanCode(req.params.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });

  const session    = req.app.locals.sessionsStore?.get(ownerCode);
  const currentKey = songKey(session);
  const store      = getStore(ownerCode);

  if (store.songKey !== currentKey) {
    store.songKey = currentKey;
    store.list    = [];
  }

  return res.json({ ownerCode, songKey: currentKey, reactions: store.list });
});

// DELETE /reactions/clear/:ownerCode
router.delete("/clear/:ownerCode", (req, res) => {
  const ownerCode = cleanCode(req.params.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  reactions.set(ownerCode, { songKey: null, list: [] });
  return res.json({ ok: true });
});

module.exports = { reactionsRouter: router, clearReactionsIfSongChanged };
