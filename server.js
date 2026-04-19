console.log("SERVER STARTING...");

const express = require("express");
const cors    = require("cors");

const { friendRequestsRouter }                         = require("./friendRequests");
const { musicMatchRouter }                             = require("./musicMatch");
const { reactionsRouter, clearReactionsIfSongChanged } = require("./reactions");
const { profilesRouter, profilesStore }                = require("./profiles");

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

    const track      = data.item;
    const newSongKey = `${track.name}::${track.artists.map(a => a.name).join(", ")}`;
    const oldSongKey = session.currentSong
      ? `${session.currentSong.songTitle}::${session.currentSong.artistNames}`
      : null;

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
app.use(express.json({ limit: "5mb" }));
app.locals.sessionsStore = sessions;
app.locals.friendsStore  = friends;
app.locals.profilesStore = profilesStore;

app.use("/friend-request", friendRequestsRouter);
app.use("/music-match",    musicMatchRouter);
app.use("/reactions",      reactionsRouter);
app.use("/profiles",       profilesRouter);

// ─────────────────────────────────────────────────────────────
// UI — shared CSS injected into every page as a template string
// ─────────────────────────────────────────────────────────────
const UI_BASE_CSS = `
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;background:#0d0d1a;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;color:white;overscroll-behavior:none}
  input,textarea,button{font-family:inherit}
`;

// ─────────────────────────────────────────────────────────────
// UI PAGE 1 — Home Feed
// GET /ui/home?ownerCode=XXX
// Shows notes row + friends feed. All data fetched client-side.
// ─────────────────────────────────────────────────────────────
app.get("/ui/home", (req, res) => {
  const ownerCode = req.query.ownerCode || "";
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"/>
<title>SpotPeek</title>
<style>
${UI_BASE_CSS}
body{display:flex;flex-direction:column;overflow:hidden}
.top-bar{display:flex;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top)+12px) 20px 10px;flex-shrink:0}
.app-title{font-size:24px;font-weight:700;letter-spacing:-0.5px;background:linear-gradient(90deg,#a78bfa,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.top-btn{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;cursor:pointer}
.top-btn svg{width:18px;height:18px;fill:rgba(255,255,255,0.7)}

/* notes */
.notes-section{flex-shrink:0;padding:0 0 4px}
.section-label{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,0.35);padding:0 20px 8px}
.notes-row{display:flex;gap:14px;padding:0 20px 14px;overflow-x:auto;scrollbar-width:none}
.notes-row::-webkit-scrollbar{display:none}
.note-item{display:flex;flex-direction:column;align-items:center;gap:5px;flex-shrink:0;cursor:pointer}
.note-bubble-wrap{position:relative;display:flex;flex-direction:column;align-items:center}
.note-bubble{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.18);border-radius:10px;border-bottom-left-radius:2px;padding:5px 9px;max-width:76px;margin-bottom:4px}
.note-bubble span{font-size:10px;color:white;display:block;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60px}
.note-avatar{width:50px;height:50px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:white;overflow:hidden;border:2px solid rgba(255,255,255,0.12)}
.note-avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.note-name{font-size:11px;color:rgba(255,255,255,0.45);text-align:center;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.add-note-item{display:flex;flex-direction:column;align-items:center;gap:5px;flex-shrink:0;cursor:pointer}
.add-circle{width:50px;height:50px;border-radius:50%;border:1.5px dashed rgba(255,255,255,0.22);display:flex;align-items:center;justify-content:center}
.add-circle svg{width:20px;height:20px;stroke:rgba(255,255,255,0.35);fill:none;stroke-width:2;stroke-linecap:round}
.add-label{font-size:11px;color:rgba(255,255,255,0.35)}

/* feed */
.feed{flex:1;overflow-y:auto;padding:4px 0 calc(env(safe-area-inset-bottom)+80px);scrollbar-width:none}
.feed::-webkit-scrollbar{display:none}
.feed-label{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,0.35);padding:0 20px 10px}

