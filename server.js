console.log("SERVER STARTING...");

const express = require("express");
const cors    = require("cors");
const path    = require("path");

const { friendRequestsRouter }          = require("./friendRequests");
const { musicMatchRouter }              = require("./musicMatch");
const { reactionsRouter, clearReactionsIfSongChanged } = require("./reactions");
const { profilesRouter, profilesStore } = require("./profiles");

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || "3075a1f167c04eb7995e72ef633dbb7d";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "3a8cb77501214c3ca3f5b0c266ee2c50";
const SERVER_URL            = process.env.SERVER_URL            || "https://spotlook-backend.onrender.com";
const REDIRECT_URI          = `${SERVER_URL}/auth/spotify/callback`;
const POLL_INTERVAL_MS      = 10_000;
const PORT                  = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// IN-MEMORY STORES
// ─────────────────────────────────────────────────────────────
const sessions = new Map();
const friends  = new Map();

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const normalizeCode = (v) => String(v ?? "").trim().toUpperCase();
const now           = ()  => new Date().toISOString();

function getFriendsFor(code) {
  const c = normalizeCode(code);
  if (!friends.has(c)) friends.set(c, new Set());
  return friends.get(c);
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
function spotifyAuthHeader() {
  return "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
}

async function exchangeCodeForTokens(code) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": spotifyAuthHeader() },
    body:    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": spotifyAuthHeader() },
    body:    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json();
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt:    Date.now() + (data.expires_in - 60) * 1000,
  };
}

async function getValidAccessToken(session) {
  if (!session.refreshToken) throw new Error("No refresh token for this user");
  if (session.accessToken && session.tokenExpiresAt && Date.now() < session.tokenExpiresAt) {
    return session.accessToken;
  }
  const tokens = await refreshAccessToken(session.refreshToken);
  Object.assign(session, {
    accessToken:    tokens.accessToken,
    refreshToken:   tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
  });
  sessions.set(session.ownerCode, session);
  console.log(`[token] Refreshed for ${session.ownerCode}`);
  return session.accessToken;
}

