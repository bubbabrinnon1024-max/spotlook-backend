const express = require("express");
const crypto  = require("crypto");

const router = express.Router();

// In-memory store for pending/resolved friend requests
const friendRequests = new Map();

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const cleanCode = (value) => String(value ?? "").trim().toUpperCase();
const cleanStr  = (value) => String(value ?? "").trim();
const now       = ()      => new Date().toISOString();

function getFriendsStore(req) {
  return req.app.locals.friendsStore ?? null;
}

function getFriendsFor(store, code) {
  if (!store.has(code)) store.set(code, new Set());
  return store.get(code);
}

function addMutualFriends(store, codeA, codeB) {
  getFriendsFor(store, codeA).add(codeB);
  getFriendsFor(store, codeB).add(codeA);
}

function hasPendingRequest(fromCode, toCode) {
  return Array.from(friendRequests.values()).some(
    (r) =>
      r.status === "pending" &&
      ((r.fromCode === fromCode && r.toCode === toCode) ||
       (r.fromCode === toCode   && r.toCode === fromCode))
  );
}

function areAlreadyFriends(store, codeA, codeB) {
  if (!store) return false;
  return getFriendsFor(store, codeA).has(codeB);
}

function resolveReverseRequest(fromCode, toCode) {
  const reverse = Array.from(friendRequests.values()).find(
    (r) =>
      r.status   === "pending" &&
      r.fromCode === toCode    &&
      r.toCode   === fromCode
  );
  if (reverse) {
    friendRequests.set(reverse.id, {
      ...reverse,
      status:      "accepted",
      respondedAt: now(),
    });
  }
}

// ─────────────────────────────────────────────────────────────
// POST /friend-request/send
// ─────────────────────────────────────────────────────────────
router.post("/send", (req, res) => {
  const fromCode = cleanCode(req.body?.fromCode);
  const fromName = cleanStr(req.body?.fromName);
  const toCode   = cleanCode(req.body?.toCode);

  if (!fromCode || !fromName || !toCode) {
    return res.status(400).json({ error: "Missing fromCode, fromName, or toCode" });
  }

  if (fromCode === toCode) {
    return res.status(400).json({ error: "You cannot send a request to yourself" });
  }

  if (hasPendingRequest(fromCode, toCode)) {
    return res.status(409).json({ error: "A pending request already exists between these two users" });
  }

  const store = getFriendsStore(req);
  if (areAlreadyFriends(store, fromCode, toCode)) {
    return res.status(409).json({ error: "You are already friends" });
  }

  const record = {
    id:        crypto.randomUUID(),
    fromCode,
    fromName,
    toCode,
    toName:    "",
    status:    "pending",
    createdAt: now(),
  };

  friendRequests.set(record.id, record);
  console.log(`[friend-request] SENT   ${fromCode} → ${toCode} (${record.id})`);
  return res.status(201).json(record);
});

// ─────────────────────────────────────────────────────────────
// GET /friend-request/incoming?code=XXX
// ─────────────────────────────────────────────────────────────
router.get("/incoming", (req, res) => {
  const code = cleanCode(req.query.code);
  if (!code) return res.status(400).json({ error: "Missing code" });

  const incoming = Array.from(friendRequests.values())
    .filter((r) => r.toCode === code)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return res.json(incoming);
});

// ─────────────────────────────────────────────────────────────
// GET /friend-request/outgoing?code=XXX
// ─────────────────────────────────────────────────────────────
router.get("/outgoing", (req, res) => {
  const code = cleanCode(req.query.code);
  if (!code) return res.status(400).json({ error: "Missing code" });

  const outgoing = Array.from(friendRequests.values())
    .filter((r) => r.fromCode === code)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return res.json(outgoing);
});

// ─────────────────────────────────────────────────────────────
// POST /friend-request/respond
// action: "accepted" | "declined"
// ─────────────────────────────────────────────────────────────
router.post("/respond", (req, res) => {
  const requestID = cleanStr(req.body?.requestID);
  const action    = cleanStr(req.body?.action).toLowerCase();

  if (!requestID || !action) {
    return res.status(400).json({ error: "Missing requestID or action" });
  }

  if (action !== "accepted" && action !== "declined") {
    return res.status(400).json({ error: "Action must be 'accepted' or 'declined'" });
  }

  const record = friendRequests.get(requestID);
  if (!record) {
    return res.status(404).json({ error: "Friend request not found" });
  }

  if (record.status !== "pending") {
    return res.status(409).json({ error: `Request already ${record.status}` });
  }

  const updated = { ...record, status: action, respondedAt: now() };
  friendRequests.set(updated.id, updated);

  if (action === "accepted") {
    const store = getFriendsStore(req);
    if (store) {
      addMutualFriends(store, record.fromCode, record.toCode);
      console.log(`[friend-request] ACCEPTED ${record.fromCode} ↔ ${record.toCode}`);
    }
    // Auto-resolve any mirrored pending request
    resolveReverseRequest(record.fromCode, record.toCode);
  } else {
    console.log(`[friend-request] DECLINED ${record.fromCode} → ${record.toCode}`);
  }

  return res.json(updated);
});

// ─────────────────────────────────────────────────────────────
// POST /friend-request/decline  (convenience alias for /respond)
// ─────────────────────────────────────────────────────────────
router.post("/decline", (req, res) => {
  const requestID = cleanStr(req.body?.requestID);
  if (!requestID) return res.status(400).json({ error: "Missing requestID" });

  const record = friendRequests.get(requestID);
  if (!record) return res.status(404).json({ error: "Friend request not found" });

  if (record.status !== "pending") {
    return res.status(409).json({ error: `Request already ${record.status}` });
  }

  const updated = { ...record, status: "declined", respondedAt: now() };
  friendRequests.set(updated.id, updated);

  console.log(`[friend-request] DECLINED ${record.fromCode} → ${record.toCode}`);
  return res.json(updated);
});

// ─────────────────────────────────────────────────────────────
// GET /friend-request/friends?ownerCode=XXX
// ─────────────────────────────────────────────────────────────
router.get("/friends", (req, res) => {
  const code = cleanCode(req.query.ownerCode);
  if (!code) return res.status(400).json({ error: "Missing ownerCode" });

  const store     = getFriendsStore(req);
  const friendSet = store ? getFriendsFor(store, code) : new Set();

  return res.json({ ownerCode: code, friends: Array.from(friendSet) });
});

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────
module.exports = {
  friendRequestsRouter: router,
  friendRequestsStore:  friendRequests,
};
