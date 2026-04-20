console.log("SERVER STARTING...");

const express = require("express");
const cors    = require("cors");
const https   = require("https");
const http    = require("http");

const { friendRequestsRouter }  = require("./friendRequests");
const { musicMatchRouter }      = require("./musicMatch");
const { profilesRouter, profilesStore } = require("./profiles");
function clearReactionsIfSongChanged() {}

const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || "3075a1f167c04eb7995e72ef633dbb7d";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "3a8cb77501214c3ca3f5b0c266ee2c50";
const SERVER_URL            = process.env.SERVER_URL            || "https://spotlook-backend.onrender.com";
const REDIRECT_URI          = SERVER_URL + "/auth/spotify/callback";
const POLL_INTERVAL_MS      = 10000;
const PORT                  = process.env.PORT || 3000;

// Brevo config - set BREVO_API_KEY in Render environment variables
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";

const sessions  = new Map();
const friends   = new Map();
const otpStore  = new Map(); // code -> { otp, contact, type, expires, ownerCode }
const ipLog     = []; // array of { ip, userAgent, ownerCode, path, ts } — max 500

// ── KILL SWITCH ──
var APP_ONLINE = true;
var MAINTENANCE_MESSAGE = "SpotPeek is temporarily down for maintenance. Check back soon.";

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

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Send email via Brevo API (no SDK needed)
function sendEmail(to, subject, body) {
  return new Promise(function(resolve, reject) {
    if (!BREVO_API_KEY) {
      console.log("[OTP] No Brevo key - OTP for " + to + ": " + body);
      resolve({ ok: true, simulated: true });
      return;
    }
    var payload = JSON.stringify({
      sender: { name: "SpotPeek", email: "bubbabrinnon1024@gmail.com" },
      to: [{ email: to }],
      subject: subject,
      textContent: body
    });
    var options = {
      hostname: "api.brevo.com",
      path: "/v3/smtp/email",
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };
    var req = https.request(options, function(res) {
      res.on("data", function() {});
      res.on("end", function() { resolve({ ok: true }); });
    });
    req.on("error", function(e) { reject(e); });
    req.write(payload);
    req.end();
  });
}

// SMS not configured - logs OTP to console
function sendSMS(to, body) {
  return new Promise(function(resolve) {
    console.log("[OTP] SMS for " + to + ": " + body);
    resolve({ ok: true, simulated: true });
  });
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
  if (!session.refreshToken) throw new Error("No refresh token");
  if (session.accessToken && session.tokenExpiresAt && Date.now() < session.tokenExpiresAt) return session.accessToken;
  var tokens = await refreshAccessToken(session.refreshToken);
  session.accessToken    = tokens.accessToken;
  session.refreshToken   = tokens.refreshToken;
  session.tokenExpiresAt = tokens.expiresAt;
  sessions.set(session.ownerCode, session);
  return session.accessToken;
}

async function fetchNowPlayingFromSpotify(session) {
  try {
    var accessToken = await getValidAccessToken(session);
    var res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { "Authorization": "Bearer " + accessToken },
    });
    if (res.status === 204) {
      if (session.currentSong) session.currentSong = Object.assign({}, session.currentSong, { isPlaying: false, updatedAt: now() });
      return;
    }
    if (!res.ok) { console.warn("[poll] Spotify " + res.status + " for " + session.ownerCode); return; }
    var data = await res.json();
    if (!data || data.currently_playing_type !== "track" || !data.item) {
      if (session.currentSong) session.currentSong = Object.assign({}, session.currentSong, { isPlaying: false, updatedAt: now() });
      return;
    }
    var track      = data.item;
    var newSongKey = track.name + "::" + track.artists.map(function(a) { return a.name; }).join(", ");
    var oldSongKey = session.currentSong ? session.currentSong.songTitle + "::" + session.currentSong.artistNames : null;
    if (newSongKey !== oldSongKey) clearReactionsIfSongChanged(session.ownerCode, newSongKey);
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
    await Promise.allSettled(active.map(fetchNowPlayingFromSpotify));
  }, POLL_INTERVAL_MS);
  console.log("[poll] Poller started");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// IP + device logger — runs on every request except admin/health
