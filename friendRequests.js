
const express = require("express");
const crypto = require("crypto");

const router = express.Router();

const friendRequests = new Map();

router.post("/send", (req, res) => {
  const { fromCode, fromName, toCode } = req.body || {};

  if (!fromCode || !fromName || !toCode) {
    return res.status(400).json({ error: "Missing fromCode, fromName, or toCode" });
  }

  const cleanedFromCode = String(fromCode).trim();
  const cleanedFromName = String(fromName).trim();
  const cleanedToCode = String(toCode).trim();

  if (!cleanedFromCode || !cleanedFromName || !cleanedToCode) {
    return res.status(400).json({ error: "Request fields cannot be empty" });
  }

  if (cleanedFromCode === cleanedToCode) {
    return res.status(400).json({ error: "You cannot send a request to yourself" });
  }

  const existingPending = Array.from(friendRequests.values()).find(
    (request) =>
      request.fromCode === cleanedFromCode &&
      request.toCode === cleanedToCode &&
      request.status === "pending"
  );

  if (existingPending) {
    return res.status(409).json({ error: "A pending friend request already exists" });
  }

  const requestRecord = {
    id: crypto.randomUUID(),
    fromCode: cleanedFromCode,
    fromName: cleanedFromName,
    toCode: cleanedToCode,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  friendRequests.set(requestRecord.id, requestRecord);
  res.status(201).json(requestRecord);
});

router.get("/incoming", (req, res) => {
  const code = String(req.query.code || "").trim();

  if (!code) {
    return res.status(400).json({ error: "Missing code" });
  }

  const incoming = Array.from(friendRequests.values())
    .filter((request) => request.toCode === code)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(incoming);
});

router.get("/outgoing", (req, res) => {
  const code = String(req.query.code || "").trim();

  if (!code) {
    return res.status(400).json({ error: "Missing code" });
  }

  const outgoing = Array.from(friendRequests.values())
    .filter((request) => request.fromCode === code)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(outgoing);
});

router.post("/respond", (req, res) => {
  const { requestID, action } = req.body || {};

  if (!requestID || !action) {
    return res.status(400).json({ error: "Missing requestID or action" });
  }

  const requestRecord = friendRequests.get(String(requestID));
  if (!requestRecord) {
    return res.status(404).json({ error: "Friend request not found" });
  }

  const normalizedAction = String(action).trim().toLowerCase();
  if (normalizedAction !== "accepted" && normalizedAction !== "declined") {
    return res.status(400).json({ error: "Action must be accepted or declined" });
  }

  const updatedRecord = {
    ...requestRecord,
    status: normalizedAction
  };

  friendRequests.set(updatedRecord.id, updatedRecord);
  res.json(updatedRecord);
});

module.exports = {
  friendRequestsRouter: router,
  friendRequestsStore: friendRequests
};