// ─────────────────────────────────────────────────────────────
// SPOTIFY NOW PLAYING FETCHER
// ─────────────────────────────────────────────────────────────
async function fetchNowPlayingFromSpotify(session) {
  try {
    const accessToken = await getValidAccessToken(session);
    const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 204) {
      if (session.currentSong) session.currentSong = { ...session.currentSong, isPlaying: false, updatedAt: now() };
      return;
    }
    if (!res.ok) {
      console.warn(`[poll] Spotify ${res.status} for ${session.ownerCode}`);
      return;
    }

    const data = await res.json();
    if (!data || data.currently_playing_type !== "track" || !data.item) {
      if (session.currentSong) session.currentSong = { ...session.currentSong, isPlaying: false, updatedAt: now() };
      return;
    }

    const track       = data.item;
    const newSongKey  = `${track.name}::${track.artists.map(a => a.name).join(", ")}`;
    const oldSongKey  = session.currentSong
      ? `${session.currentSong.songTitle}::${session.currentSong.artistNames}`
      : null;

    // Auto-clear reactions when song changes
    if (newSongKey !== oldSongKey) {
      clearReactionsIfSongChanged(session.ownerCode, newSongKey);
    }

    session.currentSong = {
      ownerCode:   session.ownerCode,
      songTitle:   track.name,
      artistNames: track.artists.map(a => a.name).join(", "),
      albumName:   track.album?.name ?? "",
      albumArtURL: track.album?.images?.[0]?.url ?? null,
      isPlaying:   data.is_playing,
      progressMs:  data.progress_ms ?? 0,
      durationMs:  track.duration_ms ?? 1,
      spotifyUrl:  track.external_urls?.spotify ?? null,
      updatedAt:   now(),
    };
    sessions.set(session.ownerCode, session);

  } catch (err) {
    console.error(`[poll] Error for ${session.ownerCode}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// BACKGROUND POLLER
// ─────────────────────────────────────────────────────────────
function startPoller() {
  setInterval(async () => {
    const active = [...sessions.values()].filter(s => s.refreshToken);
    if (!active.length) return;
    console.log(`[poll] Checking ${active.length} user(s)...`);
    await Promise.allSettled(active.map(fetchNowPlayingFromSpotify));
  }, POLL_INTERVAL_MS);
  console.log(`[poll] Poller started — every ${POLL_INTERVAL_MS / 1000}s`);
}

// ─────────────────────────────────────────────────────────────
// APP SETUP
// ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" })); // increased for base64 avatars
app.locals.sessionsStore = sessions;
app.locals.friendsStore  = friends;
app.locals.profilesStore = profilesStore;

app.use("/friend-request", friendRequestsRouter);
app.use("/music-match",    musicMatchRouter);
app.use("/reactions",      reactionsRouter);
app.use("/profiles",       profilesRouter);

// ─────────────────────────────────────────────────────────────
// UI PAGES — served as HTML, opened in iOS WebView
// ─────────────────────────────────────────────────────────────

// Reactions bubble UI — open this in a WebView overlay
// GET /ui/reactions?ownerCode=XXX&viewerCode=YYY&viewerName=ZZZ
app.get("/ui/reactions", (req, res) => {
  const ownerCode  = req.query.ownerCode  || "";
  const viewerCode = req.query.viewerCode || "";
  const viewerName = req.query.viewerName || viewerCode;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
  <title>Reactions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

    body {
      background: transparent;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif;
      overflow: hidden;
      height: 100vh;
      width: 100vw;
      position: relative;
    }

    /* Floating bubble area */
    #bubble-field {
      position: absolute;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
    }

    .bubble {
      position: absolute;
      bottom: 80px;
      left: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(255,255,255,0.15);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 999px;
      padding: 8px 14px 8px 10px;
      max-width: 220px;
      animation: floatUp 4s ease-out forwards;
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .bubble-avatar {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: linear-gradient(135deg, #a78bfa, #ec4899);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      color: white;
      flex-shrink: 0;
      overflow: hidden;
    }

    .bubble-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 50%;
    }

    .bubble-text {
      font-size: 14px;
      font-weight: 500;
      color: white;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    @keyframes floatUp {
      0%   { transform: translateY(0) scale(0.8); opacity: 0; }
      10%  { transform: translateY(-10px) scale(1); opacity: 1; }
      80%  { opacity: 1; }
      100% { transform: translateY(-260px) scale(0.9); opacity: 0; }
    }

    /* Input bar at bottom */
    #input-bar {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 12px 16px;
      padding-bottom: max(12px, env(safe-area-inset-bottom));
      display: flex;
      gap: 10px;
      align-items: center;
      background: rgba(0,0,0,0.4);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-top: 1px solid rgba(255,255,255,0.08);
    }

    #reaction-input {
      flex: 1;
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 999px;
      padding: 10px 16px;
      font-size: 15px;
      color: white;
      outline: none;
      -webkit-appearance: none;
      font-family: inherit;
    }

    #reaction-input::placeholder { color: rgba(255,255,255,0.4); }

    #send-btn {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, #a78bfa, #ec4899);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: transform 0.1s, opacity 0.1s;
    }

    #send-btn:active { transform: scale(0.92); opacity: 0.8; }

    #send-btn svg { width: 18px; height: 18px; fill: white; }

    /* Quick emoji pills */
    #quick-emojis {
      position: absolute;
      bottom: 72px;
      left: 16px;
      display: flex;
      gap: 8px;
    }

    .emoji-pill {
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 20px;
      cursor: pointer;
      transition: transform 0.15s, background 0.15s;
      -webkit-tap-highlight-color: transparent;
    }

    .emoji-pill:active {
      transform: scale(1.2);
      background: rgba(255,255,255,0.25);
    }

    /* Reaction count badge */
    #reaction-count {
      position: absolute;
      top: 16px;
      right: 16px;
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 999px;
      padding: 4px 12px;
      font-size: 13px;
      color: rgba(255,255,255,0.8);
      font-weight: 600;
    }
  </style>
</head>
<body>

<div id="bubble-field"></div>

<div id="quick-emojis">
  <div class="emoji-pill" onclick="sendQuick('🔥')">🔥</div>
  <div class="emoji-pill" onclick="sendQuick('😭')">😭</div>
  <div class="emoji-pill" onclick="sendQuick('🎵')">🎵</div>
  <div class="emoji-pill" onclick="sendQuick('💀')">💀</div>
  <div class="emoji-pill" onclick="sendQuick('🤌')">🤌</div>
</div>

<div id="reaction-count">0 reactions</div>

<div id="input-bar">
  <input id="reaction-input" type="text" placeholder="React to this song..." maxlength="60" autocomplete="off" autocorrect="off" spellcheck="false"/>
  <button id="send-btn" onclick="sendReaction()">
    <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
  </button>
</div>

<script>
  const OWNER_CODE  = "${ownerCode}";
  const VIEWER_CODE = "${viewerCode}";
  const VIEWER_NAME = "${viewerName}";
  const BASE        = "";

  let totalCount    = 0;
  let seenIds       = new Set();
  let avatarCache   = {};

  // ── Avatar fetching ──────────────────────────────────────
  async function getAvatar(code) {
    if (avatarCache[code] !== undefined) return avatarCache[code];
    try {
      const r = await fetch(BASE + "/profiles/" + code);
      const d = await r.json();
      avatarCache[code] = d.avatar || null;
    } catch {
      avatarCache[code] = null;
    }
    return avatarCache[code];
  }

  // ── Create floating bubble ────────────────────────────────
  async function spawnBubble(fromCode, fromName, text) {
    const field  = document.getElementById("bubble-field");
    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const avatar = await getAvatar(fromCode);
    const initials = (fromName || fromCode).slice(0, 2).toUpperCase();

    const leftOffset = 16 + Math.random() * 60;
    bubble.style.left = leftOffset + "px";

    bubble.innerHTML = \`
      <div class="bubble-avatar">
        \${avatar
          ? \`<img src="\${avatar}" alt=""/>\`
          : initials
        }
      </div>
      <span class="bubble-text">\${escHtml(text)}</span>
    \`;

    field.appendChild(bubble);
    setTimeout(() => bubble.remove(), 4200);
  }

  function escHtml(str) {
    return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // ── Send reaction ─────────────────────────────────────────
  async function sendReaction() {
    const input = document.getElementById("reaction-input");
    const text  = input.value.trim();
    if (!text || !VIEWER_CODE) return;

    input.value = "";

    try {
      const r = await fetch(BASE + "/reactions/send", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          toCode:   OWNER_CODE,
          fromCode: VIEWER_CODE,
          fromName: VIEWER_NAME,
          text,
        }),
      });
      const d = await r.json();
      if (d.id) {
        seenIds.add(d.id);
        totalCount++;
        updateCount();
        spawnBubble(VIEWER_CODE, VIEWER_NAME, text);
      }
    } catch (e) { console.error(e); }
  }

  function sendQuick(emoji) {
    document.getElementById("reaction-input").value = emoji;
    sendReaction();
  }

  // Enter key sends
  document.getElementById("reaction-input").addEventListener("keydown", e => {
    if (e.key === "Enter") sendReaction();
  });

  // ── Poll for new reactions from others ───────────────────
  async function pollReactions() {
    try {
      const r = await fetch(BASE + "/reactions/for/" + OWNER_CODE);
      const d = await r.json();

      for (const reaction of (d.reactions || [])) {
        if (seenIds.has(reaction.id)) continue;
        seenIds.add(reaction.id);
        totalCount++;
        // Only spawn bubbles for OTHER people's reactions
        if (reaction.fromCode !== VIEWER_CODE) {
          spawnBubble(reaction.fromCode, reaction.fromName, reaction.text);
        }
      }

      updateCount();
    } catch (e) { /* silent */ }
  }

  function updateCount() {
    const el = document.getElementById("reaction-count");
    el.textContent = totalCount === 1 ? "1 reaction" : totalCount + " reactions";
  }

  // Poll every 2 seconds for live feel
  setInterval(pollReactions, 2000);
  pollReactions();
</script>
</body>
</html>`);
});