app.use(function(req, res, next) {
  if (req.path.startsWith("/admin/") || req.path === "/health") return next();
  var ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  ip = ip.split(",")[0].trim();
  var ua = req.headers["user-agent"] || "unknown";
  var ownerCode = req.body && req.body.ownerCode ? String(req.body.ownerCode).trim().toUpperCase() : (req.query.ownerCode ? String(req.query.ownerCode).trim().toUpperCase() : "");
  // Geo lookup (fire and forget)
  var logEntry = { ip: ip, userAgent: ua, ownerCode: ownerCode, path: req.path, ts: new Date().toISOString(), city: "", country: "", region: "" };
  ipLog.unshift(logEntry);
  if (ipLog.length > 500) ipLog.pop();
  // Async geo lookup via ip-api.com (free, no key needed)
  if (ip && ip !== "127.0.0.1" && ip !== "::1" && !ip.startsWith("10.") && !ip.startsWith("192.168.")) {
    http.get("http://ip-api.com/json/" + ip + "?fields=city,regionName,country,countryCode", function(gres) {
      var gdata = "";
      gres.on("data", function(chunk) { gdata += chunk; });
      gres.on("end", function() {
        try {
          var geo = JSON.parse(gdata);
          logEntry.city = geo.city || "";
          logEntry.region = geo.regionName || "";
          logEntry.country = geo.countryCode || "";
        } catch(e) {}
      });
    }).on("error", function() {});
  }
  next();
});
app.locals.sessionsStore = sessions;
app.locals.friendsStore  = friends;
app.locals.profilesStore = profilesStore;

// ── KILL SWITCH MIDDLEWARE ── blocks everything except admin
app.use(function(req, res, next) {
  if (APP_ONLINE) return next();
  if (req.path.startsWith("/admin/")) return next();
  if (req.path === "/health") return next();
  // Return maintenance page for browser requests, JSON for API
  var wantsJSON = req.headers["content-type"] === "application/json" || req.path.startsWith("/shared") || req.path.startsWith("/profiles") || req.path.startsWith("/friend") || req.path.startsWith("/auth") || req.path.startsWith("/register") || req.path.startsWith("/update");
  if (wantsJSON) return res.status(503).json({ error: "maintenance", message: MAINTENANCE_MESSAGE });
  return res.status(503).send("<!DOCTYPE html><html><head><meta charset='UTF-8'/><meta name='viewport' content='width=device-width,initial-scale=1'/><title>SpotPeek</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a14;color:white;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;padding:32px;text-align:center}.icon{width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#ec4899);display:flex;align-items:center;justify-content:center;font-size:32px;margin-bottom:8px}h1{font-size:24px;font-weight:700}p{font-size:14px;color:rgba(255,255,255,0.45);line-height:1.6;max-width:300px}</style></head><body><div class='icon'>🔧</div><h1>Down for Maintenance</h1><p>" + MAINTENANCE_MESSAGE + "</p></body></html>");
});

app.use("/friend-request", friendRequestsRouter);
app.use("/music-match",    musicMatchRouter);
app.use("/profiles",       profilesRouter);

// ── OTP: Send code ──

// GET /auth/check-email?email=XXX&ownerCode=YYY
// Check if email already registered to a different account
app.get("/auth/check-email", function(req, res) {
  var email = String((req.query.email) || "").trim().toLowerCase();
  var ownerCode = String((req.query.ownerCode) || "").trim().toUpperCase();
  if (!email) return res.status(400).json({ error: "Missing email" });
  var existing = Array.from(profilesStore.values()).find(function(p) {
    return p.email && p.email.toLowerCase() === email && p.ownerCode !== ownerCode;
  });
  return res.json({ exists: !!existing });
});

