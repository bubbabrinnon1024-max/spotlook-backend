console.log("SERVER STARTING...");
const express = require("express");
const cors = require("cors");
const { friendRequestsRouter } = require("./friendRequests");
const { musicMatchRouter } = require("./musicMatch");

// ─────────────────────────────────────────────────────────────
// SPOTIFY CREDENTIALS
// Set these as environment variables on your host (Railway / Render / etc)
//
//   SPOTIFY_CLIENT_ID     — from Spotify Developer Dashboard
//   SPOTIFY_CLIENT_SECRET — from Spotify Developer Dashboard
//
// In your Spotify app dashboard add this Redirect URI:
//   https://YOUR-SERVER-URL/auth/spotify/callback
//
// In your iOS SpotifyAuthManager, change the redirectURI to match.
// ─────────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || "3075a1f167c04eb7995e72ef633dbb7d";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "3a8cb77501214c3ca3f5b0c266ee2c50";
const SERVER_URL            = process.env.SERVER_URL            || "https://spotlook-backend.onrender.com";
const REDIRECT_URI          = `${SERVER_URL}/auth/spotify/callback`;

// How often (ms) the server polls Spotify for each connected user
const POLL_INTERVAL_MS = 10_000; // 10 seconds

const app = express();

// ─────────────────────────────────────────────────────────────
// IN-MEMORY STORES
// For production swap these Maps out for a real database (Postgres/Redis/etc)
// so data survives server restarts.
// ─────────────────────────────────────────────────────────────
const sessions = new Map(); // ownerCode → session object
const friends  = new Map(); // ownerCode → Set of friend codes

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function getFriendsFor(code) {
  const normalized = normalizeCode(code);
  if (!friends.has(normalized)) friends.set(normalized, new Set());
  return friends.get(normalized);
}

function addMutualFriendship(codeA, codeB) {
  const a = normalizeCode(codeA);
  const b = normalizeCode(codeB);
  if (!a || !b || a === b) return false;
  getFriendsFor(a).add(b);
  getFriendsFor(b).add(a);
  return true;
}

// ─────────────────────────────────────────────────────────────
// SPOTIFY TOKEN HELPERS
// ─────────────────────────────────────────────────────────────

// Exchange an authorization code for access + refresh tokens
async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    grant_type:   "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(
        `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
      ).toString("base64"),
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  return res.json(); // { access_token, refresh_token, expires_in }
}

// Use a stored refresh token to get a fresh access token
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(
        `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
      ).toString("base64"),
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  const data = await res.json();
  // Spotify sometimes issues a new refresh token — store it if so
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || refreshToken, // keep old one if not rotated
    expiresAt:    Date.now() + (data.expires_in - 60) * 1000, // 60s buffer
  };
}

// Get a valid access token for a session, refreshing if needed
async function getValidAccessToken(session) {
  if (!session.refreshToken) {
    throw new Error("No refresh token stored for this user");
  }

  // If access token is still valid, return it directly
  if (session.accessToken && session.tokenExpiresAt && Date.now() < session.tokenExpiresAt) {
    return session.accessToken;
  }

  // Access token expired — refresh it
  const tokens = await refreshAccessToken(session.refreshToken);
  session.accessToken     = tokens.accessToken;
  session.refreshToken    = tokens.refreshToken;
  session.tokenExpiresAt  = tokens.expiresAt;
  sessions.set(session.ownerCode, session);

  console.log(`[token] Refreshed access token for ${session.ownerCode}`);
  return session.accessToken;
}