// Status editor UI — Instagram Notes style
// GET /ui/status?ownerCode=XXX
app.get("/ui/status", (req, res) => {
  const ownerCode = req.query.ownerCode || "";

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
  <title>Status</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

    body {
      background: #0d0d1a;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 60px 24px 40px;
      color: white;
    }

    .note-bubble {
      position: relative;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 20px;
      border-bottom-left-radius: 4px;
      padding: 16px 20px;
      width: 100%;
      max-width: 320px;
      min-height: 80px;
      margin-bottom: 12px;
    }

    .note-bubble::after {
      content: "";
      position: absolute;
      bottom: -12px;
      left: 16px;
      border-left: 12px solid transparent;
      border-top: 12px solid rgba(255,255,255,0.18);
    }

    #status-display {
      font-size: 17px;
      font-weight: 500;
      color: white;
      line-height: 1.4;
      min-height: 24px;
      word-break: break-word;
    }

    #status-display.placeholder { color: rgba(255,255,255,0.35); }

    .char-count {
      text-align: right;
      font-size: 12px;
      color: rgba(255,255,255,0.35);
      margin-top: 6px;
    }

    .section-title {
      font-size: 13px;
      font-weight: 600;
      color: rgba(255,255,255,0.5);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin: 28px 0 12px;
      width: 100%;
      max-width: 320px;
    }

    #status-input {
      width: 100%;
      max-width: 320px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 14px;
      padding: 14px 16px;
      font-size: 16px;
      color: white;
      outline: none;
      font-family: inherit;
      resize: none;
      height: 80px;
      -webkit-appearance: none;
    }

    #status-input::placeholder { color: rgba(255,255,255,0.3); }

    .suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      width: 100%;
      max-width: 320px;
      margin-bottom: 4px;
    }

    .suggestion-pill {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 999px;
      padding: 7px 14px;
      font-size: 14px;
      color: rgba(255,255,255,0.8);
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
    }

    .suggestion-pill:active {
      background: rgba(255,255,255,0.2);
      transform: scale(0.96);
    }

    #save-btn {
      width: 100%;
      max-width: 320px;
      margin-top: 28px;
      padding: 15px;
      border-radius: 14px;
      border: none;
      background: linear-gradient(135deg, #a78bfa, #ec4899);
      color: white;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: opacity 0.15s, transform 0.1s;
    }

    #save-btn:active { opacity: 0.85; transform: scale(0.98); }

    #clear-btn {
      width: 100%;
      max-width: 320px;
      margin-top: 10px;
      padding: 13px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.15);
      background: transparent;
      color: rgba(255,255,255,0.6);
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s;
    }

    #clear-btn:active { background: rgba(255,255,255,0.08); }

    #toast {
      position: fixed;
      bottom: 40px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(255,255,255,0.15);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 999px;
      padding: 10px 22px;
      font-size: 14px;
      font-weight: 600;
      color: white;
      opacity: 0;
      transition: opacity 0.3s, transform 0.3s;
      pointer-events: none;
      white-space: nowrap;
    }

    #toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  </style>
