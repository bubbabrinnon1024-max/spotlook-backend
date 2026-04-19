const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const reactions = new Map();

function clearReactionsIfSongChanged(code, key) {
  var s = reactions.get(code);
  if (s && s.songKey !== key) reactions.set(code, { songKey: key, list: [] });
}

router.post("/send", function(req, res) {
  var to = String((req.body && req.body.toCode) || "").trim().toUpperCase();
  var from = String((req.body && req.body.fromCode) || "").trim().toUpperCase();
  var name = String((req.body && req.body.fromName) || from).trim();
  var text = String((req.body && req.body.text) || "").trim().slice(0, 60);
  if (!to || !from || !text) return res.status(400).json({ error: "Missing fields" });
  if (!reactions.has(to)) reactions.set(to, { songKey: null, list: [] });
  var store = reactions.get(to);
  var rx = { id: crypto.randomUUID(), fromCode: from, fromName: name, text: text, createdAt: new Date().toISOString() };
  store.list.push(rx);
  if (store.list.length > 100) store.list = store.list.slice(-100);
  return res.status(201).json(rx);
});

router.get("/for/:ownerCode", function(req, res) {
  var code = String(req.params.ownerCode || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Missing ownerCode" });
  if (!reactions.has(code)) reactions.set(code, { songKey: null, list: [] });
  var store = reactions.get(code);
  return res.json({ ownerCode: code, reactions: store.list });
});

router.delete("/clear/:ownerCode", function(req, res) {
  var code = String(req.params.ownerCode || "").trim().toUpperCase();
  reactions.set(code, { songKey: null, list: [] });
  return res.json({ ok: true });
});

module.exports = { reactionsRouter: router, clearReactionsIfSongChanged: clearReactionsIfSongChanged };
