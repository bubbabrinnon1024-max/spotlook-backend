console.log("SERVER STARTING...");

const express = require("express");
const cors    = require("cors");

const { friendRequestsRouter }                         = require("./friendRequests");
const { musicMatchRouter }                             = require("./musicMatch");
function clearReactionsIfSongChanged() {}
const { profilesRouter, profilesStore }                = require("./profiles");

const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || "3075a1f167c04eb7995e72ef633dbb7d";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "3a8cb77501214c3ca3f5b0c266ee2c50";
const SERVER_URL            = process.env.SERVER_URL            || "https://spotlook-backend.onrender.com";
const REDIRECT_URI          = SERVER_URL + "/auth/spotify/callback";
const POLL_INTERVAL_MS      = 10000;
const PORT                  = process.env.PORT || 3000;

const sessions = new Map();
const friends  = new Map();

const normalizeCode = (v) => String(v == null ? "" : v).trim().toUpperCase();
const now           = ()  => new Date().toISOString();

function getFriendsFor(code) {
  var c = normalizeCode(code);
  if (!friends.has(c)) friends.set(c, new Set());
  return friends.get(c);
}

function addMutualFriendship(codeA, codeB) {
  var a = normalizeCode(codeA);
  var b = normalizeCode(codeB);
  if (!a || !b || a === b) return false;
  getFriendsFor(a).add(b);
  getFriendsFor(b).add(a);
  return true;
}

function spotifyAuthHeader() {
  return "Basic " + Buffer.from(SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET).toString("base64");
}

async function exchangeCodeForTokens(code) {
  var res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": spotifyAuthHeader() },
    body: new URLSearchParams({ grant_type: "authorization_code", code: code, redirect_uri: REDIRECT_URI }),
  });
  if (!res.ok) throw new Error("Token exchange failed: " + (await res.text()));
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  var res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": spotifyAuthHeader() },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error("Token refresh failed: " + (await res.text()));
  var data = await res.json();
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
  var tokens = await refreshAccessToken(session.refreshToken);
  session.accessToken    = tokens.accessToken;
  session.refreshToken   = tokens.refreshToken;
  session.tokenExpiresAt = tokens.expiresAt;
  sessions.set(session.ownerCode, session);
  console.log("[token] Refreshed for " + session.ownerCode);
  return session.accessToken;
}

async function fetchNowPlayingFromSpotify(session) {
  try {
    var accessToken = await getValidAccessToken(session);
    var res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { "Authorization": "Bearer " + accessToken },
    });

    if (res.status === 204) {
      if (session.currentSong) {
        session.currentSong = Object.assign({}, session.currentSong, { isPlaying: false, updatedAt: now() });
      }
      return;
    }
    if (!res.ok) {
      console.warn("[poll] Spotify " + res.status + " for " + session.ownerCode);
      return;
    }

    var data = await res.json();
    if (!data || data.currently_playing_type !== "track" || !data.item) {
      if (session.currentSong) {
        session.currentSong = Object.assign({}, session.currentSong, { isPlaying: false, updatedAt: now() });
      }
      return;
    }

    var track      = data.item;
    var newSongKey = track.name + "::" + track.artists.map(function(a) { return a.name; }).join(", ");
    var oldSongKey = session.currentSong
      ? session.currentSong.songTitle + "::" + session.currentSong.artistNames
      : null;

    if (newSongKey !== oldSongKey) {
      clearReactionsIfSongChanged(session.ownerCode, newSongKey);
    }

    session.currentSong = {
      ownerCode:   session.ownerCode,
      songTitle:   track.name,
      artistNames: track.artists.map(function(a) { return a.name; }).join(", "),
      albumName:   track.album ? track.album.name : "",
      albumArtURL: track.album && track.album.images && track.album.images[0] ? track.album.images[0].url : null,
      isPlaying:   data.is_playing,
      progressMs:  data.progress_ms || 0,
      durationMs:  track.duration_ms || 1,
      spotifyUrl:  track.external_urls ? track.external_urls.spotify : null,
      updatedAt:   now(),
    };
    sessions.set(session.ownerCode, session);

  } catch (err) {
    console.error("[poll] Error for " + session.ownerCode + ":", err.message);
  }
}