</head>
<body>

  <div class="note-bubble">
    <div id="status-display" class="placeholder">What's on your mind?</div>
    <div class="char-count"><span id="char-num">0</span>/60</div>
  </div>

  <div class="section-title">Your Note</div>

  <textarea id="status-input" placeholder="What are you vibing to? 🎵" maxlength="60"></textarea>

  <div class="section-title">Quick pick</div>

  <div class="suggestions">
    <div class="suggestion-pill" onclick="setSuggestion('vibing rn 🎵')">vibing rn 🎵</div>
    <div class="suggestion-pill" onclick="setSuggestion('this is on repeat 🔁')">on repeat 🔁</div>
    <div class="suggestion-pill" onclick="setSuggestion('can\\'t skip this one')">can't skip 🙅</div>
    <div class="suggestion-pill" onclick="setSuggestion('new obsession 🎧')">new obsession 🎧</div>
    <div class="suggestion-pill" onclick="setSuggestion('this slaps 🔥')">this slaps 🔥</div>
    <div class="suggestion-pill" onclick="setSuggestion('crying to this 😭')">crying to this 😭</div>
    <div class="suggestion-pill" onclick="setSuggestion('not taking requests 😤')">not taking requests 😤</div>
    <div class="suggestion-pill" onclick="setSuggestion('ask me about this song')">ask me about this 👀</div>
  </div>

  <button id="save-btn" onclick="saveStatus()">Save Note</button>
  <button id="clear-btn" onclick="clearStatus()">Clear</button>

  <div id="toast"></div>