// POST /auth/send-otp  body: { ownerCode, contact, type: "email"|"phone" }
app.post("/auth/send-otp", async function(req, res) {
  var ownerCode = normalizeCode(req.body && req.body.ownerCode);
  var contact   = String((req.body && req.body.contact) || "").trim().toLowerCase();
  var type      = String((req.body && req.body.type)    || "email").trim().toLowerCase();
  if (!ownerCode || !contact) return res.status(400).json({ error: "Missing ownerCode or contact" });
  if (type !== "email" && type !== "phone") return res.status(400).json({ error: "type must be email or phone" });

  // Server-side email blocking
  if (type === "email") {
    var blockedDomains = ["privaterelay.appleid.com","mailinator.com","guerrillamail.com","tempmail.com","throwam.com","sharklasers.com","guerrillamailblock.com","grr.la","guerrillamail.info","guerrillamail.biz","guerrillamail.de","guerrillamail.net","guerrillamail.org","spam4.me","trashmail.com","trashmail.me","trashmail.net","yopmail.com","maildrop.cc","discard.email","fakeinbox.com","tempr.email","10minutemail.com","10minutemail.net","throwaway.email","getnada.com"];
    var emailLower = contact.toLowerCase();
    var atIdx = emailLower.lastIndexOf("@");
    var domain = atIdx >= 0 ? emailLower.slice(atIdx + 1) : "";
    var localPart = atIdx >= 0 ? emailLower.slice(0, atIdx) : emailLower;
    if (domain.indexOf("privaterelay.appleid.com") >= 0) {
      return res.status(400).json({ error: "Apple Hide My Email is not allowed. Use your real email address." });
    }
    if (blockedDomains.indexOf(domain) >= 0) {
      return res.status(400).json({ error: "Disposable or temporary email addresses are not allowed." });
    }
    if (localPart.indexOf("+") >= 0) {
      return res.status(400).json({ error: "Email aliases with + are not allowed. Use your main email address." });
    }
    // Check if email already used by a different account
    var existingProfile = Array.from(profilesStore.values()).find(function(p) {
      return p.email && p.email.toLowerCase() === emailLower && p.ownerCode !== ownerCode;
    });
    if (existingProfile) {
      return res.status(409).json({ error: "This email is already linked to another account." });
    }
  }

  var otp     = generateOTP();
  var expires = Date.now() + 10 * 60 * 1000; // 10 minutes
  otpStore.set(ownerCode, { otp: otp, contact: contact, type: type, expires: expires, verified: false });

  try {
    if (type === "email") {
      await sendEmail(contact, "Your SpotPeek code is " + otp, "Your SpotPeek verification code is: " + otp + "\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, ignore this email.");
    } else {
      await sendSMS(contact, "Your SpotPeek code is: " + otp + ". Expires in 10 minutes.");
    }
    console.log("[otp] Sent " + type + " OTP to " + contact + " for " + ownerCode);
    return res.json({ ok: true, type: type, hint: contact.slice(0, 3) + "***" });
  } catch (err) {
    console.error("[otp] Send failed:", err.message);
    return res.status(500).json({ error: "Failed to send code" });
  }
});

// POST /auth/verify-otp  body: { ownerCode, otp }
app.post("/auth/verify-otp", function(req, res) {
  var ownerCode = normalizeCode(req.body && req.body.ownerCode);
  var otp       = String((req.body && req.body.otp) || "").trim();
  if (!ownerCode || !otp) return res.status(400).json({ error: "Missing ownerCode or otp" });

  var record = otpStore.get(ownerCode);
  if (!record)                    return res.status(400).json({ error: "No OTP found - request a new code" });
  if (Date.now() > record.expires) return res.status(400).json({ error: "Code expired - request a new one" });
  if (record.otp !== otp)          return res.status(400).json({ error: "Wrong code" });

  // Mark verified
  otpStore.delete(ownerCode);
  var profile = profilesStore.get(ownerCode);
  if (!profile) {
    profilesStore.set(ownerCode, { ownerCode: ownerCode, avatar: null, status: "", badge: "", email: record.type === "email" ? record.contact : "", phone: record.type === "phone" ? record.contact : "", verified: true, updatedAt: now() });
  } else {
    if (record.type === "email") profile.email = record.contact;
    if (record.type === "phone") profile.phone = record.contact;
    profile.verified  = true;
    profile.updatedAt = now();
    profilesStore.set(ownerCode, profile);
  }
  console.log("[otp] Verified " + ownerCode + " via " + record.type);
  return res.json({ ok: true, ownerCode: ownerCode, verified: true });
});