.friend-card{margin:0 16px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:14px 16px;cursor:pointer;transition:background .15s}
.friend-card:active{background:rgba(255,255,255,0.08)}
.card-top{display:flex;align-items:center;gap:12px;margin-bottom:11px}
.f-avatar{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:white;flex-shrink:0;overflow:hidden;position:relative}
.f-avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.live-dot{position:absolute;bottom:1px;right:1px;width:12px;height:12px;border-radius:50%;background:#1db954;border:2.5px solid #0d0d1a}
.f-info{flex:1;min-width:0}
.f-name{font-size:15px;font-weight:600;color:white;margin-bottom:2px}
.f-status{font-size:12px;color:rgba(255,255,255,0.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.song-row{display:flex;align-items:center;gap:10px}
.art{width:40px;height:40px;border-radius:9px;flex-shrink:0;object-fit:cover;background:rgba(255,255,255,0.08)}
.art-placeholder{width:40px;height:40px;border-radius:9px;flex-shrink:0;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center}
.art-placeholder svg{width:18px;height:18px;fill:rgba(255,255,255,0.3)}
.song-meta{flex:1;min-width:0}
.song-title{font-size:13px;font-weight:600;color:white;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.song-artist{font-size:12px;color:rgba(255,255,255,0.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.react-pill{background:rgba(167,139,250,0.12);border:1px solid rgba(167,139,250,0.28);border-radius:999px;padding:6px 13px;font-size:12px;font-weight:600;color:#a78bfa;cursor:pointer;flex-shrink:0;white-space:nowrap;transition:background .15s}
.react-pill:active{background:rgba(167,139,250,0.25)}
.prog-bar{height:2px;background:rgba(255,255,255,0.08);border-radius:999px;margin-top:11px;overflow:hidden}
.prog-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#a78bfa,#ec4899)}
.offline-tag{font-size:11px;color:rgba(255,255,255,0.25);background:rgba(255,255,255,0.05);border-radius:999px;padding:3px 9px;flex-shrink:0}

/* empty state */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 32px;gap:12px;text-align:center}
.empty-icon{width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center}
.empty-icon svg{width:26px;height:26px;fill:rgba(255,255,255,0.3)}
.empty-title{font-size:16px;font-weight:600;color:rgba(255,255,255,0.6)}
.empty-sub{font-size:13px;color:rgba(255,255,255,0.3);line-height:1.5}

/* tab bar */
.tab-bar{position:fixed;bottom:0;left:0;right:0;height:calc(60px + env(safe-area-inset-bottom));background:rgba(10,10,22,0.96);border-top:1px solid rgba(255,255,255,0.07);display:flex;align-items:flex-start;justify-content:space-around;padding-top:10px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
.tab{display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;opacity:.4;transition:opacity .2s}
.tab.active{opacity:1}
.tab svg{width:22px;height:22px;fill:rgba(255,255,255,0.9)}
.tab.active svg{fill:#a78bfa}
.tab span{font-size:10px;font-weight:500;color:rgba(255,255,255,0.9)}
.tab.active span{color:#a78bfa}

/* loading skeleton */
.skeleton{background:rgba(255,255,255,0.05);border-radius:10px;animation:shimmer 1.4s infinite}
@keyframes shimmer{0%,100%{opacity:.5}50%{opacity:1}}
</style>
</head>
<body>

<div class="top-bar">
  <div class="app-title">SpotPeek</div>
  <div class="top-btn" onclick="openProfile()">
    <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
  </div>
</div>

<div class="notes-section">
  <div class="section-label">Notes</div>
  <div class="notes-row" id="notes-row">
    <div class="add-note-item" onclick="openStatus()">
      <div class="add-circle">
        <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </div>
      <span class="add-label">Add note</span>
    </div>
  </div>
</div>

<div class="feed" id="feed">
  <div class="feed-label">Friends</div>
  <div id="feed-inner">
    <div style="padding:0 16px 12px">
      <div class="skeleton" style="height:100px;border-radius:20px;margin-bottom:12px"></div>
      <div class="skeleton" style="height:100px;border-radius:20px;margin-bottom:12px"></div>
      <div class="skeleton" style="height:60px;border-radius:20px"></div>
    </div>
  </div>
</div>

<div class="tab-bar">
  <div class="tab active">
    <svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
    <span>Home</span>
  </div>
  <div class="tab" onclick="openSearch()">
    <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
    <span>Search</span>
  </div>
  <div class="tab" onclick="openProfile()">
    <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
    <span>Profile</span>
  </div>
</div>

<script>
const MY_CODE = "${ownerCode}";
const BASE    = "";
const COLORS  = ["#f59e0b,#ef4444","#06b6d4,#6366f1","#10b981,#3b82f6","#ec4899,#8b5cf6","#f97316,#ec4899","#6366f1,#a78bfa"];

function gradientFor(code) {
  const i = (code.charCodeAt(0)||0) % COLORS.length;
  return "linear-gradient(135deg," + COLORS[i] + ")";
}

function initials(name) {
  return (name||"?").slice(0,2).toUpperCase();
}

function avatarHTML(code, name, avatarSrc, size) {
  const s = size || 50;
  const bg = avatarSrc ? "#000" : "";
  const style = "width:"+s+"px;height:"+s+"px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:"+Math.floor(s*0.3)+"px;font-weight:700;color:white;overflow:hidden;flex-shrink:0;background:" + (avatarSrc ? "#111" : "linear-gradient(135deg,"+COLORS[(code.charCodeAt(0)||0)%COLORS.length]+")");
  if (avatarSrc) {
    return '<div style="'+style+'"><img src="'+avatarSrc+'" style="width:100%;height:100%;object-fit:cover;border-radius:50%" /></div>';
  }
  return '<div style="'+style+'">'+initials(name||code)+'</div>';
}

async function loadFeed() {
  try {
    const [friendsRes] = await Promise.all([
      fetch(BASE+"/friends?ownerCode="+MY_CODE)
    ]);
    const friendsData = await friendsRes.json();
    const codes = friendsData.friends || [];

    if (!codes.length) {
      document.getElementById("feed-inner").innerHTML = '<div class="empty"><div class="empty-icon"><svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg></div><div class="empty-title">No friends yet</div><div class="empty-sub">Add friends to see what they\'re listening to</div></div>';
      return;
    }

    // Batch fetch profiles + now playing
    const [profilesRes, ...songResults] = await Promise.all([
      fetch(BASE+"/profiles/batch?codes="+codes.join(",")),
      ...codes.map(c => fetch(BASE+"/shared-now-playing?code="+c).then(r => r.ok ? r.json() : null).catch(()=>null))
    ]);
    const profilesData = await profilesRes.json();
    const profileMap = {};
    profilesData.forEach(p => profileMap[p.ownerCode] = p);

    // Build notes row
    const notesRow = document.getElementById("notes-row");
    codes.forEach((code, i) => {
      const p    = profileMap[code] || {};
      const song = songResults[i];
      if (!p.status) return;
      const el = document.createElement("div");
      el.className = "note-item";
      el.onclick = () => openFriendProfile(code);
      el.innerHTML = '<div class="note-bubble-wrap"><div class="note-bubble"><span>'+escHtml(p.status)+'</span></div>'
        + avatarHTML(code, code, p.avatar, 50) + '</div>'
        + '<span class="note-name">'+escHtml(code)+'</span>';
      notesRow.appendChild(el);
    });

    // Build friend cards
    let cardsHTML = "";
    codes.forEach((code, i) => {
      const p    = profileMap[code] || {};
      const song = songResults[i];
      const grad = gradientFor(code);
      const av   = p.avatar
        ? '<img src="'+p.avatar+'" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />'
        : initials(code);
      const avBg = p.avatar ? "#111" : "linear-gradient(135deg,"+COLORS[(code.charCodeAt(0)||0)%COLORS.length]+")";

      if (!song || !song.songTitle) {
        cardsHTML += '<div class="friend-card">'
          +'<div class="card-top">'
          +'<div class="f-avatar" style="background:'+avBg+'">'+av+'</div>'
          +'<div class="f-info"><div class="f-name">'+escHtml(code)+'</div>'
          +(p.status ? '<div class="f-status">'+escHtml(p.status)+'</div>' : '<div class="f-status" style="opacity:.35">Not listening</div>')
          +'</div><div class="offline-tag">offline</div>'
          +'</div></div>';
        return;
      }

      const pct = song.durationMs > 0 ? Math.round((song.progressMs/song.durationMs)*100) : 0;
      const artHTML = song.albumArtURL
        ? '<img class="art" src="'+song.albumArtURL+'" />'
        : '<div class="art-placeholder"><svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>';

      cardsHTML += '<div class="friend-card" onclick="openReactions(\''+code+'\')">'
        +'<div class="card-top">'
        +'<div class="f-avatar" style="background:'+avBg+'">'+av
        +(song.isPlaying ? '<div class="live-dot"></div>' : '')
        +'</div>'
        +'<div class="f-info"><div class="f-name">'+escHtml(code)+'</div>'
        +(p.status ? '<div class="f-status">'+escHtml(p.status)+'</div>' : '')
        +'</div>'
        +'</div>'
        +'<div class="song-row">'+artHTML
        +'<div class="song-meta"><div class="song-title">'+escHtml(song.songTitle)+'</div>'
        +'<div class="song-artist">'+escHtml(song.artistNames)+'</div></div>'
        +'<div class="react-pill" onclick="event.stopPropagation();openReactions(\''+code+'\')">React</div>'
        +'</div>'
        +'<div class="prog-bar"><div class="prog-fill" style="width:'+pct+'%"></div></div>'
        +'</div>';
    });

    document.getElementById("feed-inner").innerHTML = cardsHTML || '<div class="empty"><div class="empty-icon"><svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div><div class="empty-title">All quiet</div><div class="empty-sub">None of your friends are listening right now</div></div>';

  } catch(e) {
    console.error(e);
    document.getElementById("feed-inner").innerHTML = '<div class="empty"><div class="empty-title">Couldn\'t load feed</div><div class="empty-sub">Pull down to retry</div></div>';
  }
}

function escHtml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function openReactions(friendCode) {
  const url = "/ui/reactions?ownerCode="+friendCode+"&viewerCode="+MY_CODE+"&viewerName="+MY_CODE;
  if (window.webkit?.messageHandlers?.openWebView) {
    window.webkit.messageHandlers.openWebView.postMessage({ url, style: "sheet" });
  } else { window.location.href = url; }
}

function openStatus() {
  const url = "/ui/status?ownerCode="+MY_CODE;
  if (window.webkit?.messageHandlers?.openWebView) {
    window.webkit.messageHandlers.openWebView.postMessage({ url, style: "sheet" });
  } else { window.location.href = url; }
}

function openProfile() {
  const url = "/ui/profile?ownerCode="+MY_CODE;
  if (window.webkit?.messageHandlers?.openWebView) {
    window.webkit.messageHandlers.openWebView.postMessage({ url, style: "push" });
  } else { window.location.href = url; }
}

function openFriendProfile(code) {}
function openSearch() {}

loadFeed();
setInterval(loadFeed, 15000);
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────
// UI PAGE 2 — Reactions
// GET /ui/reactions?ownerCode=XXX&viewerCode=YYY&viewerName=ZZZ
// ─────────────────────────────────────────────────────────────
app.get("/ui/reactions", (req, res) => {
  const ownerCode  = req.query.ownerCode  || "";
  const viewerCode = req.query.viewerCode || "";
  const viewerName = req.query.viewerName || viewerCode;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"/>
<title>Reactions</title>
<style>
${UI_BASE_CSS}
body{overflow:hidden;height:100vh;width:100vw;position:relative;background:transparent}
#bubble-field{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.bubble{position:absolute;bottom:90px;display:flex;align-items:center;gap:8px;background:rgba(20,10,30,0.75);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.18);border-radius:999px;padding:8px 14px 8px 8px;max-width:230px;animation:floatUp 4.2s ease-out forwards;pointer-events:none}
.b-av{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:white;flex-shrink:0;overflow:hidden}
.b-av img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.b-text{font-size:14px;font-weight:500;color:white;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
@keyframes floatUp{0%{transform:translateY(0) scale(.8);opacity:0}8%{transform:translateY(-8px) scale(1);opacity:1}75%{opacity:1}100%{transform:translateY(-280px) scale(.92);opacity:0}}

#quick-row{position:absolute;bottom:82px;left:16px;display:flex;gap:8px;pointer-events:auto}
.eq{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.18);border-radius:999px;padding:7px 13px;font-size:20px;cursor:pointer;transition:transform .12s,background .12s}
.eq:active{transform:scale(1.22);background:rgba(255,255,255,0.22)}

#input-bar{position:absolute;bottom:0;left:0;right:0;padding:10px 14px;padding-bottom:max(12px,env(safe-area-inset-bottom));display:flex;gap:10px;align-items:center;background:rgba(10,5,20,0.82);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border-top:1px solid rgba(255,255,255,0.08)}
#ri{flex:1;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.18);border-radius:999px;padding:11px 18px;font-size:15px;color:white;outline:none;-webkit-appearance:none}
#ri::placeholder{color:rgba(255,255,255,0.38)}
#sb{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#ec4899);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .1s,opacity .1s}
#sb:active{transform:scale(.9);opacity:.8}
#sb svg{width:18px;height:18px;fill:white}

#rc{position:absolute;top:max(16px,env(safe-area-inset-top));right:16px;background:rgba(0,0,0,0.5);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.12);border-radius:999px;padding:5px 13px;font-size:12px;color:rgba(255,255,255,0.75);font-weight:600}
</style>
</head>
<body>
<div id="bubble-field"></div>
<div id="quick-row">
  <div class="eq" onclick="sendQ('🔥')">🔥</div>
  <div class="eq" onclick="sendQ('😭')">😭</div>
  <div class="eq" onclick="sendQ('🎵')">🎵</div>
  <div class="eq" onclick="sendQ('💀')">💀</div>
  <div class="eq" onclick="sendQ('🤌')">🤌</div>
</div>
<div id="rc">0 reactions</div>
<div id="input-bar">
  <input id="ri" type="text" placeholder="React to this song…" maxlength="60" autocomplete="off" autocorrect="off" spellcheck="false"/>
  <button id="sb" onclick="sendReaction()">
    <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
  </button>
</div>
<script>
const OC="${ownerCode}",VC="${viewerCode}",VN="${viewerName}";
let total=0,seen=new Set(),avCache={},pollTimer=null;
const COLORS=["#f59e0b,#ef4444","#06b6d4,#6366f1","#10b981,#3b82f6","#ec4899,#8b5cf6","#f97316,#ec4899","#6366f1,#a78bfa"];

async function getAv(code){
  if(avCache[code]!==undefined)return avCache[code];
  try{const r=await fetch("/profiles/"+code);const d=await r.json();avCache[code]=d.avatar||null;}catch{avCache[code]=null;}
  return avCache[code];
}

async function spawnBubble(fromCode,fromName,text){
  const field=document.getElementById("bubble-field");
  const el=document.createElement("div");
  el.className="bubble";
  const av=await getAv(fromCode);
  const init=(fromName||fromCode).slice(0,2).toUpperCase();
  const ci=(fromCode.charCodeAt(0)||0)%COLORS.length;
  const bg="linear-gradient(135deg,"+COLORS[ci]+")";
  el.style.left=(16+Math.random()*50)+"px";
  el.innerHTML='<div class="b-av" style="background:'+(av?"#111":bg)+'">'+(av?'<img src="'+av+'"/>':init)+'</div><span class="b-text">'+esc(text)+'</span>';
  field.appendChild(el);
  setTimeout(()=>el.remove(),4400);
}

function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}

async function sendReaction(){
  const input=document.getElementById("ri");
  const text=input.value.trim();
  if(!text||!VC)return;
  input.value="";
  try{
    const r=await fetch("/reactions/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({toCode:OC,fromCode:VC,fromName:VN,text})});
    const d=await r.json();
    if(d.id){seen.add(d.id);total++;updateCount();spawnBubble(VC,VN,text);}
  }catch(e){console.error(e);}
}

function sendQ(emoji){document.getElementById("ri").value=emoji;sendReaction();}
document.getElementById("ri").addEventListener("keydown",e=>{if(e.key==="Enter")sendReaction();});

async function poll(){
  try{
    const r=await fetch("/reactions/for/"+OC);
    const d=await r.json();
    for(const rx of(d.reactions||[])){
      if(seen.has(rx.id))continue;
      seen.add(rx.id);total++;
      if(rx.fromCode!==VC)spawnBubble(rx.fromCode,rx.fromName,rx.text);
    }
    updateCount();
  }catch{}
}

function updateCount(){
  document.getElementById("rc").textContent=total===1?"1 reaction":total+" reactions";
}

// Stop polling when hidden to avoid ghost requests
function startPoll(){pollTimer=setInterval(poll,2000);}
function stopPoll(){clearInterval(pollTimer);pollTimer=null;}
document.addEventListener("visibilitychange",()=>document.hidden?stopPoll():startPoll());
startPoll();
poll();
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────
// UI PAGE 3 — Status Editor
// GET /ui/status?ownerCode=XXX
// ─────────────────────────────────────────────────────────────
app.get("/ui/status", (req, res) => {
  const ownerCode = req.query.ownerCode || "";
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"/>
<title>Your Note</title>
<style>
${UI_BASE_CSS}
body{display:flex;flex-direction:column;align-items:center;padding:calc(env(safe-area-inset-top)+48px) 24px calc(env(safe-area-inset-bottom)+32px);min-height:100%}
.page-title{font-size:20px;font-weight:700;margin-bottom:28px;align-self:flex-start}

.bubble-preview{position:relative;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:18px;border-bottom-left-radius:4px;padding:14px 18px;width:100%;max-width:340px;min-height:70px;margin-bottom:8px}
.bubble-preview::after{content:"";position:absolute;bottom:-11px;left:14px;border-left:11px solid transparent;border-top:11px solid rgba(255,255,255,0.15)}
#preview-text{font-size:16px;font-weight:500;color:white;line-height:1.45;min-height:22px;word-break:break-word}
#preview-text.ph{color:rgba(255,255,255,0.3)}
.char-row{text-align:right;font-size:12px;color:rgba(255,255,255,0.3);margin-bottom:24px;width:100%;max-width:340px}

.field-label{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,0.35);margin-bottom:8px;align-self:flex-start;width:100%;max-width:340px}
#si{width:100%;max-width:340px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.13);border-radius:14px;padding:13px 16px;font-size:16px;color:white;outline:none;resize:none;height:82px;-webkit-appearance:none;margin-bottom:18px}
#si::placeholder{color:rgba(255,255,255,0.28)}
#si:focus{border-color:rgba(167,139,250,0.5)}

.chips{display:flex;flex-wrap:wrap;gap:8px;width:100%;max-width:340px;margin-bottom:28px}
.chip{background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.13);border-radius:999px;padding:7px 14px;font-size:13px;color:rgba(255,255,255,0.75);cursor:pointer;transition:background .15s,transform .1s}
.chip:active{background:rgba(255,255,255,0.18);transform:scale(.96)}

.save-btn{width:100%;max-width:340px;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#a78bfa,#ec4899);color:white;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .15s,transform .1s;margin-bottom:10px}
.save-btn:active{opacity:.85;transform:scale(.98)}
.clear-btn{width:100%;max-width:340px;padding:13px;border-radius:14px;border:1px solid rgba(255,255,255,0.13);background:transparent;color:rgba(255,255,255,0.5);font-size:15px;font-weight:500;cursor:pointer;transition:background .15s}
.clear-btn:active{background:rgba(255,255,255,0.07)}

#toast{position:fixed;bottom:calc(env(safe-area-inset-bottom)+28px);left:50%;transform:translateX(-50%) translateY(16px);background:rgba(255,255,255,0.13);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.18);border-radius:999px;padding:10px 22px;font-size:14px;font-weight:600;color:white;opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;white-space:nowrap}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style>
</head>
<body>
<div class="page-title">Your Note</div>

<div class="bubble-preview">
  <div id="preview-text" class="ph">What's on your mind?</div>
</div>
<div class="char-row"><span id="cn">0</span>/60</div>

<div class="field-label">Write your note</div>
<textarea id="si" placeholder="What are you vibing to? 🎵" maxlength="60"></textarea>

<div class="field-label">Quick picks</div>
<div class="chips">
  <div class="chip" onclick="pick('vibing rn 🎵')">vibing rn 🎵</div>
  <div class="chip" onclick="pick('on repeat 🔁')">on repeat 🔁</div>
  <div class="chip" onclick="pick('can\\'t skip 🙅')">can't skip 🙅</div>
  <div class="chip" onclick="pick('new obsession 🎧')">new obsession 🎧</div>
  <div class="chip" onclick="pick('this slaps 🔥')">this slaps 🔥</div>
  <div class="chip" onclick="pick('crying to this 😭')">crying to this 😭</div>
  <div class="chip" onclick="pick('ask me about this 👀')">ask me about this 👀</div>
  <div class="chip" onclick="pick('not taking requests 😤')">not taking requests 😤</div>
</div>

<button class="save-btn" onclick="save()">Save Note</button>
<button class="clear-btn" onclick="clearNote()">Clear</button>
<div id="toast"></div>

<script>
const OC="${ownerCode}";
const si=document.getElementById("si");
const pt=document.getElementById("preview-text");
const cn=document.getElementById("cn");

si.addEventListener("input",()=>{
  const v=si.value.trim();
  cn.textContent=si.value.length;
  if(v){pt.textContent=v;pt.classList.remove("ph");}
  else{pt.textContent="What's on your mind?";pt.classList.add("ph");}
});

function pick(t){si.value=t;si.dispatchEvent(new Event("input"));}

async function save(){
  const status=si.value.trim();
  try{
    await fetch("/profiles/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ownerCode:OC,status})});
    toast("Note saved ✓");
    if(window.webkit?.messageHandlers?.statusSaved)window.webkit.messageHandlers.statusSaved.postMessage({status});
  }catch{toast("Something went wrong");}
}

async function clearNote(){
  si.value="";si.dispatchEvent(new Event("input"));
  try{await fetch("/profiles/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ownerCode:OC,status:""})});toast("Note cleared");}catch{}
}

function toast(msg){
  const t=document.getElementById("toast");
  t.textContent=msg;t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"),2200);
}

async function load(){
  try{const r=await fetch("/profiles/"+OC);const d=await r.json();if(d.status){si.value=d.status;si.dispatchEvent(new Event("input"));}}catch{}
}
load();
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────
// UI PAGE 4 — Profile Picture Editor
// GET /ui/profile?ownerCode=XXX
// ─────────────────────────────────────────────────────────────
app.get("/ui/profile", (req, res) => {
  const ownerCode = req.query.ownerCode || "";
  const initials  = ownerCode.slice(0, 2).toUpperCase() || "?";
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"/>
<title>Profile Picture</title>
<style>
${UI_BASE_CSS}
body{display:flex;flex-direction:column;align-items:center;padding:calc(env(safe-area-inset-top)+48px) 24px calc(env(safe-area-inset-bottom)+32px)}
.page-title{font-size:20px;font-weight:700;margin-bottom:8px}
.page-sub{font-size:14px;color:rgba(255,255,255,0.38);margin-bottom:36px;text-align:center;line-height:1.5}

.av-wrap{position:relative;margin-bottom:32px;cursor:pointer}
#av{width:116px;height:116px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:700;color:white;background:linear-gradient(135deg,#a78bfa,#ec4899);overflow:hidden;border:3px solid rgba(255,255,255,0.12)}
#av img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.edit-badge{position:absolute;bottom:4px;right:4px;width:34px;height:34px;background:linear-gradient(135deg,#a78bfa,#ec4899);border-radius:50%;display:flex;align-items:center;justify-content:center;border:2.5px solid #0d0d1a;box-shadow:0 2px 8px rgba(0,0,0,0.5)}
.edit-badge svg{width:16px;height:16px;fill:white}
#fi{display:none}

.prog-wrap{width:100%;max-width:300px;height:4px;background:rgba(255,255,255,0.08);border-radius:999px;margin-bottom:24px;overflow:hidden;opacity:0;transition:opacity .3s}
#pf{height:100%;width:0%;background:linear-gradient(90deg,#a78bfa,#ec4899);border-radius:999px;transition:width .3s}

.choose-btn{width:100%;max-width:300px;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#a78bfa,#ec4899);color:white;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:12px;transition:opacity .15s,transform .1s}
.choose-btn:active{opacity:.85;transform:scale(.98)}
.choose-btn:disabled{opacity:.4}
.remove-btn{width:100%;max-width:300px;padding:13px;border-radius:14px;border:1px solid rgba(255,255,255,0.13);background:transparent;color:rgba(255,255,255,0.5);font-size:15px;font-weight:500;cursor:pointer;transition:background .15s}
.remove-btn:active{background:rgba(255,255,255,0.07)}

.tips{margin-top:24px;width:100%;max-width:300px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px 16px}
.tips-title{font-size:12px;font-weight:600;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.tip-row{font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6}

#toast{position:fixed;bottom:calc(env(safe-area-inset-bottom)+28px);left:50%;transform:translateX(-50%) translateY(16px);background:rgba(255,255,255,0.13);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.18);border-radius:999px;padding:10px 22px;font-size:14px;font-weight:600;color:white;opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;white-space:nowrap}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style>
</head>
<body>
<div class="page-title">Profile Picture</div>
<div class="page-sub">Your photo appears next to your<br/>name and notes for friends to see.</div>

<div class="av-wrap" onclick="document.getElementById('fi').click()">
  <div id="av"><span id="init">${initials}</span></div>
  <div class="edit-badge">
    <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
  </div>
</div>

<input type="file" id="fi" accept="image/jpeg,image/png,image/webp" onchange="handleFile(event)"/>

<div class="prog-wrap" id="pw"><div id="pf"></div></div>

<button class="choose-btn" id="cb" onclick="document.getElementById('fi').click()">Choose Photo</button>
<button class="remove-btn" id="rb" onclick="removeAv()">Remove Photo</button>

<div class="tips">
  <div class="tips-title">Photo tips</div>
  <div class="tip-row">· Square photos work best — your pic is cropped to a circle<br/>· Max size 2MB — JPEG, PNG, or WebP<br/>· Tap your avatar above to pick a new photo</div>
</div>

<div id="toast"></div>

<script>
const OC="${ownerCode}";
const INIT="${initials}";

async function load(){
  try{
    const r=await fetch("/profiles/"+OC);
    const d=await r.json();
    if(d.avatar)setAv(d.avatar);
  }catch{}
}

function setAv(src){
  document.getElementById("av").innerHTML='<img src="'+src+'" alt="avatar"/>';
}

function resetAv(){
  document.getElementById("av").innerHTML='<span id="init">'+INIT+'</span>';
}

function handleFile(e){
  const file=e.target.files[0];
  if(!file)return;
  if(file.size>2*1024*1024){toast("Image too large — max 2MB");return;}
  setProgress(15);
  const reader=new FileReader();
  reader.onload=ev=>{
    const result=ev.target.result;
    const [meta,b64]=result.split(",");
    const mime=meta.match(/:(.*?);/)[1];
    setAv(result);
    upload(b64,mime);
  };
  reader.readAsDataURL(file);
}

async function upload(b64,mime){
  const btn=document.getElementById("cb");
  btn.disabled=true;btn.textContent="Saving…";
  setProgress(45);
  try{
    const r=await fetch("/profiles/avatar",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ownerCode:OC,imageBase64:b64,mimeType:mime})
    });
    setProgress(100);
    if(r.ok){
      toast("Photo saved ✓");
      if(window.webkit?.messageHandlers?.avatarSaved)window.webkit.messageHandlers.avatarSaved.postMessage({ok:true});
    }else{
      const d=await r.json();
      toast(d.error||"Upload failed");
    }
  }catch{toast("Something went wrong");}
  finally{
    btn.disabled=false;btn.textContent="Choose Photo";
    setTimeout(()=>setProgress(0),900);
  }
}

async function removeAv(){
  try{
    await fetch("/profiles/avatar",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({ownerCode:OC})});
    resetAv();
    toast("Photo removed");
  }catch{toast("Something went wrong");}
}

function setProgress(pct){
  const pw=document.getElementById("pw");
  const pf=document.getElementById("pf");
  pw.style.opacity=(pct>0&&pct<100)?"1":"0";
  pf.style.width=pct+"%";
}

function toast(msg){
  const t=document.getElementById("toast");
  t.textContent=msg;t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"),2400);
}

load();
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
      ...existing, ownerCode,
      accessToken:    tokens.access_token,
      refreshToken:   tokens.refresh_token,
      tokenExpiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
      currentSong:    existing.currentSong ?? null,
      connectedAt:    now(),
    });
    getFriendsFor(ownerCode);
    await fetchNowPlayingFromSpotify(sessions.get(ownerCode));
    console.log(`[auth] ${ownerCode} connected Spotify`);
    return res.send(`<!DOCTYPE html><html><body style="background:#0d0d1a;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px"><svg width="60" height="60" viewBox="0 0 60 60"><circle cx="30" cy="30" r="30" fill="#a78bfa"/><polyline points="16,30 26,40 44,20" stroke="white" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><h2 style="margin:0">Spotify Connected!</h2><p style="margin:0;opacity:.6">You can close this and go back to SpotPeek.</p></body></html>`);
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
  if (!ownerCode || !refreshToken) return res.status(400).json({ error: "Missing ownerCode or refreshToken" });
  const existing = sessions.get(ownerCode) || {};
  sessions.set(ownerCode, {
    ...existing, ownerCode, refreshToken,
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
  if (session) { session.refreshToken = null; session.accessToken = null; session.tokenExpiresAt = 0; sessions.set(ownerCode, session); }
  console.log(`[auth] Disconnected ${ownerCode}`);
  return res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// CORE ROUTES
// ─────────────────────────────────────────────────────────────

app.post("/register-device", (req, res) => {
  const ownerCode = normalizeCode(req.body.ownerCode);
  const { spotifyAccessToken } = req.body;
  if (!ownerCode || !spotifyAccessToken) return res.status(400).json({ error: "Missing ownerCode or spotifyAccessToken" });
  const existing = sessions.get(ownerCode);
  sessions.set(ownerCode, {
    ownerCode, spotifyAccessToken,
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
  if (!ownerCode || !friendCode) return res.status(400).json({ error: "Missing ownerCode or friendCode" });
  if (ownerCode === friendCode)  return res.status(400).json({ error: "You cannot add yourself" });
  addMutualFriendship(ownerCode, friendCode);
  return res.json({ ok: true, ownerCode, friendCode });
});

app.get("/friends", (req, res) => {
  const ownerCode = normalizeCode(req.query.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  return res.json({ ownerCode, friends: Array.from(getFriendsFor(ownerCode)) });
});

// NOTE: /set-status and /user-status removed — status now lives in /profiles/status
// and /profiles/:code — single source of truth, no desync possible

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