<script>
  const OWNER_CODE = "${ownerCode}";
  const input      = document.getElementById("status-input");
  const display    = document.getElementById("status-display");
  const charNum    = document.getElementById("char-num");

  // Live preview
  input.addEventListener("input", () => {
    const val = input.value.trim();
    charNum.textContent = input.value.length;
    if (val) {
      display.textContent = val;
      display.classList.remove("placeholder");
    } else {
      display.textContent = "What's on your mind?";
      display.classList.add("placeholder");
    }
  });

  function setSuggestion(text) {
    input.value = text;
    input.dispatchEvent(new Event("input"));
  }

  async function saveStatus() {
    const status = input.value.trim();
    try {
      await fetch("/profiles/status", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ ownerCode: OWNER_CODE, status }),
      });
      showToast("Note saved ✓");
      // Notify iOS to close WebView
      if (window.webkit?.messageHandlers?.statusSaved) {
        window.webkit.messageHandlers.statusSaved.postMessage({ status });
      }
    } catch { showToast("Something went wrong"); }
  }

  async function clearStatus() {
    input.value = "";
    input.dispatchEvent(new Event("input"));
    try {
      await fetch("/profiles/status", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ ownerCode: OWNER_CODE, status: "" }),
      });
      showToast("Note cleared");
    } catch {}
  }

  function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2200);
  }

  // Load current status on open
  async function loadCurrent() {
    try {
      const r = await fetch("/profiles/" + OWNER_CODE);
      const d = await r.json();
      if (d.status) {
        input.value = d.status;
        input.dispatchEvent(new Event("input"));
      }
    } catch {}
  }

  loadCurrent();