// GET /auth/check-verified?ownerCode=XXX
app.get("/auth/check-verified", function(req, res) {
  var ownerCode = normalizeCode(req.query.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  var profile = profilesStore.get(ownerCode);
  return res.json({ ownerCode: ownerCode, verified: !!(profile && profile.verified) });
});

app.get("/auth/spotify/login", function(req, res) {
  var ownerCode = normalizeCode(req.query.ownerCode);
  if (!ownerCode) return res.status(400).send("Missing ownerCode");
  var params = new URLSearchParams({ response_type: "code", client_id: SPOTIFY_CLIENT_ID, scope: "user-read-currently-playing user-read-playback-state", redirect_uri: REDIRECT_URI, state: ownerCode });
  return res.redirect("https://accounts.spotify.com/authorize?" + params.toString());
});

app.get("/auth/spotify/callback", async function(req, res) {
  var code = req.query.code; var state = req.query.state; var error = req.query.error;
  if (error) return res.status(400).send("Spotify auth denied: " + error);
  if (!code || !state) return res.status(400).send("Missing code or state");
  var ownerCode = normalizeCode(state);
  try {
    var tokens = await exchangeCodeForTokens(code);
    var existing = sessions.get(ownerCode) || {};
    sessions.set(ownerCode, Object.assign({}, existing, { ownerCode: ownerCode, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, tokenExpiresAt: Date.now() + (tokens.expires_in - 60) * 1000, currentSong: existing.currentSong || null, connectedAt: now() }));
    getFriendsFor(ownerCode);
    await fetchNowPlayingFromSpotify(sessions.get(ownerCode));
    console.log("[auth] " + ownerCode + " connected Spotify");
    return res.send("<!DOCTYPE html><html><body style='background:#0a0a14;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px'><h2>Spotify Connected!</h2><p style='opacity:.6'>You can close this and go back to SpotPeek.</p></body></html>");
  } catch (err) {
    return res.status(500).send("Auth failed: " + err.message);
  }
});

app.post("/auth/store-token", function(req, res) {
  var ownerCode = normalizeCode(req.body.ownerCode); var refreshToken = req.body.refreshToken; var accessToken = req.body.accessToken; var expiresIn = Number(req.body.expiresIn) || 3600;
  if (!ownerCode || !refreshToken) return res.status(400).json({ error: "Missing ownerCode or refreshToken" });
  var existing = sessions.get(ownerCode) || {};
  sessions.set(ownerCode, Object.assign({}, existing, { ownerCode: ownerCode, refreshToken: refreshToken, accessToken: accessToken || existing.accessToken || null, tokenExpiresAt: accessToken ? Date.now() + (expiresIn - 60) * 1000 : 0, currentSong: existing.currentSong || null, connectedAt: now() }));
  getFriendsFor(ownerCode);
  fetchNowPlayingFromSpotify(sessions.get(ownerCode)).catch(function() {});
  return res.json({ ok: true, ownerCode: ownerCode });
});

app.post("/auth/disconnect", function(req, res) {
  var ownerCode = normalizeCode(req.body.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  var session = sessions.get(ownerCode);
  if (session) { session.refreshToken = null; session.accessToken = null; session.tokenExpiresAt = 0; sessions.set(ownerCode, session); }
  return res.json({ ok: true });
});

app.post("/register-device", function(req, res) {
  var ownerCode = normalizeCode(req.body.ownerCode); var spotifyAccessToken = req.body.spotifyAccessToken;
  if (!ownerCode || !spotifyAccessToken) return res.status(400).json({ error: "Missing fields" });
  var existing = sessions.get(ownerCode);
  sessions.set(ownerCode, { ownerCode: ownerCode, spotifyAccessToken: spotifyAccessToken, refreshToken: existing ? existing.refreshToken : null, accessToken: existing ? existing.accessToken : spotifyAccessToken, tokenExpiresAt: existing ? existing.tokenExpiresAt : 0, currentSong: existing ? existing.currentSong : null, connectedAt: existing ? existing.connectedAt : now() });
  getFriendsFor(ownerCode);
  return res.json({ ok: true, ownerCode: ownerCode });
});

app.post("/update-now-playing", function(req, res) {
  var ownerCode = normalizeCode(req.body.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  var session = sessions.get(ownerCode);
  if (!session) return res.status(404).json({ error: "Unknown ownerCode" });
  if (!session.refreshToken) {
    session.currentSong = { ownerCode: ownerCode, songTitle: req.body.songTitle || "", artistNames: req.body.artistNames || "", albumName: req.body.albumName || "", albumArtURL: req.body.albumArtURL || null, isPlaying: Boolean(req.body.isPlaying), progressMs: Number.isFinite(req.body.progressMs) ? req.body.progressMs : 0, durationMs: Number.isFinite(req.body.durationMs) ? req.body.durationMs : 1, updatedAt: now() };
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
  var ownerCode = normalizeCode(req.body.ownerCode); var friendCode = normalizeCode(req.body.friendCode);
  if (!ownerCode || !friendCode) return res.status(400).json({ error: "Missing fields" });
  if (ownerCode === friendCode) return res.status(400).json({ error: "Cannot add yourself" });
  addMutualFriendship(ownerCode, friendCode);
  return res.json({ ok: true });
});

app.get("/friends", function(req, res) {
  var ownerCode = normalizeCode(req.query.ownerCode);
  if (!ownerCode) return res.status(400).json({ error: "Missing ownerCode" });
  return res.json({ ownerCode: ownerCode, friends: Array.from(getFriendsFor(ownerCode)) });
});

// ── UI pages ──
app.get("/ui/status", function(req, res) {
  var ownerCode = req.query.ownerCode || "";
  res.send("<!DOCTYPE html><html><head><meta charset='UTF-8'/><meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover'/><title>Your Note</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0d1a;color:white;font-family:-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;padding:calc(env(safe-area-inset-top)+48px) 24px 32px;min-height:100%}.title{font-size:20px;font-weight:700;margin-bottom:28px;align-self:flex-start}textarea{width:100%;max-width:340px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.13);border-radius:14px;padding:13px 16px;font-size:16px;color:white;outline:none;resize:none;height:82px;margin-bottom:16px}.chips{display:flex;flex-wrap:wrap;gap:8px;width:100%;max-width:340px;margin-bottom:24px}.chip{background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.13);border-radius:999px;padding:7px 14px;font-size:13px;color:rgba(255,255,255,0.75);cursor:pointer}.btn{width:100%;max-width:340px;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#a78bfa,#ec4899);color:white;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:10px}.btn2{width:100%;max-width:340px;padding:13px;border-radius:14px;border:1px solid rgba(255,255,255,0.13);background:transparent;color:rgba(255,255,255,0.5);font-size:15px;cursor:pointer}</style></head><body><div class='title'>Your Note</div><textarea id='si' placeholder='What are you vibing to?' maxlength='60'></textarea><div class='chips'><div class='chip' onclick='pick(\"vibing rn\")'>vibing rn</div><div class='chip' onclick='pick(\"on repeat\")'>on repeat</div><div class='chip' onclick='pick(\"this slaps\")'>this slaps</div><div class='chip' onclick='pick(\"crying to this\")'>crying to this</div></div><button class='btn' onclick='save()'>Save Note</button><button class='btn2' onclick='clr()'>Clear</button><script>var OC='" + ownerCode + "';var si=document.getElementById('si');function pick(t){si.value=t;}async function save(){var s=si.value.trim();try{await fetch('/profiles/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerCode:OC,status:s})});if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.statusSaved)window.webkit.messageHandlers.statusSaved.postMessage({status:s});}catch(e){}}async function clr(){si.value='';await fetch('/profiles/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerCode:OC,status:''})});}async function load(){try{var r=await fetch('/profiles/'+OC);var d=await r.json();if(d.status)si.value=d.status;}catch{}}load();<\/script></body></html>");
});

app.get("/ui/profile", function(req, res) {
  var ownerCode = req.query.ownerCode || "";
  var initials  = ownerCode.slice(0, 2).toUpperCase() || "?";
  res.send("<!DOCTYPE html><html><head><meta charset='UTF-8'/><meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover'/><title>Profile Picture</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0d1a;color:white;font-family:-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;padding:calc(env(safe-area-inset-top)+48px) 24px 32px}.title{font-size:20px;font-weight:700;margin-bottom:24px}.av{width:116px;height:116px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#ec4899);display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:700;color:white;overflow:hidden;margin-bottom:28px;cursor:pointer;border:3px solid rgba(255,255,255,0.12)}.av img{width:100%;height:100%;object-fit:cover;border-radius:50%}.btn{width:100%;max-width:300px;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,#a78bfa,#ec4899);color:white;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:12px}.btn2{width:100%;max-width:300px;padding:13px;border-radius:14px;border:1px solid rgba(255,255,255,0.13);background:transparent;color:rgba(255,255,255,0.5);font-size:15px;cursor:pointer}</style></head><body><div class='title'>Profile Picture</div><div class='av' id='av' onclick='document.getElementById(\"fi\").click()'><span>" + initials + "</span></div><input type='file' id='fi' accept='image/jpeg,image/png,image/webp' style='display:none' onchange='handleFile(event)'/><button class='btn' onclick='document.getElementById(\"fi\").click()'>Choose Photo</button><button class='btn2' onclick='removeAv()'>Remove Photo</button><script>var OC='" + ownerCode + "';var INIT='" + initials + "';async function load(){try{var r=await fetch('/profiles/'+OC);var d=await r.json();if(d.avatar)document.getElementById('av').innerHTML='<img src=\"'+d.avatar+'\" alt=\"avatar\"/>';}catch{}}function handleFile(e){var file=e.target.files[0];if(!file)return;if(file.size>2*1024*1024){alert('Max 2MB');return;}var reader=new FileReader();reader.onload=function(ev){var result=ev.target.result;var parts=result.split(',');var b64=parts[1];var mime=parts[0].match(/:(.*?);/)[1];document.getElementById('av').innerHTML='<img src=\"'+result+'\" alt=\"avatar\"/>';upload(b64,mime);};reader.readAsDataURL(file);}async function upload(b64,mime){try{var r=await fetch('/profiles/avatar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerCode:OC,imageBase64:b64,mimeType:mime})});if(r.ok&&window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.avatarSaved)window.webkit.messageHandlers.avatarSaved.postMessage({ok:true});}catch(e){}}async function removeAv(){try{await fetch('/profiles/avatar',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerCode:OC})});document.getElementById('av').innerHTML='<span>'+INIT+'</span>';}catch(e){}}load();<\/script></body></html>");
});

// ── ADMIN DASHBOARD ──
app.get("/admin/timmy-dev-backdoor-9x2k", function(req, res) {
  res.setHeader("Content-Type", "text/html");
  res.end([
    "<!DOCTYPE html><html><head>",
    "<meta charset='UTF-8'>",
    "<meta name='viewport' content='width=device-width,initial-scale=1'>",
    "<title>Timmys Layer</title>",
    "<style>",
    "*{margin:0;padding:0;box-sizing:border-box}",
    "body{background:#0a0a14;color:white;font-family:-apple-system,sans-serif;padding:24px}",
    ".logo{font-size:22px;font-weight:700;background:linear-gradient(90deg,#a78bfa,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}",
    ".header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px}",
    ".killbtn{padding:10px 20px;border-radius:12px;border:none;font-size:14px;font-weight:700;cursor:pointer}",
    ".kill-on{background:#ef4444;color:white}.kill-off{background:#22c55e;color:white}",
    ".sub{font-size:12px;color:rgba(255,255,255,0.3);margin-bottom:20px}",
    ".stats{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}",
    ".stat{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:12px 16px}",
    ".stat-val{font-size:22px;font-weight:700}.stat-lbl{font-size:10px;color:rgba(255,255,255,0.35);margin-top:2px}",
    "#sync{font-size:11px;color:rgba(255,255,255,0.2);margin-bottom:14px}",
    "table{width:100%;border-collapse:collapse;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;overflow:hidden;font-size:13px}",
    "th{padding:10px 14px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);border-bottom:1px solid rgba(255,255,255,0.07)}",
    "td{padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.05)}",
    "tr:last-child td{border-bottom:none}",
    ".badge{background:#a78bfa;color:white;font-size:9px;font-weight:700;padding:2px 6px;border-radius:999px;margin-left:4px}",
    ".verified{background:#22c55e;color:white;font-size:9px;font-weight:700;padding:2px 6px;border-radius:999px;margin-left:4px}",
    ".av{width:34px;height:34px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:8px}",
    ".av-init{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#ec4899);display:inline-flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:11px;margin-right:8px;vertical-align:middle}",
    ".pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;margin-right:5px;animation:pu 1.2s infinite}",
    "@keyframes pu{0%,100%{opacity:1}50%{opacity:.3}}",
    ".dead{display:inline-block;width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.2);margin-right:5px}",
    ".delbtn{background:#ef4444;color:white;border:none;border-radius:7px;padding:5px 12px;cursor:pointer;font-size:11px;font-weight:600}",
    ".prog{height:2px;background:rgba(255,255,255,0.08);border-radius:999px;margin-top:4px;width:100px}",
    ".progfill{height:100%;background:linear-gradient(90deg,#a78bfa,#ec4899);border-radius:999px}",
    ".empty{padding:32px;text-align:center;color:rgba(255,255,255,0.3);font-size:13px}",
    ".mbar{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#fca5a5}",
    ".tabs{display:flex;gap:8px;margin-bottom:20px}",
    ".tab-btn{padding:8px 18px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.5);font-size:13px;font-weight:600;cursor:pointer}",
    ".tab-btn.active{background:rgba(167,139,250,0.15);border-color:rgba(167,139,250,0.4);color:#a78bfa}",
    ".ip-row{font-size:12px}",
    ".dtag{display:inline-block;background:rgba(255,255,255,0.07);border-radius:6px;padding:2px 8px;font-size:11px;color:rgba(255,255,255,0.5);margin-top:3px}",
    "#mb{display:none}",
    "#gate{display:none;position:fixed;inset:0;background:#050508;z-index:9999;flex-direction:column;align-items:center;justify-content:center;gap:20px}",
    "#app{display:none}",
    "#pinput{background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:14px;color:white;font-size:18px;letter-spacing:4px;padding:14px 20px;width:240px;text-align:center;outline:none}",
    "#perr{display:none;color:#ef4444;font-size:13px;font-weight:600}",
    ".gbtn{background:linear-gradient(135deg,#a78bfa,#818cf8);border:none;border-radius:14px;color:white;font-size:15px;font-weight:700;padding:14px 40px;cursor:pointer}",
    "</style></head><body>",
    "<div id='gate'>",
    "<div style='text-align:center'>",
    "<div style='width:70px;height:70px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#818cf8);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 30px rgba(167,139,250,0.4);font-size:28px'>&#128272;</div>",
    "<div style='color:#a78bfa;font-size:11px;font-weight:700;letter-spacing:2px;margin-bottom:6px'>RESTRICTED ACCESS</div>",
    "<div style='color:white;font-size:24px;font-weight:800'>Timmys Layer</div>",
    "<div style='color:rgba(255,255,255,0.35);font-size:13px;margin-top:4px'>Enter your password to continue</div>",
    "</div>",
    "<input id='pinput' type='password' placeholder='Password' />",
    "<div id='perr'>Wrong password</div>",
    "<button class='gbtn' onclick='submitPass()'>Enter</button>",
    "</div>",
    "<div id='app'>",
    "<div class='header'><div class='logo'>Timmys Layer</div>",
    "<button class='killbtn kill-on' id='killbtn' onclick='toggleKill()'>Kill App</button></div>",
    "<div class='sub' id='sync'>Loading...</div>",
    "<div class='mbar' id='mb'>App is currently OFFLINE</div>",
    "<div class='stats' id='stats'></div>",
    "<div class='tabs'>",
    "<button class='tab-btn active' data-tab='profiles' onclick='switchTab(this)'>Profiles</button>",
    "<button class='tab-btn' data-tab='iplog' onclick='switchTab(this)'>Visitor Log</button>",
    "</div>",
    "<div id='table'></div>",
    "</div>",
    "<script>",
    "var B='/admin/timmy-dev-backdoor-9x2k',P='102408',cur='profiles',online=true;",
    "function chk(){var s=sessionStorage.getItem('tl');if(s===P){document.getElementById('gate').style.display='none';document.getElementById('app').style.display='block';load();}else document.getElementById('gate').style.display='flex';}",
    "function submitPass(){var v=document.getElementById('pinput').value;if(v===P){sessionStorage.setItem('tl',P);chk();}else{document.getElementById('perr').style.display='block';document.getElementById('pinput').value='';}}",
    "document.addEventListener('DOMContentLoaded',function(){chk();document.getElementById('pinput').addEventListener('keydown',function(e){if(e.key==='Enter')submitPass();});});",
    "function switchTab(btn){cur=btn.dataset.tab;document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.toggle('active',b===btn);});cur==='profiles'?load():loadLog();}",
    "async function load(){try{var r=await fetch(B+'/data?t='+Date.now()),d=await r.json();online=d.online;var kb=document.getElementById('killbtn'),mb=document.getElementById('mb');if(online){kb.textContent='Kill App';kb.className='killbtn kill-on';mb.style.display='none';}else{kb.textContent='Bring Back Online';kb.className='killbtn kill-off';mb.style.display='block';}rStats(d);if(cur==='profiles')rTable(d);document.getElementById('sync').textContent='Last sync: '+new Date().toLocaleTimeString();}catch(e){}}",
    "function rStats(d){document.getElementById('stats').innerHTML='<div class=stat><div class=stat-val>'+d.profileCount+'</div><div class=stat-lbl>Profiles</div></div><div class=stat><div class=stat-val>'+d.liveCount+'</div><div class=stat-lbl>Live Spotify</div></div><div class=stat><div class=stat-val>'+d.verifiedCount+'</div><div class=stat-lbl>Verified</div></div><div class=stat><div class=stat-val>'+d.sessionCount+'</div><div class=stat-lbl>Sessions</div></div>';}",
    "function rTable(d){if(!d.profiles||!d.profiles.length){document.getElementById('table').innerHTML='<div class=empty>No profiles yet</div>';return;}",
    "var rows=d.profiles.map(function(p){",
    "var av=p.avatar?'<img class=av src='+p.avatar+'>':'<div class=av-init>'+p.ownerCode.slice(0,2)+'</div>';",
    "var badge=p.badge?'<span class=badge>'+p.badge+'</span>':'';",
    "var ver=p.verified?'<span class=verified>verified</span>':'';",
    "var live=p.isLive?'<span class=pulse></span>live':'<span class=dead></span><span style=\"color:rgba(255,255,255,0.3)\">offline</span>';",
    "var song=p.song||'<span style=\"color:rgba(255,255,255,0.2)\">nothing</span>';",
    "var prog=p.progressPct?'<div class=prog><div class=progfill style=\"width:'+p.progressPct+'%\"></div></div>':'';",
    "var em=p.email?'<div style=\"font-size:11px;color:rgba(255,255,255,0.35)\">'+p.email+'</div>':'';",
    "return '<tr><td>'+av+'<b>'+p.ownerCode+'</b>'+badge+ver+em+'</td><td style=\"color:rgba(255,255,255,0.6)\">'+(p.status||'-')+'</td><td>'+song+prog+'</td><td>'+live+'</td><td><button class=delbtn onclick=\"del(this)\" data-code='+p.ownerCode+'>Delete</button></td></tr>';",
    "}).join('');",
    "document.getElementById('table').innerHTML='<table><thead><tr><th>User</th><th>Note</th><th>Now Playing</th><th>Status</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>';}",
    "function parseDevice(ua){if(!ua)return'Unknown';if(/iPhone/.test(ua)){var m=ua.match(/iPhone OS ([\\d_]+)/);return'iPhone'+(m?' iOS '+m[1].replace(/_/g,'.'):'');}if(/iPad/.test(ua))return'iPad';if(/Android/.test(ua)){var m2=ua.match(/Android ([\\d.]+)/);return'Android'+(m2?' '+m2[1]:'');}if(/Mac/.test(ua))return'Mac';if(/Windows/.test(ua))return'Windows';return ua.slice(0,30);}",
    "async function loadLog(){var r=await fetch(B+'/iplog'),logs=await r.json();if(!logs.length){document.getElementById('table').innerHTML='<div class=empty>No visitors yet</div>';return;}",
    "var rows=logs.map(function(e){var t=new Date(e.ts).toLocaleTimeString(),dd=new Date(e.ts).toLocaleDateString();var dev=parseDevice(e.userAgent);var loc=(e.city||e.region||e.country)?[e.city,e.region,e.country].filter(Boolean).join(', '):'...';",
    "return '<tr class=ip-row><td><b style=\"font-family:monospace\">'+e.ip+'</b><div style=\"font-size:11px;color:rgba(255,255,255,0.4);margin-top:2px\">&#128205; '+loc+'</div></td><td><b>'+dev+'</b><div class=dtag>'+e.userAgent.slice(0,60)+'</div></td><td style=\"color:#a78bfa\"><code>'+(e.ownerCode||'-')+'</code></td><td style=\"color:rgba(255,255,255,0.4)\">'+e.path+'</td><td style=\"color:rgba(255,255,255,0.3);font-size:11px\">'+dd+' '+t+'</td></tr>';",
    "}).join('');",
    "document.getElementById('table').innerHTML='<table><thead><tr><th>IP + Location</th><th>Device</th><th>Code</th><th>Endpoint</th><th>Time</th></tr></thead><tbody>'+rows+'</tbody></table>';}",
    "async function toggleKill(){if(online){if(!confirm('Kill the app?'))return;}await fetch(B+'/killswitch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({online:!online})});load();}",
    "function del(btn){var code=btn.dataset.code;if(!confirm('Delete '+code+'?'))return;fetch(B+'/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})}).then(function(){load();});}",
    "load();setInterval(function(){if(cur==='profiles')load();else loadLog();},3000);",
    "<\/script></body></html>"
  ].join(""));
});

app.get("/admin/timmy-dev-backdoor-9x2k/data", function(req, res) {
  var allProfiles = Array.from(profilesStore.values());
  var allSessions = Array.from(sessions.values());
  return res.json({
    online: APP_ONLINE,
    profileCount: allProfiles.length,
    liveCount: allSessions.filter(function(s) { return s.refreshToken; }).length,
    verifiedCount: allProfiles.filter(function(p) { return p.verified; }).length,
    sessionCount: sessions.size,
    friendCount: Array.from(friends.values()).reduce(function(t, s) { return t + s.size; }, 0),
    profiles: allProfiles.map(function(p) {
      var session = sessions.get(p.ownerCode);
      var song = null; var progressPct = 0;
      if (session && session.currentSong && session.currentSong.songTitle) {
        song = session.currentSong.songTitle + " - " + session.currentSong.artistNames;
        if (session.currentSong.durationMs > 0) progressPct = Math.round((session.currentSong.progressMs / session.currentSong.durationMs) * 100);
      }
      return { ownerCode: p.ownerCode, avatar: p.avatar || null, status: p.status || "", badge: p.badge || "", email: p.email || "", phone: p.phone || "", verified: !!p.verified, isLive: !!(session && session.refreshToken), song: song, progressPct: progressPct };
    })
  });
});

app.post("/admin/timmy-dev-backdoor-9x2k/killswitch", function(req, res) {
  var online = req.body && req.body.online;
  APP_ONLINE = Boolean(online);
  console.log("[admin] Kill switch: app is now " + (APP_ONLINE ? "ONLINE" : "OFFLINE"));
  return res.json({ ok: true, online: APP_ONLINE });
});

app.post("/admin/timmy-dev-backdoor-9x2k/delete", function(req, res) {
  var code = String((req.body && req.body.code) || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Missing code" });
  profilesStore.delete(code);
  sessions.delete(code);
  console.log("[admin] Deleted " + code);
  return res.json({ ok: true, deleted: code });
});

app.get("/admin/timmy-dev-backdoor-9x2k/iplog", function(req, res) {
  return res.json(ipLog.slice(0, 200));
});

app.get("/health", function(req, res) {
  var all = Array.from(sessions.values());
  return res.json({ ok: true, online: APP_ONLINE, sessionCount: sessions.size, polledUsers: all.filter(function(s) { return s.refreshToken; }).length, appOnlyUsers: all.filter(function(s) { return !s.refreshToken; }).length, friendCount: Array.from(friends.values()).reduce(function(t, s) { return t + s.size; }, 0), pollIntervalMs: POLL_INTERVAL_MS });
});

app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
  startPoller();
});