// ─────────────────────────────────────────────────────────────
// SPOTIFY NOW PLAYING FETCHER
// Called by the background poller every 10 seconds
// ─────────────────────────────────────────────────────────────
async function fetchNowPlayingFromSpotify(session) {
  try {
    const accessToken = await getValidAccessToken(session);

    const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { "Authorization": `Bearer ${accessToken}` },
    });

    // 204 = nothing playing
    if (res.status === 204) {
      session.currentSong = session.currentSong
        ? { ...session.currentSong, isPlaying: false, updatedAt: new Date().toISOString() }
        : null;
      return;
    }

    if (!res.ok) {
      console.warn(`[poll] Spotify returned ${res.status} for ${session.ownerCode}`);
      return;
    }

    const data = await res.json();

    // Only handle tracks (not podcasts etc)
    if (!data || data.currently_playing_type !== "track" || !data.item) {
      session.currentSong = session.currentSong
        ? { ...session.currentSong, isPlaying: false, updatedAt: new Date().toISOString() }
        : null;
      return;
    }

    const track    = data.item;
    const artists  = track.artists.map(a => a.name).join(", ");
    const albumArt = track.album?.images?.[0]?.url ?? null;

    session.currentSong = {
      ownerCode:   session.ownerCode,
      songTitle:   track.name,
      artistNames: artists,
      albumName:   track.album?.name ?? "",
      albumArtURL: albumArt,
      isPlaying:   data.is_playing,
      progressMs:  data.progress_ms ?? 0,
      durationMs:  track.duration_ms ?? 1,
      spotifyUrl:  track.external_urls?.spotify ?? null,
      updatedAt:   new Date().toISOString(),
    };

    sessions.set(session.ownerCode, session);

  } catch (err) {
    console.error(`[poll] Error fetching for ${session.ownerCode}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// BACKGROUND POLLER
// Runs every 10 seconds, hits Spotify for every registered user
// ─────────────────────────────────────────────────────────────
function startPoller() {
  setInterval(async () => {
    const usersWithTokens = [...sessions.values()].filter(s => s.refreshToken);

    if (usersWithTokens.length === 0) return;

    console.log(`[poll] Checking ${usersWithTokens.length} user(s)...`);

    // Run all fetches in parallel so 10s is enough for large user counts
    await Promise.allSettled(
      usersWithTokens.map(session => fetchNowPlayingFromSpotify(session))
    );
  }, POLL_INTERVAL_MS);

  console.log(`[poll] Background poller started — every ${POLL_INTERVAL_MS / 1000}s`);
}

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.locals.sessionsStore = sessions;
app.locals.friendsStore  = friends;
app.use("/friend-request", friendRequestsRouter);
app.use("/music-match", musicMatchRouter);

// ─────────────────────────────────────────────────────────────
// ROUTE 1: Spotify OAuth — Step 1
// iOS app opens this URL in a browser/webview to start OAuth
// GET /auth/spotify/login?ownerCode=MYCODE
// ─────────────────────────────────────────────────────────────
app.get("/auth/spotify/login", (req, res) => {
  const ownerCode = normalizeCode(req.query.ownerCode);

  if (!ownerCode) {
    return res.status(400).send("Missing ownerCode");
  }

  const scopes = [
    "user-read-currently-playing",
    "user-read-playback-state",
  ].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    client_id:     SPOTIFY_CLIENT_ID,
    scope:         scopes,
    redirect_uri:  REDIRECT_URI,
    state:         ownerCode, // pass ownerCode through OAuth state param
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// ─────────────────────────────────────────────────────────────
// ROUTE 2: Spotify OAuth — Step 2 (Callback)
// Spotify redirects here after user approves
// GET /auth/spotify/callback?code=XXX&state=OWNERCODE
// ─────────────────────────────────────────────────────────────
app.get("/auth/spotify/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Spotify auth denied: ${error}`);
  }

  if (!code || !state) {
    return res.status(400).send("Missing code or state");
  }

  const ownerCode = normalizeCode(state);

  try {
    const tokens = await exchangeCodeForTokens(code);

    // Store or update session with tokens
    const existing = sessions.get(ownerCode) || {};
    sessions.set(ownerCode, {
      ...existing,
      ownerCode,
      accessToken:    tokens.access_token,
      refreshToken:   tokens.refresh_token,
      tokenExpiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
      currentSong:    existing.currentSong ?? null,
      connectedAt:    new Date().toISOString(),
    });

    getFriendsFor(ownerCode); // ensure friends entry exists

    // Do an immediate fetch so data is available right away
    await fetchNowPlayingFromSpotify(sessions.get(ownerCode));

    console.log(`[auth] ${ownerCode} connected Spotify successfully`);

    // Redirect to a success page or deep link back into the app
    // Change this URL to your app's custom scheme if you have one
    // e.g. spotpeek://auth-success
    res.send(`
      <html>
        <body style="background:#0d0d1a;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px">
          <svg width="60" height="60" viewBox="0 0 60 60">
            <circle cx="30" cy="30" r="30" fill="#a78bfa"/>
            <polyline points="16,30 26,40 44,20" stroke="white" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <h2 style="margin:0">Spotify Connected!</h2>
          <p style="margin:0;opacity:0.6">You can close this and go back to SpotPeek.</p>
        </body>
      </html>
    `);

  } catch (err) {
    console.error("[auth] OAuth callback error:", err.message);
    res.status(500).send(`Auth failed: ${err.message}`);
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 3: iOS app sends refresh token directly
// (alternative to browser OAuth — use this if you handle OAuth
//  entirely in the app and just need to hand off the refresh token)
// POST /auth/store-token
// Body: { ownerCode, refreshToken, accessToken, expiresIn }
// ─────────────────────────────────────────────────────────────
app.post("/auth/store-token", (req, res) => {
  const ownerCode     = normalizeCode(req.body.ownerCode);
  const refreshToken  = req.body.refreshToken;
  const accessToken   = req.body.accessToken;
  const expiresIn     = Number(req.body.expiresIn) || 3600;

  if (!ownerCode || !refreshToken) {
    return res.status(400).json({ error: "Missing ownerCode or refreshToken" });
  }

  const existing = sessions.get(ownerCode) || {};
  sessions.set(ownerCode, {
    ...existing,
    ownerCode,
    refreshToken,
    accessToken:    accessToken || existing.accessToken || null,
    tokenExpiresAt: accessToken ? Date.now() + (expiresIn - 60) * 1000 : 0,
    currentSong:    existing.currentSong ?? null,
    connectedAt:    new Date().toISOString(),
  });

  getFriendsFor(ownerCode);

  console.log(`[auth] Stored refresh token for ${ownerCode}`);

  // Kick off an immediate fetch
  fetchNowPlayingFromSpotify(sessions.get(ownerCode)).catch(() => {});

  res.json({ ok: true, ownerCode });
});

// ─────────────────────────────────────────────────────────────
// ROUTE 4: Disconnect Spotify (revoke stored tokens)
// POST /auth/disconnect
// Body: { ownerCode }
// ─────────────────────────────────────────────────────────────
app.post("/auth/disconnect", (req, res) => {
  const ownerCode = normalizeCode(req.body.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });

  const session = sessions.get(ownerCode);
  if (session) {
    session.refreshToken   = null;
    session.accessToken    = null;
    session.tokenExpiresAt = 0;
    sessions.set(ownerCode, session);
  }

  console.log(`[auth] Disconnected Spotify for ${ownerCode}`);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// EXISTING ROUTES (unchanged — app still works the old way too)
// ─────────────────────────────────────────────────────────────

app.post("/register-device", (req, res) => {
  const { ownerCode, spotifyAccessToken } = req.body;
  const cleanedOwnerCode = normalizeCode(ownerCode);

  if (!cleanedOwnerCode || !spotifyAccessToken) {
    return res.status(400).json({ error: "Missing ownerCode or spotifyAccessToken" });
  }

  const existing = sessions.get(cleanedOwnerCode);
  sessions.set(cleanedOwnerCode, {
    ownerCode:      cleanedOwnerCode,
    spotifyAccessToken,
    // preserve refresh token if already stored
    refreshToken:   existing?.refreshToken   ?? null,
    accessToken:    existing?.accessToken    ?? spotifyAccessToken,
    tokenExpiresAt: existing?.tokenExpiresAt ?? 0,
    currentSong:    existing?.currentSong    ?? null,
    connectedAt:    existing?.connectedAt    ?? new Date().toISOString(),
  });

  getFriendsFor(cleanedOwnerCode);
  res.json({ ok: true, ownerCode: cleanedOwnerCode });
});

app.post("/update-now-playing", (req, res) => {
  const {
    ownerCode, songTitle, artistNames, albumName,
    albumArtURL, isPlaying, progressMs, durationMs
  } = req.body;
  const cleanedOwnerCode = normalizeCode(ownerCode);

  if (!cleanedOwnerCode) {
    return res.status(400).json({ error: "Missing ownerCode" });
  }

  const session = sessions.get(cleanedOwnerCode);
  if (!session) {
    return res.status(404).json({ error: "Unknown ownerCode" });
  }

  // Only update from app if server isn't already polling this user directly
  // (server-side data is fresher so we don't want the app to overwrite it)
  if (!session.refreshToken) {
    session.currentSong = {
      ownerCode:   cleanedOwnerCode,
      songTitle:   songTitle   ?? "",
      artistNames: artistNames ?? "",
      albumName:   albumName   ?? "",
      albumArtURL: albumArtURL ?? null,
      isPlaying:   Boolean(isPlaying),
      progressMs:  Number.isFinite(progressMs) ? progressMs : 0,
      durationMs:  Number.isFinite(durationMs) ? durationMs : 1,
      updatedAt:   new Date().toISOString(),
    };
    sessions.set(cleanedOwnerCode, session);
  }

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

  // If server is polling, estimate current progress client-side using updatedAt
  res.json(session.currentSong);
});

app.post("/add-friend-mutual", (req, res) => {
  const ownerCode  = normalizeCode(req.body.ownerCode);
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
  res.json({ ownerCode, friends: Array.from(getFriendsFor(ownerCode)) });
});

// ─────────────────────────────────────────────────────────────
// STATUS MESSAGES — users can set a vibe/status others can see
// ─────────────────────────────────────────────────────────────

// POST /set-status  { ownerCode, status }
app.post("/set-status", (req, res) => {
  const code   = normalizeCode(req.body.ownerCode);
  const status = String(req.body.status || "").trim().slice(0, 80); // max 80 chars
  if (!code) return res.status(400).json({ error: "Missing ownerCode" });

  const session = sessions.get(code) || { ownerCode: code, currentSong: null };
  session.statusMessage = status;
  sessions.set(code, session);
  console.log(`[status] ${code} set status: "${status}"`);
  res.json({ ok: true, status });
});

// GET /user-status?code=XXX
app.get("/user-status", (req, res) => {
  const code = normalizeCode(req.query.code);
  if (!code) return res.status(400).json({ error: "Missing code" });
  const session = sessions.get(code);
  res.json({ code, status: session?.statusMessage ?? "" });
});

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK — shows how many users are server-polled vs app-only
// GET /health
// ─────────────────────────────────────────────────────────────
app.get("/health", (_, res) => {
  const allSessions   = [...sessions.values()];
  const polledUsers   = allSessions.filter(s => s.refreshToken).length;
  const appOnlyUsers  = allSessions.filter(s => !s.refreshToken).length;

  res.json({
    ok:           true,
    sessionCount: sessions.size,
    polledUsers,   // connected via server-side Spotify OAuth
    appOnlyUsers,  // old behaviour — app must be open
    friendCount:  [...friends.values()].reduce((t, s) => t + s.size, 0),
    pollIntervalMs: POLL_INTERVAL_MS,
  });
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  startPoller();
});