</script>
</body>
</html>`);
});

// Profile picture editor UI
// GET /ui/profile?ownerCode=XXX
app.get("/ui/profile", (req, res) => {
  const ownerCode = req.query.ownerCode || "";

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
  <title>Profile Picture</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

    body {
      background: #0d0d1a;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 60px 24px 40px;
      color: white;
    }

    .page-title {
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 36px;
    }

    .avatar-wrapper {
      position: relative;
      margin-bottom: 32px;
    }

    #avatar-preview {
      width: 120px;
      height: 120px;
      border-radius: 50%;
      object-fit: cover;
      background: linear-gradient(135deg, #a78bfa, #ec4899);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 40px;
      font-weight: 700;
      color: white;
      overflow: hidden;
      border: 3px solid rgba(255,255,255,0.15);
    }

    #avatar-preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 50%;
    }

    .edit-badge {
      position: absolute;
      bottom: 4px;
      right: 4px;
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, #a78bfa, #ec4899);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border: 2px solid #0d0d1a;
    }

    .edit-badge svg { width: 16px; height: 16px; fill: white; }

    #file-input { display: none; }

    .instructions {
      font-size: 14px;
      color: rgba(255,255,255,0.45);
      text-align: center;
      margin-bottom: 32px;
      line-height: 1.5;
    }

    #upload-btn {
      width: 100%;
      max-width: 300px;
      padding: 15px;
      border-radius: 14px;
      border: none;
      background: linear-gradient(135deg, #a78bfa, #ec4899);
      color: white;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: opacity 0.15s, transform 0.1s;
      margin-bottom: 12px;
    }

    #upload-btn:active { opacity: 0.85; transform: scale(0.98); }
    #upload-btn:disabled { opacity: 0.4; }

    #remove-btn {
      width: 100%;
      max-width: 300px;
      padding: 13px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.15);
      background: transparent;
      color: rgba(255,255,255,0.6);
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s;
    }

    #remove-btn:active { background: rgba(255,255,255,0.08); }

    #progress-bar {
      width: 100%;
      max-width: 300px;
      height: 4px;
      background: rgba(255,255,255,0.1);
      border-radius: 999px;
      margin: 16px 0;
      overflow: hidden;
      opacity: 0;
      transition: opacity 0.3s;
    }

    #progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #a78bfa, #ec4899);
      border-radius: 999px;
      transition: width 0.3s;
    }

    #toast {
      position: fixed;
      bottom: 40px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(255,255,255,0.15);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 999px;
      padding: 10px 22px;
      font-size: 14px;
      font-weight: 600;
      color: white;
      opacity: 0;
      transition: opacity 0.3s, transform 0.3s;
      pointer-events: none;
      white-space: nowrap;
    }

    #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  </style>
</head>
<body>

  <div class="page-title">Profile Picture</div>

  <div class="avatar-wrapper">
    <div id="avatar-preview">
      <span id="initials">${ownerCode.slice(0,2).toUpperCase() || "?"}</span>
    </div>
    <div class="edit-badge" onclick="document.getElementById('file-input').click()">
      <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
    </div>
  </div>

  <input type="file" id="file-input" accept="image/jpeg,image/png,image/webp" onchange="handleFile(event)"/>

  <p class="instructions">Tap the edit button or choose a photo below.<br/>Max size 2MB — JPEG, PNG, or WebP.</p>

  <div id="progress-bar"><div id="progress-fill"></div></div>

  <button id="upload-btn" onclick="document.getElementById('file-input').click()">Choose Photo</button>
  <button id="remove-btn" onclick="removeAvatar()">Remove Photo</button>

  <div id="toast"></div>

<script>
  const OWNER_CODE = "${ownerCode}";
  let pendingBase64 = null;
  let pendingMime   = null;

  async function loadCurrent() {
    try {
      const r = await fetch("/profiles/" + OWNER_CODE);
      const d = await r.json();
      if (d.avatar) setPreview(d.avatar);
    } catch {}
  }

  function setPreview(src) {
    const preview = document.getElementById("avatar-preview");
    preview.innerHTML = \`<img src="\${src}" alt="avatar"/>\`;
  }

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      showToast("Image too large (max 2MB)");
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      const result     = ev.target.result; // data:image/jpeg;base64,...
      const [meta, b64] = result.split(",");
      const mime       = meta.match(/:(.*?);/)[1];
      pendingBase64    = b64;
      pendingMime      = mime;
      setPreview(result);
      uploadAvatar();
    };

    setProgress(10);
    reader.readAsDataURL(file);
  }

  async function uploadAvatar() {
    if (!pendingBase64) return;

    const btn = document.getElementById("upload-btn");
    btn.disabled    = true;
    btn.textContent = "Uploading...";
    setProgress(40);

    try {
      const r = await fetch("/profiles/avatar", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          ownerCode:   OWNER_CODE,
          imageBase64: pendingBase64,
          mimeType:    pendingMime,
        }),
      });

      setProgress(100);

      if (r.ok) {
        showToast("Photo saved ✓");
        if (window.webkit?.messageHandlers?.avatarSaved) {
          window.webkit.messageHandlers.avatarSaved.postMessage({ ok: true });
        }
      } else {
        showToast("Upload failed");
      }
    } catch {
      showToast("Something went wrong");
    } finally {
      btn.disabled    = false;
      btn.textContent = "Choose Photo";
      setTimeout(() => setProgress(0), 800);
    }
  }

  async function removeAvatar() {
    try {
      await fetch("/profiles/avatar", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ ownerCode: OWNER_CODE, imageBase64: "", mimeType: "image/jpeg" }),
      });
    } catch {}
    const preview = document.getElementById("avatar-preview");
    preview.innerHTML = \`<span id="initials">\${OWNER_CODE.slice(0,2).toUpperCase()}</span>\`;
    showToast("Photo removed");
  }

  function setProgress(pct) {
    const bar  = document.getElementById("progress-bar");
    const fill = document.getElementById("progress-fill");
    bar.style.opacity  = pct > 0 && pct < 100 ? "1" : "0";
    fill.style.width   = pct + "%";
  }

  function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2200);
  }

  loadCurrent();
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────

app.get("/auth/spotify/login", (req, res) => {
  const ownerCode = normalizeCode(req.query.ownerCode);
  if (!ownerCode) return res.status(400).send("Missing ownerCode");

  const params = new URLSearchParams({
    response_type: "code",
    client_id:     SPOTIFY_CLIENT_ID,
    scope:         "user-read-currently-playing user-read-playback-state",
    redirect_uri:  REDIRECT_URI,
    state:         ownerCode,
  });
  return res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get("/auth/spotify/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error)           return res.status(400).send(`Spotify auth denied: ${error}`);
  if (!code || !state) return res.status(400).send("Missing code or state");

  const ownerCode = normalizeCode(state);
  try {
    const tokens   = await exchangeCodeForTokens(code);
    const existing = sessions.get(ownerCode) || {};
    sessions.set(ownerCode, {
      ...existing,
      ownerCode,
      accessToken:    tokens.access_token,
      refreshToken:   tokens.refresh_token,
      tokenExpiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
      currentSong:    existing.currentSong ?? null,
      connectedAt:    now(),
    });
    getFriendsFor(ownerCode);
    await fetchNowPlayingFromSpotify(sessions.get(ownerCode));
    console.log(`[auth] ${ownerCode} connected Spotify`);

    return res.send(`
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
    console.error("[auth] Callback error:", err.message);
    return res.status(500).send(`Auth failed: ${err.message}`);
  }
});

app.post("/auth/store-token", (req, res) => {
  const ownerCode    = normalizeCode(req.body.ownerCode);
  const refreshToken = req.body.refreshToken;
  const accessToken  = req.body.accessToken;
  const expiresIn    = Number(req.body.expiresIn) || 3600;

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
    connectedAt:    now(),
  });

  getFriendsFor(ownerCode);
  fetchNowPlayingFromSpotify(sessions.get(ownerCode)).catch(() => {});
  console.log(`[auth] Stored token for ${ownerCode}`);
  return res.json({ ok: true, ownerCode });
});

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
  console.log(`[auth] Disconnected ${ownerCode}`);
  return res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// CORE ROUTES