function startPoller() {
  setInterval(async function() {
    var active = Array.from(sessions.values()).filter(function(s) { return s.refreshToken; });
    if (!active.length) return;
    console.log("[poll] Checking " + active.length + " user(s)...");
    await Promise.allSettled(active.map(fetchNowPlayingFromSpotify));
  }, POLL_INTERVAL_MS);
  console.log("[poll] Poller started - every " + (POLL_INTERVAL_MS / 1000) + "s");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.locals.sessionsStore = sessions;
app.locals.friendsStore  = friends;
app.locals.profilesStore = profilesStore;

app.use("/friend-request", friendRequestsRouter);
app.use("/music-match",    musicMatchRouter);

app.use("/profiles",       profilesRouter);

const UI_BASE_CSS = "*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{height:100%;background:#0d0d1a;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;color:white;overscroll-behavior:none}input,textarea,button{font-family:inherit}";

app.get("/ui/home", function(req, res) {
  var ownerCode = req.query.ownerCode || "";
  res.send("<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'/><meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover'/><title>SpotPeek</title><style>" + UI_BASE_CSS + "body{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px}.title{font-size:28px;font-weight:700;background:linear-gradient(90deg,#a78bfa,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:12px}.sub{font-size:15px;color:rgba(255,255,255,0.45);text-align:center}</style></head><body><div class='title'>SpotPeek</div><div class='sub'>Home feed for " + ownerCode + "</div></body></html>");
});

app.get("/ui/reactions", function(req, res) {
  var ownerCode  = req.query.ownerCode  || "";
  var viewerCode = req.query.viewerCode || "";
  var viewerName = req.query.viewerName || viewerCode;
  res.send("<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'/><meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover'/><title>Reactions</title><style>" + UI_BASE_CSS + "body{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh}#input-bar{position:fixed;bottom:0;left:0;right:0;padding:12px 14px;padding-bottom:max(14px,env(safe-area-inset-bottom));display:flex;gap:10px;background:rgba(10,5,20,0.9);border-top:1px solid rgba(255,255,255,0.08)}#ri{flex:1;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.18);border-radius:999px;padding:11px 18px;font-size:15px;color:white;outline:none}#ri::placeholder{color:rgba(255,255,255,0.38)}#sb{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#ec4899);border:none;cursor:pointer;color:white;font-size:18px}#quick{position:fixed;bottom:76px;left:16px;display:flex;gap:8px}.eq{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.18);border-radius:999px;padding:7px 13px;font-size:20px;cursor:pointer}#field{position:fixed;inset:0;pointer-events:none;overflow:hidden}.bubble{position:absolute;bottom:90px;background:rgba(20,10,30,0.85);border:1px solid rgba(255,255,255,0.18);border-radius:999px;padding:8px 16px;font-size:14px;color:white;animation:floatUp 4s ease-out forwards;pointer-events:none}@keyframes floatUp{0%{transform:translateY(0) scale(.8);opacity:0}8%{transform:translateY(-8px) scale(1);opacity:1}75%{opacity:1}100%{transform:translateY(-260px);opacity:0}}</style></head><body><div id='field'></div><div id='quick'><div class='eq' onclick='sendQ(\"🔥\")'>🔥</div><div class='eq' onclick='sendQ(\"😭\")'>😭</div><div class='eq' onclick='sendQ(\"🎵\")'>🎵</div><div class='eq' onclick='sendQ(\"💀\")'>💀</div><div class='eq' onclick='sendQ(\"🤌\")'>🤌</div></div><div id='input-bar'><input id='ri' type='text' placeholder='React to this song...' maxlength='60' autocomplete='off'/><button id='sb' onclick='send()'>&#10148;</button></div><script>var OC='" + ownerCode + "',VC='" + viewerCode + "',VN='" + viewerName + "';function spawn(t){var f=document.getElementById('field');var el=document.createElement('div');el.className='bubble';el.textContent=VN+': '+t;el.style.left=(16+Math.random()*60)+'px';f.appendChild(el);setTimeout(function(){el.remove();},4200);}async function send(){var i=document.getElementById('ri');var t=i.value.trim();if(!t)return;i.value='';try{var r=await fetch('/reactions/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({toCode:OC,fromCode:VC,fromName:VN,text:t})});spawn(t);}catch(e){console.error(e);}}function sendQ(e){document.getElementById('ri').value=e;send();}document.getElementById('ri').addEventListener('keydown',function(e){if(e.key==='Enter')send();});</script></body></html>");
});

app.get("/ui/status", function(req, res) {
  var ownerCode = req.query.ownerCode || "";
  res.send("<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'/><meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover'/><title>Your Note</title><style>" + UI_BASE_CSS + "body{display:flex;flex-direction:column;align-items:center;padding:calc(env(safe-area-inset-top)+48px) 24px 32px}.title{font-size:20px;font-weight:700;margin-bottom:28px;align-self:flex-start}textarea{width:100%;max-width:340px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.13);border-radius:14px;padding:13px 16px;font-size:16px;color:white;outline:none;resize:none;height:82px;margin-bottom:16px}.chips{display:flex;flex-wrap:wrap;gap:8px;width:100%;max-width:340px;margin-bottom:24px}.chip{background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.13);border-radius:999px;padding:7px 14px;font-size:13px;color:rgba(255,255,255,0.75);cursor:pointer}.btn{width:100%;max-width:340px;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#a78bfa,#ec4899);color:white;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:10px}.btn2{width:100%;max-width:340px;padding:13px;border-radius:14px;border:1px solid rgba(255,255,255,0.13);background:transparent;color:rgba(255,255,255,0.5);font-size:15px;cursor:pointer}</style></head><body><div class='title'>Your Note</div><textarea id='si' placeholder='What are you vibing to?' maxlength='60'></textarea><div class='chips'><div class='chip' onclick='pick(\"vibing rn\")'>vibing rn 🎵</div><div class='chip' onclick='pick(\"on repeat\")'>on repeat 🔁</div><div class='chip' onclick='pick(\"this slaps\")'>this slaps 🔥</div><div class='chip' onclick='pick(\"crying to this\")'>crying to this 😭</div><div class='chip' onclick='pick(\"cant skip\")'>cant skip 🙅</div></div><button class='btn' onclick='save()'>Save Note</button><button class='btn2' onclick='clear()'>Clear</button><script>var OC='" + ownerCode + "';var si=document.getElementById('si');function pick(t){si.value=t;}async function save(){var s=si.value.trim();try{await fetch('/profiles/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerCode:OC,status:s})});if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.statusSaved){window.webkit.messageHandlers.statusSaved.postMessage({status:s});}}catch(e){console.error(e);}}async function clear(){si.value='';await fetch('/profiles/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerCode:OC,status:''})});}async function load(){try{var r=await fetch('/profiles/'+OC);var d=await r.json();if(d.status)si.value=d.status;}catch{}}load();</script></body></html>");
});

app.get("/ui/profile", function(req, res) {
  var ownerCode = req.query.ownerCode || "";
  var initials  = ownerCode.slice(0, 2).toUpperCase() || "?";
  res.send("<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'/><meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover'/><title>Profile Picture</title><style>" + UI_BASE_CSS + "body{display:flex;flex-direction:column;align-items:center;padding:calc(env(safe-area-inset-top)+48px) 24px 32px}.title{font-size:20px;font-weight:700;margin-bottom:24px}.av{width:116px;height:116px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#ec4899);display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:700;color:white;overflow:hidden;margin-bottom:28px;cursor:pointer;border:3px solid rgba(255,255,255,0.12)}.av img{width:100%;height:100%;object-fit:cover;border-radius:50%}.btn{width:100%;max-width:300px;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#a78bfa,#ec4899);color:white;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:12px}.btn2{width:100%;max-width:300px;padding:13px;border-radius:14px;border:1px solid rgba(255,255,255,0.13);background:transparent;color:rgba(255,255,255,0.5);font-size:15px;cursor:pointer}</style></head><body><div class='title'>Profile Picture</div><div class='av' id='av' onclick='document.getElementById(\"fi\").click()'><span id='init'>" + initials + "</span></div><input type='file' id='fi' accept='image/jpeg,image/png,image/webp' style='display:none' onchange='handleFile(event)'/><button class='btn' onclick='document.getElementById(\"fi\").click()'>Choose Photo</button><button class='btn2' onclick='removeAv()'>Remove Photo</button><script>var OC='" + ownerCode + "';var INIT='" + initials + "';async function load(){try{var r=await fetch('/profiles/'+OC);var d=await r.json();if(d.avatar){document.getElementById('av').innerHTML='<img src=\"'+d.avatar+'\" alt=\"avatar\"/>';}}catch{}}function handleFile(e){var file=e.target.files[0];if(!file)return;if(file.size>2*1024*1024){alert('Image too large - max 2MB');return;}var reader=new FileReader();reader.onload=function(ev){var result=ev.target.result;var parts=result.split(',');var meta=parts[0];var b64=parts[1];var mime=meta.match(/:(.*?);/)[1];document.getElementById('av').innerHTML='<img src=\"'+result+'\" alt=\"avatar\"/>';upload(b64,mime);};reader.readAsDataURL(file);}async function upload(b64,mime){try{var r=await fetch('/profiles/avatar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerCode:OC,imageBase64:b64,mimeType:mime})});if(r.ok&&window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.avatarSaved){window.webkit.messageHandlers.avatarSaved.postMessage({ok:true});}}catch(e){console.error(e);}}async function removeAv(){try{await fetch('/profiles/avatar',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerCode:OC})});document.getElementById('av').innerHTML='<span id=\"init\">'+INIT+'</span>';}catch(e){console.error(e);}}load();</script></body></html>");
});

app.get("/auth/spotify/login", function(req, res) {
  var ownerCode = normalizeCode(req.query.ownerCode);
  if (!ownerCode) return res.status(400).send("Missing ownerCode");
  var params = new URLSearchParams({
    response_type: "code",
    client_id:     SPOTIFY_CLIENT_ID,
    scope:         "user-read-currently-playing user-read-playback-state",
    redirect_uri:  REDIRECT_URI,
    state:         ownerCode,
  });
  return res.redirect("https://accounts.spotify.com/authorize?" + params.toString());
});

app.get("/auth/spotify/callback", async function(req, res) {
  var code  = req.query.code;
  var state = req.query.state;
  var error = req.query.error;
  if (error)           return res.status(400).send("Spotify auth denied: " + error);
  if (!code || !state) return res.status(400).send("Missing code or state");
  var ownerCode = normalizeCode(state);
  try {
    var tokens   = await exchangeCodeForTokens(code);
    var existing = sessions.get(ownerCode) || {};
    sessions.set(ownerCode, Object.assign({}, existing, {
      ownerCode:      ownerCode,
      accessToken:    tokens.access_token,
      refreshToken:   tokens.refresh_token,
      tokenExpiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
      currentSong:    existing.currentSong || null,
      connectedAt:    now(),
    }));
    getFriendsFor(ownerCode);
    await fetchNowPlayingFromSpotify(sessions.get(ownerCode));
    console.log("[auth] " + ownerCode + " connected Spotify");
    return res.send("<!DOCTYPE html><html><body style='background:#0d0d1a;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px'><h2>Spotify Connected!</h2><p style='opacity:.6'>You can close this and go back to SpotPeek.</p></body></html>");
  } catch (err) {
    console.error("[auth] Callback error:", err.message);
    return res.status(500).send("Auth failed: " + err.message);
  }
});

app.post("/auth/store-token", function(req, res) {
  var ownerCode    = normalizeCode(req.body.ownerCode);
  var refreshToken = req.body.refreshToken;
  var accessToken  = req.body.accessToken;
  var expiresIn    = Number(req.body.expiresIn) || 3600;
  if (!ownerCode || !refreshToken) return res.status(400).json({ error: "Missing ownerCode or refreshToken" });
  var existing = sessions.get(ownerCode) || {};
  sessions.set(ownerCode, Object.assign({}, existing, {
    ownerCode:      ownerCode,
    refreshToken:   refreshToken,
    accessToken:    accessToken || existing.accessToken || null,
    tokenExpiresAt: accessToken ? Date.now() + (expiresIn - 60) * 1000 : 0,
    currentSong:    existing.currentSong || null,
    connectedAt:    now(),
  }));
  getFriendsFor(ownerCode);
  fetchNowPlayingFromSpotify(sessions.get(ownerCode)).catch(function() {});
  console.log("[auth] Stored token for " + ownerCode);
  return res.json({ ok: true, ownerCode: ownerCode });
});

app.post("/auth/disconnect", function(req, res) {
  var ownerCode = normalizeCode(req.body.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  var session = sessions.get(ownerCode);
  if (session) {
    session.refreshToken   = null;
    session.accessToken    = null;
    session.tokenExpiresAt = 0;
    sessions.set(ownerCode, session);
  }
  console.log("[auth] Disconnected " + ownerCode);
  return res.json({ ok: true });
});

app.post("/register-device", function(req, res) {
  var ownerCode          = normalizeCode(req.body.ownerCode);
  var spotifyAccessToken = req.body.spotifyAccessToken;
  if (!ownerCode || !spotifyAccessToken) return res.status(400).json({ error: "Missing ownerCode or spotifyAccessToken" });
  var existing = sessions.get(ownerCode);
  sessions.set(ownerCode, {
    ownerCode:      ownerCode,
    spotifyAccessToken: spotifyAccessToken,
    refreshToken:   existing ? existing.refreshToken   : null,
    accessToken:    existing ? existing.accessToken    : spotifyAccessToken,
    tokenExpiresAt: existing ? existing.tokenExpiresAt : 0,
    currentSong:    existing ? existing.currentSong    : null,
    connectedAt:    existing ? existing.connectedAt    : now(),
  });
  getFriendsFor(ownerCode);
  return res.json({ ok: true, ownerCode: ownerCode });
});

app.post("/update-now-playing", function(req, res) {
  var ownerCode = normalizeCode(req.body.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  var session = sessions.get(ownerCode);
  if (!session) return res.status(404).json({ error: "Unknown ownerCode" });
  if (!session.refreshToken) {
    session.currentSong = {
      ownerCode:   ownerCode,
      songTitle:   req.body.songTitle   || "",
      artistNames: req.body.artistNames || "",
      albumName:   req.body.albumName   || "",
      albumArtURL: req.body.albumArtURL || null,
      isPlaying:   Boolean(req.body.isPlaying),
      progressMs:  Number.isFinite(req.body.progressMs) ? req.body.progressMs : 0,
      durationMs:  Number.isFinite(req.body.durationMs) ? req.body.durationMs : 1,
      updatedAt:   now(),
    };
    sessions.set(ownerCode, session);
  }
  return res.json({ ok: true });
});

app.get("/shared-now-playing", function(req, res) {
  var code = normalizeCode(req.query.code);
  if (!code) return res.status(400).json({ error: "Missing code" });
  var session = sessions.get(code);
  if (!session || !session.currentSong) return res.status(404).json({ error: "No shared song found" });
  return res.json(session.currentSong);
});

app.post("/add-friend-mutual", function(req, res) {
  var ownerCode  = normalizeCode(req.body.ownerCode);
  var friendCode = normalizeCode(req.body.friendCode);
  if (!ownerCode || !friendCode) return res.status(400).json({ error: "Missing ownerCode or friendCode" });
  if (ownerCode === friendCode)  return res.status(400).json({ error: "You cannot add yourself" });
  addMutualFriendship(ownerCode, friendCode);
  return res.json({ ok: true, ownerCode: ownerCode, friendCode: friendCode });
});

app.get("/friends", function(req, res) {
  var ownerCode = normalizeCode(req.query.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  return res.json({ ownerCode: ownerCode, friends: Array.from(getFriendsFor(ownerCode)) });
});

// Secret admin panel — only accessible with the secret token
// iOS app taps phone number 5x to get here via: /admin?token=9048841193
app.get("/admin", function(req, res) {
  var token = req.query.token || "";
  if (token !== "9048841193") {
    return res.status(403).send("<!DOCTYPE html><html><body style='background:#0d0d1a;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh'><h2>403 Forbidden</h2></body></html>");
  }
  var profileList = Array.from(profilesStore.values());
  var sessionList = Array.from(sessions.values());
  var rows = profileList.map(function(p) {
    var sess = sessions.get(p.ownerCode);
    var hasSpotify = sess && sess.refreshToken ? "yes" : "no";
    var song = sess && sess.currentSong ? sess.currentSong.songTitle + " - " + sess.currentSong.artistNames : "nothing";
    return "<tr style='border-bottom:1px solid rgba(255,255,255,0.08)'>"
      + "<td style='padding:12px 16px;font-weight:600'>" + p.ownerCode + (p.ownerCode === "1234" ? " <span style='background:linear-gradient(135deg,#a78bfa,#ec4899);color:white;font-size:10px;padding:2px 8px;border-radius:999px;margin-left:6px'>DEV</span>" : "") + "</td>"
      + "<td style='padding:12px 16px;color:rgba(255,255,255,0.6)'>" + (p.status || "-") + "</td>"
      + "<td style='padding:12px 16px;color:rgba(255,255,255,0.6)'>" + hasSpotify + "</td>"
      + "<td style='padding:12px 16px;color:rgba(255,255,255,0.5);font-size:12px'>" + song + "</td>"
      + "<td style='padding:12px 16px'><button onclick=\"deleteProfile('" + p.ownerCode + "')\" style='background:#ef4444;border:none;color:white;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px'>Delete</button></td>"
      + "</tr>";
  }).join("");
  var orphanSessions = sessionList.filter(function(s) { return !profilesStore.has(s.ownerCode); });
  var orphanRows = orphanSessions.map(function(s) {
    var song = s.currentSong ? s.currentSong.songTitle + " - " + s.currentSong.artistNames : "nothing";
    return "<tr style='border-bottom:1px solid rgba(255,255,255,0.05)'>"
      + "<td style='padding:12px 16px;font-weight:600;color:rgba(255,255,255,0.5)'>" + s.ownerCode + " <span style='color:rgba(255,255,255,0.3);font-size:11px'>(session only)</span></td>"
      + "<td style='padding:12px 16px;color:rgba(255,255,255,0.4)'>-</td>"
      + "<td style='padding:12px 16px;color:rgba(255,255,255,0.4)'>" + (s.refreshToken ? "yes" : "no") + "</td>"
      + "<td style='padding:12px 16px;color:rgba(255,255,255,0.4);font-size:12px'>" + song + "</td>"
      + "<td style='padding:12px 16px'><button onclick=\"deleteSession('" + s.ownerCode + "')\" style='background:rgba(239,68,68,0.4);border:none;color:white;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px'>Clear</button></td>"
      + "</tr>";
  }).join("");
  res.send("<!DOCTYPE html><html lang='en'><head><meta charset='UTF-8'/><meta name='viewport' content='width=device-width,initial-scale=1'/><title>SpotPeek Admin</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a12;color:white;font-family:-apple-system,BlinkMacSystemFont,sans-serif;min-height:100vh;padding:32px 24px}.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px}.title{font-size:24px;font-weight:700;background:linear-gradient(90deg,#a78bfa,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.badge{background:rgba(167,139,250,0.15);border:1px solid rgba(167,139,250,0.3);color:#a78bfa;font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px}.stats{display:flex;gap:16px;margin-bottom:28px;flex-wrap:wrap}.stat{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px 20px;min-width:120px}.stat-val{font-size:28px;font-weight:700;color:white}.stat-label{font-size:12px;color:rgba(255,255,255,0.4);margin-top:2px}.section-title{font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,0.38);margin-bottom:12px}.table-wrap{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;margin-bottom:32px;overflow-x:auto}table{width:100%;border-collapse:collapse}th{padding:12px 16px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,0.35);background:rgba(255,255,255,0.03)}tr:hover td{background:rgba(255,255,255,0.02)}.del-all{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#ef4444;padding:10px 20px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;margin-bottom:32px}</style></head><body>"
    + "<div class='header'><div class='title'>SpotPeek Admin</div><div class='badge'>Private</div></div>"
    + "<div class='stats'>"
    + "<div class='stat'><div class='stat-val'>" + profileList.length + "</div><div class='stat-label'>Profiles</div></div>"
    + "<div class='stat'><div class='stat-val'>" + sessions.size + "</div><div class='stat-label'>Sessions</div></div>"
    + "<div class='stat'><div class='stat-val'>" + sessionList.filter(function(s){return s.refreshToken;}).length + "</div><div class='stat-label'>Polled</div></div>"
    + "<div class='stat'><div class='stat-val'>" + Array.from(friends.values()).reduce(function(t,s){return t+s.size;},0) + "</div><div class='stat-label'>Friendships</div></div>"
    + "</div>"
    + "<div class='section-title'>Profiles (" + profileList.length + ")</div>"
    + "<div class='table-wrap'><table><thead><tr><th>Code</th><th>Status</th><th>Spotify</th><th>Now Playing</th><th>Action</th></tr></thead><tbody>" + (rows || "<tr><td colspan='5' style='padding:24px;text-align:center;color:rgba(255,255,255,0.3)'>No profiles yet</td></tr>") + "</tbody></table></div>"
    + (orphanRows ? "<div class='section-title'>Sessions without profiles</div><div class='table-wrap'><table><thead><tr><th>Code</th><th>Status</th><th>Spotify</th><th>Now Playing</th><th>Action</th></tr></thead><tbody>" + orphanRows + "</tbody></table></div>" : "")
    + "<button class='del-all' onclick='clearAll()'>Clear All Sessions & Profiles</button>"
    + "<script>"
    + "async function deleteProfile(code){"
    + "if(!confirm('Delete profile for '+code+'?'))return;"
    + "await fetch('/admin/delete-profile?token=9048841193',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerCode:code})});"
    + "location.reload();}"
    + "async function deleteSession(code){"
    + "await fetch('/admin/delete-session?token=9048841193',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerCode:code})});"
    + "location.reload();}"
    + "async function clearAll(){"
    + "if(!confirm('Clear EVERYTHING? This cannot be undone.'))return;"
    + "await fetch('/admin/clear-all?token=9048841193',{method:'POST'});"
    + "location.reload();}"
    + "</script></body></html>");
});

app.post("/admin/delete-profile", function(req, res) {
  if ((req.query.token || "") !== "9048841193") return res.status(403).json({ error: "Forbidden" });
  var code = String((req.body && req.body.ownerCode) || "").trim().toUpperCase();
  profilesStore.delete(code);
  sessions.delete(code);
  return res.json({ ok: true });
});

app.post("/admin/delete-session", function(req, res) {
  if ((req.query.token || "") !== "9048841193") return res.status(403).json({ error: "Forbidden" });
  var code = String((req.body && req.body.ownerCode) || "").trim().toUpperCase();
  sessions.delete(code);
  return res.json({ ok: true });
});

app.post("/admin/clear-all", function(req, res) {
  if ((req.query.token || "") !== "9048841193") return res.status(403).json({ error: "Forbidden" });
  profilesStore.clear();
  sessions.clear();
  friends.clear();
  return res.json({ ok: true });
});

// GET /profiles/dev/:ownerCode — returns profile with DEV badge flag
app.get("/dev-profile/:ownerCode", function(req, res) {
  var code = String(req.params.ownerCode || "").trim().toUpperCase();
  var isDev = code === "1234";
  var profile = profilesStore.get(code) || { ownerCode: code, avatar: null, status: "" };
  return res.json(Object.assign({}, profile, { isDev: isDev }));
});

// ─────────────────────────────────────────────────────────────
// ADMIN DASHBOARD — secret URL, only share with yourself
// GET /admin/timmy-dev-backdoor-9x2k
// ─────────────────────────────────────────────────────────────
app.get("/admin/timmy-dev-backdoor-9x2k", function(req, res) {
  var allProfiles = Array.from(profilesStore.values());
  var allSessions = Array.from(sessions.values());

  var rows = allProfiles.map(function(p) {
    var session = sessions.get(p.ownerCode);
    var song = session && session.currentSong ? session.currentSong.songTitle + " - " + session.currentSong.artistNames : "nothing";
    var isPolled = session && session.refreshToken ? "yes" : "no";
    var av = p.avatar ? "<img src='" + p.avatar + "' style='width:40px;height:40px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:8px'/>" : "<div style='width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#ec4899);display:inline-flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:13px;margin-right:8px;vertical-align:middle'>" + p.ownerCode.slice(0,2) + "</div>";
    return "<tr><td style='padding:12px 16px'>" + av + "<b>" + p.ownerCode + "</b>" + (p.badge ? " <span style='background:#a78bfa;color:white;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;margin-left:4px'>" + p.badge + "</span>" : "") + "</td><td style='padding:12px 16px;color:rgba(255,255,255,0.6)'>" + (p.status || "-") + "</td><td style='padding:12px 16px;color:rgba(255,255,255,0.5);font-size:12px'>" + song + "</td><td style='padding:12px 16px'><span style='color:" + (isPolled === "yes" ? "#22c55e" : "rgba(255,255,255,0.3)") + ";font-size:12px'>" + (isPolled === "yes" ? "live" : "app only") + "</span></td><td style='padding:12px 16px'><button onclick=\"deleteProfile('" + p.ownerCode + "')\" style='background:#ef4444;color:white;border:none;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600'>Delete</button></td></tr>";
  }).join("");

  res.send("<!DOCTYPE html><html><head><meta charset='UTF-8'/><meta name='viewport' content='width=device-width,initial-scale=1'/><title>SpotPeek Admin</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a14;color:white;font-family:-apple-system,sans-serif;padding:32px 24px}h1{font-size:24px;font-weight:700;background:linear-gradient(90deg,#a78bfa,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}.sub{font-size:13px;color:rgba(255,255,255,0.35);margin-bottom:28px}.stats{display:flex;gap:12px;margin-bottom:28px;flex-wrap:wrap}.stat{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px 20px}.stat-val{font-size:26px;font-weight:700;color:white}.stat-lbl{font-size:11px;color:rgba(255,255,255,0.35);margin-top:2px}table{width:100%;border-collapse:collapse;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden}th{padding:12px 16px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,0.35);border-bottom:1px solid rgba(255,255,255,0.07)}tr:not(:last-child) td{border-bottom:1px solid rgba(255,255,255,0.05)}.empty{padding:40px;text-align:center;color:rgba(255,255,255,0.3)}</style></head><body><h1>SpotPeek Admin</h1><p class='sub'>Secret dashboard - don't share this URL</p><div class='stats'><div class='stat'><div class='stat-val'>" + allProfiles.length + "</div><div class='stat-lbl'>Profiles</div></div><div class='stat'><div class='stat-val'>" + allSessions.filter(function(s){return s.refreshToken;}).length + "</div><div class='stat-lbl'>Live (polled)</div></div><div class='stat'><div class='stat-val'>" + sessions.size + "</div><div class='stat-lbl'>Total sessions</div></div></div>" + (allProfiles.length ? "<table><thead><tr><th>Code</th><th>Status</th><th>Now Playing</th><th>Connection</th><th>Action</th></tr></thead><tbody>" + rows + "</tbody></table>" : "<div class='empty'>No profiles yet</div>") + "<script>async function deleteProfile(code){if(!confirm('Delete profile for '+code+'?'))return;await fetch('/admin/timmy-dev-backdoor-9x2k/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})});location.reload();}<\/script></body></html>");
});

app.post("/admin/timmy-dev-backdoor-9x2k/delete", function(req, res) {
  var code = String((req.body && req.body.code) || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Missing code" });
  profilesStore.delete(code);
  sessions.delete(code);
  console.log("[admin] Deleted profile + session for " + code);
  return res.json({ ok: true, deleted: code });
});

app.get("/health", function(req, res) {
  var all = Array.from(sessions.values());
  return res.json({
    ok:             true,
    sessionCount:   sessions.size,
    polledUsers:    all.filter(function(s) { return s.refreshToken; }).length,
    appOnlyUsers:   all.filter(function(s) { return !s.refreshToken; }).length,
    friendCount:    Array.from(friends.values()).reduce(function(t, s) { return t + s.size; }, 0),
    pollIntervalMs: POLL_INTERVAL_MS,
  });
});

app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
  startPoller();
});
