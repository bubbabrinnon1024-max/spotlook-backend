const express = require("express");
const crypto  = require("crypto");

const router         = express.Router();
const friendRequests = new Map();

// ─────────────────────────────────────────────────────────────
// HELPER — normalise a user code consistently
// ─────────────────────────────────────────────────────────────
function clean(value) {
  return String(value || "").trim().toUpperCase();
}

// ─────────────────────────────────────────────────────────────
// HELPER — get the shared friends store from server.js
// (app.locals.friendsStore is set in server.js)
// ─────────────────────────────────────────────────────────────
function getFriendsStore(req) {
  return req.app.locals.friendsStore;
}

function getFriendsFor(store, code) {
  if (!store.has(code)) store.set(code, new Set());
  return store.get(code);
}

// Add both people to each other's friends list
function addMutual(store, codeA, codeB) {
  getFriendsFor(store, codeA).add(codeB);
  getFriendsFor(store, codeB).add(codeA);
}

// ─────────────────────────────────────────────────────────────
// POST /friend-request/send
// Person A sends a request to Person B.
// Person B gets an incoming request — no action needed from A after this.
// ─────────────────────────────────────────────────────────────
router.post("/send", (req, res) => {
  const fromCode = clean(req.body?.fromCode);
  const fromName = String(req.body?.fromName || "").trim();
  const toCode   = clean(req.body?.toCode);

  if (!fromCode || !fromName || !toCode) {
    return res.status(400).json({ error: "Missing fromCode, fromName, or toCode" });
  }

  if (fromCode === toCode) {
    return res.status(400).json({ error: "You cannot send a request to yourself" });
  }

  // Block if a pending request already exists in either direction
  const duplicate = Array.from(friendRequests.values()).find(r =>
    r.status === "pending" && (
      (r.fromCode === fromCode && r.toCode === toCode) ||
      (r.fromCode === toCode   && r.toCode === fromCode)
    )
  );

  if (duplicate) {
    return res.status(409).json({ error: "A pending request already exists between these two users" });
  }

  // Block if they are already friends
  const store = getFriendsStore(req);
  if (store && getFriendsFor(store, fromCode).has(toCode)) {
    return res.status(409).json({ error: "You are already friends" });
  }

  const record = {
    id:        crypto.randomUUID(),
    fromCode,
    fromName,
    toCode,
    toName:    "",          // filled in when the recipient loads their requests
    status:    "pending",
    createdAt: new Date().toISOString(),
  };

  friendRequests.set(record.id, record);
  console.log(`[friend-request] ${fromCode} → ${toCode} (${record.id})`);
  res.status(201).json(record);
});

// ─────────────────────────────────────────────────────────────
// GET /friend-request/incoming?code=XXX
// ─────────────────────────────────────────────────────────────
router.get("/incoming", (req, res) => {
  const code = clean(req.query.code);
  if (!code) return res.status(400).json({ error: "Missing code" });

  const incoming = Array.from(friendRequests.values())
    .filter(r => r.toCode === code)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(incoming);
});

// ─────────────────────────────────────────────────────────────
// GET /friend-request/outgoing?code=XXX
// ─────────────────────────────────────────────────────────────
router.get("/outgoing", (req, res) => {
  const code = clean(req.query.code);
  if (!code) return res.status(400).json({ error: "Missing code" });

  const outgoing = Array.from(friendRequests.values())
    .filter(r => r.fromCode === code)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(outgoing);
});

// ─────────────────────────────────────────────────────────────
// POST /friend-request/respond
// THE KEY FIX: when action = "accepted", both users are
// automatically added as mutual friends right here.
// Person A never has to do anything — accepting does it all.
// ─────────────────────────────────────────────────────────────
router.post("/respond", (req, res) => {
  const requestID = String(req.body?.requestID || "").trim();
  const action    = String(req.body?.action    || "").trim().toLowerCase();

  if (!requestID || !action) {
    return res.status(400).json({ error: "Missing requestID or action" });
  }

  if (action !== "accepted" && action !== "declined") {
    return res.status(400).json({ error: "Action must be accepted or declined" });
  }

  const record = friendRequests.get(requestID);
  if (!record) {
    return res.status(404).json({ error: "Friend request not found" });
  }

  if (record.status !== "pending") {
    return res.status(409).json({ error: `Request already ${record.status}` });
  }

  // Update status
  const updated = { ...record, status: action, respondedAt: new Date().toISOString() };
  friendRequests.set(updated.id, updated);

  // ── THE FIX ──────────────────────────────────────────────
  // If accepted, immediately add both people as mutual friends.
  // No second step needed from either side.
  if (action === "accepted") {
    const store = getFriendsStore(req);
    if (store) {
      addMutual(store, record.fromCode, record.toCode);
      console.log(`[friend-request] ACCEPTED — mutual friendship added: ${record.fromCode} ↔ ${record.toCode}`);
    }

    // Also mark any reverse pending request as accepted automatically
    // so if both somehow sent requests to each other, neither is left dangling
    const reverse = Array.from(friendRequests.values()).find(r =>
      r.status   === "pending"  &&
      r.fromCode === record.toCode &&
      r.toCode   === record.fromCode
    );
    if (reverse) {
      friendRequests.set(reverse.id, {
        ...reverse,
        status:      "accepted",
        respondedAt: new Date().toISOString(),
      });
    }
  }

  res.json(updated);
});

// ─────────────────────────────────────────────────────────────
// POST /friend-request/decline  (convenience alias)
// ─────────────────────────────────────────────────────────────
router.post("/decline", (req, res) => {
  const requestID = String(req.body?.requestID || "").trim();
  if (!requestID) return res.status(400).json({ error: "Missing requestID" });

  const record = friendRequests.get(requestID);
  if (!record) return res.status(404).json({ error: "Friend request not found" });

  const updated = { ...record, status: "declined", respondedAt: new Date().toISOString() };
  friendRequests.set(updated.id, updated);

  console.log(`[friend-request] DECLINED — ${record.fromCode} → ${record.toCode}`);
  res.json(updated);
});

// ─────────────────────────────────────────────────────────────
// GET /friend-request/friends?ownerCode=XXX
// Returns confirmed mutual friends for a user
// ─────────────────────────────────────────────────────────────
router.get("/friends", (req, res) => {
  const code = clean(req.query.ownerCode);
  if (!code) return res.status(400).json({ error: "Missing ownerCode" });

  const store = getFriendsStore(req);
  const friendSet = store ? getFriendsFor(store, code) : new Set();

  res.json({ ownerCode: code, friends: Array.from(friendSet) });
});

module.exports = {
  friendRequestsRouter: router,
  friendRequestsStore:  friendRequests,
};
