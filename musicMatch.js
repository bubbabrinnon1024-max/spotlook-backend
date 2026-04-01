const express = require("express");

const router = express.Router();

function normalizeSong(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

router.get("/", (req, res) => {
  const code = String(req.query.code || "").trim();
  const friendCode = String(req.query.friendCode || "").trim();

  if (!code || !friendCode) {
    return res.status(400).json({ error: "Missing code or friendCode" });
  }

  const sessionsStore = req.app.locals.sessionsStore;
  if (!sessionsStore || typeof sessionsStore.get !== "function") {
    return res.status(500).json({ error: "Sessions store is unavailable" });
  }

  const mySession = sessionsStore.get(code);
  const friendSession = sessionsStore.get(friendCode);

  const mySong = mySession?.currentSong || null;
  const friendSong = friendSession?.currentSong || null;

  const myArtists = uniqueStrings(
    String(mySong?.artistNames || "")
      .split(",")
      .map((artist) => artist.trim())
      .filter(Boolean)
  );

  const friendArtists = uniqueStrings(
    String(friendSong?.artistNames || "")
      .split(",")
      .map((artist) => artist.trim())
      .filter(Boolean)
  );

  const sharedArtists = myArtists.filter((artist) =>
    friendArtists.some((friendArtist) => friendArtist.toLowerCase() === artist.toLowerCase())
  );

  const mySongTitle = normalizeSong(mySong?.songTitle);
  const friendSongTitle = normalizeSong(friendSong?.songTitle);

  const sharedSongs = [];
  if (mySongTitle && friendSongTitle && mySongTitle === friendSongTitle) {
    sharedSongs.push(mySong.songTitle);
  }

  let score = 0;
  if (sharedSongs.length > 0) {
    score += 60;
  }
  score += Math.min(sharedArtists.length * 20, 40);
  score = Math.max(0, Math.min(score, 100));

  let summary = "No overlap yet. Play more music to build your match.";
  if (score >= 80) {
    summary = "You two are basically synced right now.";
  } else if (score >= 50) {
    summary = "Pretty solid music taste match.";
  } else if (score > 0) {
    summary = "You have a little music overlap already.";
  }

  res.json({
    code,
    friendCode,
    score,
    sharedArtists,
    sharedSongs,
    summary
  });
});

module.exports = {
  musicMatchRouter: router
};
