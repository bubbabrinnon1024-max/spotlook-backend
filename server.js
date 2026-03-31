console.log("SERVER STARTING...");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const sessions = new Map();

app.post("/register-device", (req, res) => {
  const { ownerCode, spotifyAccessToken } = req.body;

  if (!ownerCode || !spotifyAccessToken) {
    return res.status(400).json({ error: "Missing ownerCode or spotifyAccessToken" });
  }

  sessions.set(ownerCode, {
    ownerCode,
    spotifyAccessToken,
    currentSong: null
  });

  res.json({ ok: true, ownerCode });
});

app.post("/update-now-playing", (req, res) => {
  const { ownerCode, songTitle, artistNames, albumName, albumArtURL, isPlaying } = req.body;

  if (!ownerCode) {
    return res.status(400).json({ error: "Missing ownerCode" });
  }

  const session = sessions.get(ownerCode);
  if (!session) {
    return res.status(404).json({ error: "Unknown ownerCode" });
  }

  session.currentSong = {
    ownerCode,
    songTitle: songTitle ?? "",
    artistNames: artistNames ?? "",
    albumName: albumName ?? "",
    albumArtURL: albumArtURL ?? null,
    isPlaying: Boolean(isPlaying),
    updatedAt: new Date().toISOString()
  };

  sessions.set(ownerCode, session);
  res.json({ ok: true });
});

app.get("/shared-now-playing", (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).json({ error: "Missing code" });
  }

  const session = sessions.get(code);
  if (!session || !session.currentSong) {
    return res.status(404).json({ error: "No shared song found" });
  }

  res.json(session.currentSong);
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
