console.log("SERVER STARTING...");
const express = require("express");
const cors = require("cors");
const { friendRequestsRouter } = require("./friendRequests");
const { musicMatchRouter } = require("./musicMatch");

const app = express();
const sessions = new Map();
const friends = new Map();

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function getFriendsFor(code) {
  const normalized = normalizeCode(code);
  if (!friends.has(normalized)) {
    friends.set(normalized, new Set());
  }
  return friends.get(normalized);
}

function addMutualFriendship(codeA, codeB) {
  const a = normalizeCode(codeA);
  const b = normalizeCode(codeB);

  if (!a || !b || a === b) {
    return false;
  }

  getFriendsFor(a).add(b);
  getFriendsFor(b).add(a);
  return true;
}

function areFriends(codeA, codeB) {
  const a = normalizeCode(codeA);
  const b = normalizeCode(codeB);

  if (!a || !b) {
    return false;
  }

  return getFriendsFor(a).has(b);
}

app.use(cors());
app.use(express.json());
app.locals.sessionsStore = sessions;
app.locals.friendsStore = friends;
app.use("/friend-request", friendRequestsRouter);
app.use("/music-match", musicMatchRouter);

app.post("/register-device", (req, res) => {
  const { ownerCode, spotifyAccessToken } = req.body;
  const cleanedOwnerCode = normalizeCode(ownerCode);

  if (!cleanedOwnerCode || !spotifyAccessToken) {
    return res.status(400).json({ error: "Missing ownerCode or spotifyAccessToken" });
  }

  const existingSession = sessions.get(cleanedOwnerCode);

  sessions.set(cleanedOwnerCode, {
    ownerCode: cleanedOwnerCode,
    spotifyAccessToken,
    currentSong: existingSession?.currentSong ?? null
  });

  getFriendsFor(cleanedOwnerCode);

  res.json({ ok: true, ownerCode: cleanedOwnerCode });
});

app.post("/update-now-playing", (req, res) => {
  const { ownerCode, songTitle, artistNames, albumName, albumArtURL, isPlaying, progressMs, durationMs } = req.body;
  const cleanedOwnerCode = normalizeCode(ownerCode);

  if (!cleanedOwnerCode) {
    return res.status(400).json({ error: "Missing ownerCode" });
  }

  const session = sessions.get(cleanedOwnerCode);
  if (!session) {
    return res.status(404).json({ error: "Unknown ownerCode" });
  }

  session.currentSong = {
    ownerCode: cleanedOwnerCode,
    songTitle: songTitle ?? "",
    artistNames: artistNames ?? "",
    albumName: albumName ?? "",
    albumArtURL: albumArtURL ?? null,
    isPlaying: Boolean(isPlaying),
    progressMs: Number.isFinite(progressMs) ? progressMs : 0,
    durationMs: Number.isFinite(durationMs) ? durationMs : 1,
    updatedAt: new Date().toISOString()
  };

  sessions.set(cleanedOwnerCode, session);
  res.json({ ok: true });
});

app.get("/shared-now-playing", (req, res) => {
  const code = normalizeCode(req.query.code);

  if (!code) {
    return res.status(400).json({ error: "Missing code" });
  }

  const session = sessions.get(code);
  if (!session || !session.currentSong) {
    return res.status(404).json({ error: "No shared song found" });
  }

  res.json(session.currentSong);
});

app.post("/add-friend-mutual", (req, res) => {
  const ownerCode = normalizeCode(req.body.ownerCode);
  const friendCode = normalizeCode(req.body.friendCode);

  if (!ownerCode || !friendCode) {
    return res.status(400).json({ error: "Missing ownerCode or friendCode" });
  }

  if (ownerCode === friendCode) {
    return res.status(400).json({ error: "You cannot add yourself" });
  }

  addMutualFriendship(ownerCode, friendCode);
  res.json({ ok: true, ownerCode, friendCode });
});

app.get("/friends", (req, res) => {
  const ownerCode = normalizeCode(req.query.ownerCode);

  if (!ownerCode) {
    return res.status(400).json({ error: "Missing ownerCode" });
  }

  res.json({
    ownerCode,
    friends: Array.from(getFriendsFor(ownerCode))
  });
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    sessionCount: sessions.size,
    friendCount: Array.from(friends.values()).reduce((total, set) => total + set.size, 0)
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
