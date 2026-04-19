const express = require("express");
const crypto  = require("crypto");

const router    = express.Router();
const reactions = new Map();

const cleanCode = (v) => String(v == null ? "" : v).trim().toUpperCase();
const cleanStr  = (v) => String(v == null ? "" : v).trim();
const now       = ()  => new Date().toISOString();

function songKey(session) {
  if (!session || !session.currentSong || !session.currentSong.songTitle) return null;
  return session.currentSong.songTitle + "::" + session.currentSong.artistNames;
}

function getStore(ownerCode) {
  if (!reactions.has(ownerCode)) {
    reactions.set(ownerCode, { songKey: null, list: [] });
  }
  return reactions.get(ownerCode);
}

function clearReactionsIfSongChanged(ownerCode, currentSongKey) {
  if (!reactions.has(ownerCode)) return;
  var store = reactions.get(ownerCode);
  if (store.songKey !== currentSongKey) {
    reactions.set(ownerCode, { songKey: currentSongKey, list: [] });
  }
}

// POST /reactions/send
router.post("/send", function(req, res) {
  var toCode   = cleanCode(req.body && req.body.toCode);
  var fromCode = cleanCode(req.body && req.body.fromCode);
  var fromName = cleanStr(req.body && req.body.fromName) || fromCode;
  var text     = cleanStr(req.body && req.body.text).slice(0, 60);

  if (!toCode || !fromCode || !text) {
    return res.status(400).json({ error: "Missing toCode, fromCode, or text" });
  }

  var session    = req.app.locals.sessionsStore && req.app.locals.sessionsStore.get(toCode);
  var currentKey = songKey(session);
  var store      = getStore(toCode);

  if (store.songKey !== currentKey) {
    store.songKey = currentKey;
    store.list    = [];
  }

  var reaction = {
    id:        crypto.randomUUID(),
    fromCode:  fromCode,
    fromName:  fromName,
    text:      text,
    createdAt: now()
  };
  store.list.push(reaction);
  if (store.list.length > 100) store.list = store.list.slice(-100);

  console.log("[reaction] " + fromCode + " -> " + toCode + ": " + text);
  return res.status(201).json(reaction);
});

// GET /reactions/for/:ownerCode
router.get("/for/:ownerCode", function(req, res) {
  var ownerCode  = cleanCode(req.params.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });

  var session    = req.app.locals.sessionsStore && req.app.locals.sessionsStore.get(ownerCode);
  var currentKey = songKey(session);
  var store      = getStore(ownerCode);

  if (store.songKey !== currentKey) {
    store.songKey = currentKey;
    store.list    = [];
  }

  return res.json({ ownerCode: ownerCode, songKey: currentKey, reactions: store.list });
});

// DELETE /reactions/clear/:ownerCode
router.delete("/clear/:ownerCode", function(req, res) {
  var ownerCode = cleanCode(req.params.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  reactions.set(ownerCode, { songKey: null, list: [] });
  return res.json({ ok: true });
});

module.exports = { reactionsRouter: router, clearReactionsIfSongChanged: clearReactionsIfSongChanged };