// ─────────────────────────────────────────────────────────────

app.post("/register-device", (req, res) => {
  const ownerCode = normalizeCode(req.body.ownerCode);
  const { spotifyAccessToken } = req.body;
  if (!ownerCode || !spotifyAccessToken) {
    return res.status(400).json({ error: "Missing ownerCode or spotifyAccessToken" });
  }
  const existing = sessions.get(ownerCode);
  sessions.set(ownerCode, {
    ownerCode,
    spotifyAccessToken,
    refreshToken:   existing?.refreshToken   ?? null,
    accessToken:    existing?.accessToken    ?? spotifyAccessToken,
    tokenExpiresAt: existing?.tokenExpiresAt ?? 0,
    currentSong:    existing?.currentSong    ?? null,
    connectedAt:    existing?.connectedAt    ?? now(),
  });
  getFriendsFor(ownerCode);
  return res.json({ ok: true, ownerCode });
});

app.post("/update-now-playing", (req, res) => {
  const ownerCode = normalizeCode(req.body.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });

  const session = sessions.get(ownerCode);
  if (!session) return res.status(404).json({ error: "Unknown ownerCode" });

  if (!session.refreshToken) {
    const { songTitle, artistNames, albumName, albumArtURL, isPlaying, progressMs, durationMs } = req.body;
    session.currentSong = {
      ownerCode,
      songTitle:   songTitle   ?? "",
      artistNames: artistNames ?? "",
      albumName:   albumName   ?? "",
      albumArtURL: albumArtURL ?? null,
      isPlaying:   Boolean(isPlaying),
      progressMs:  Number.isFinite(progressMs) ? progressMs : 0,
      durationMs:  Number.isFinite(durationMs) ? durationMs : 1,
      updatedAt:   now(),
    };
    sessions.set(ownerCode, session);
  }
  return res.json({ ok: true });
});

app.get("/shared-now-playing", (req, res) => {
  const code = normalizeCode(req.query.code);
  if (!code) return res.status(400).json({ error: "Missing code" });
  const session = sessions.get(code);
  if (!session?.currentSong) return res.status(404).json({ error: "No shared song found" });
  return res.json(session.currentSong);
});

app.post("/add-friend-mutual", (req, res) => {
  const ownerCode  = normalizeCode(req.body.ownerCode);
  const friendCode = normalizeCode(req.body.friendCode);
  if (!ownerCode || !friendCode)  return res.status(400).json({ error: "Missing ownerCode or friendCode" });
  if (ownerCode === friendCode)   return res.status(400).json({ error: "You cannot add yourself" });
  addMutualFriendship(ownerCode, friendCode);
  return res.json({ ok: true, ownerCode, friendCode });
});

app.get("/friends", (req, res) => {
  const ownerCode = normalizeCode(req.query.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  return res.json({ ownerCode, friends: Array.from(getFriendsFor(ownerCode)) });
});

app.post("/set-status", (req, res) => {
  const code   = normalizeCode(req.body.ownerCode);
  const status = String(req.body.status ?? "").trim().slice(0, 80);
  if (!code) return res.status(400).json({ error: "Missing ownerCode" });
  const session = sessions.get(code) || { ownerCode: code, currentSong: null };
  session.statusMessage = status;
  sessions.set(code, session);
  console.log(`[status] ${code}: "${status}"`);
  return res.json({ ok: true, status });
});

app.get("/user-status", (req, res) => {
  const code = normalizeCode(req.query.code);
  if (!code) return res.status(400).json({ error: "Missing code" });
  const session = sessions.get(code);
  return res.json({ code, status: session?.statusMessage ?? "" });
});

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────

app.get("/health", (_, res) => {
  const all = [...sessions.values()];
  return res.json({
    ok:             true,
    sessionCount:   sessions.size,
    polledUsers:    all.filter(s => s.refreshToken).length,
    appOnlyUsers:   all.filter(s => !s.refreshToken).length,
    friendCount:    [...friends.values()].reduce((t, s) => t + s.size, 0),
    pollIntervalMs: POLL_INTERVAL_MS,
  });
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startPoller();
});
