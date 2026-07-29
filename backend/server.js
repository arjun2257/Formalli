"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

// Load backend/.env only when a variable is not already supplied by Render.
const envFilePath = path.join(__dirname, ".env");
if (fs.existsSync(envFilePath)) {
  for (const rawLine of fs.readFileSync(envFilePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

const isProduction = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 5000);
const ROOM = "formalli-private-room";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const VIDEO_REQUEST_TTL_MS = 5 * 60 * 1000;
const VIDEO_ACCESS_TTL_MS = 15 * 60 * 1000;
const HISTORY_LIMIT = 200;

const readEnv = (name, fallback = "") => String(process.env[name] || fallback).trim();

const LOCAL_PASSWORDS = Object.freeze({ green: "W@||!@", malli: "MALLI" });
const SESSION_SECRET = readEnv(
  "SESSION_SECRET",
  isProduction ? "" : "formalli-local-session-secret-change-in-production"
);
const GOOGLE_MEET_URL = readEnv(
  "GOOGLE_MEET_URL",
  "https://meet.google.com/crj-cusk-uds"
);
const ALLOW_VERCEL_PREVIEWS = readEnv("ALLOW_VERCEL_PREVIEWS", "false") === "true";

const users = Object.freeze({
  green: {
    username: "green",
    password: readEnv("GREEN_PASSWORD", isProduction ? "" : LOCAL_PASSWORDS.green),
    displayName: "Green",
    color: "#00ff5a"
  },
  malli: {
    username: "malli",
    password: readEnv("MALLI_PASSWORD", isProduction ? "" : LOCAL_PASSWORDS.malli),
    displayName: "Blue",
    color: "#20bfff"
  }
});

if (isProduction) {
  const missing = [];
  if (!users.green.password) missing.push("GREEN_PASSWORD");
  if (!users.malli.password) missing.push("MALLI_PASSWORD");
  if (!SESSION_SECRET) missing.push("SESSION_SECRET");
  if (missing.length) throw new Error(`Missing production variables: ${missing.join(", ")}`);
}

const isValidMeetUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "meet.google.com";
  } catch {
    return false;
  }
};
if (!isValidMeetUrl(GOOGLE_MEET_URL)) {
  throw new Error("GOOGLE_MEET_URL must be an https://meet.google.com URL");
}

const allowedOrigins = new Set(
  [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...readEnv("ALLOWED_ORIGINS")
      .split(",")
      .map((value) => value.trim().replace(/\/$/, ""))
      .filter(Boolean)
  ]
);

const isLanOrigin = (origin) => {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return (
      ["http:", "https:"].includes(url.protocol) &&
      (host === "localhost" ||
        host === "127.0.0.1" ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host))
    );
  } catch {
    return false;
  }
};

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  const normalized = origin.replace(/\/$/, "");
  if (allowedOrigins.has(normalized)) return true;
  if (!isProduction && isLanOrigin(normalized)) return true;
  if (
    ALLOW_VERCEL_PREVIEWS &&
    /^https:\/\/[a-z0-9-]+(?:-[a-z0-9-]+)*\.vercel\.app$/i.test(normalized)
  ) {
    return true;
  }
  return false;
};

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400
};

const base64url = (value) => Buffer.from(value).toString("base64url");

const signToken = (username) => {
  const payload = base64url(
    JSON.stringify({ sub: username, exp: Date.now() + TOKEN_TTL_MS })
  );
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
};

const verifyToken = (token) => {
  const [payloadPart, signaturePart] = String(token || "").split(".");
  if (!payloadPart || !signaturePart) throw new Error("Invalid token");

  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payloadPart)
    .digest("base64url");

  const actualBuffer = Buffer.from(signaturePart);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid signature");
  }

  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  const username = String(payload.sub || "").toLowerCase();
  if (!users[username] || Number(payload.exp) <= Date.now()) throw new Error("Expired token");
  return users[username];
};

const passwordsMatch = (provided, configured) => {
  const providedBuffer = Buffer.from(String(provided));
  const configuredBuffer = Buffer.from(String(configured));
  return (
    providedBuffer.length === configuredBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, configuredBuffer)
  );
};

const loginAttempts = new Map();
const canAttemptLogin = (ip) => {
  const now = Date.now();
  const current = loginAttempts.get(ip) || { count: 0, resetAt: now + 10 * 60 * 1000 };
  if (current.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return true;
  }
  if (current.count >= 30) return false;
  current.count += 1;
  loginAttempts.set(ip, current);
  return true;
};

const app = express();
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(cors(corsOptions));
app.use(express.json({ limit: "24kb" }));

app.get("/", (_req, res) => {
  res.json({ service: "ForMalli backend", status: "running", version: "2.0.0" });
});
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});
app.get("/api/config", (_req, res) => {
  res.json({ version: "2.0.0", meetConfigured: true });
});
app.post("/api/login", (req, res) => {
  if (!canAttemptLogin(req.ip)) {
    return res.status(429).json({ message: "Too many attempts. Try again later." });
  }

  const username = String(req.body?.username || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = users[username];
  if (!user || !passwordsMatch(password, user.password)) {
    return res.status(401).json({ message: "Invalid username or password." });
  }

  return res.json({
    token: signToken(username),
    user: {
      username: user.username,
      displayName: user.displayName,
      color: user.color
    }
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
  transports: ["polling", "websocket"],
  allowUpgrades: true,
  pingInterval: 25000,
  pingTimeout: 30000,
  maxHttpBufferSize: 64 * 1024
});

const activeSockets = new Map([
  ["green", new Set()],
  ["malli", new Set()]
]);
const notificationEnabledSockets = new Set();
const messages = [];
const videoRequests = new Map();
const videoAccess = new Map();

const partnerOf = (username) => (username === "green" ? "malli" : "green");
const emitToUser = (username, event, payload, onlyNotificationsEnabled = false) => {
  let delivered = 0;
  for (const socketId of activeSockets.get(username) || []) {
    if (onlyNotificationsEnabled && !notificationEnabledSockets.has(socketId)) continue;
    io.to(socketId).emit(event, payload);
    delivered += 1;
  }
  return delivered;
};
const presence = () => ({
  green: activeSockets.get("green").size > 0,
  malli: activeSockets.get("malli").size > 0
});

io.use((socket, next) => {
  try {
    socket.data.user = verifyToken(socket.handshake.auth?.token);
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

const sendExistingVideoState = (socket) => {
  const username = socket.data.user.username;
  const now = Date.now();

  for (const request of videoRequests.values()) {
    if (request.expiresAt > now && request.recipientUsername === username) {
      socket.emit("video-call-request", {
        requestId: request.requestId,
        from: request.requesterDisplayName,
        expiresAt: request.expiresAt
      });
    }
  }

  for (const access of videoAccess.values()) {
    if (access.expiresAt > now && access.usernames.includes(username)) {
      socket.emit("video-call-approved", access);
    }
  }
};

io.on("connection", (socket) => {
  const user = socket.data.user;
  const username = user.username;
  const userSockets = activeSockets.get(username);
  userSockets.add(socket.id);
  socket.join(ROOM);

  console.log(`[connect] ${username} ${socket.id}`);
  socket.emit("chat-history", messages);
  sendExistingVideoState(socket);
  io.to(ROOM).emit("presence-state", presence());

  socket.on("notification-settings", (data, acknowledge = () => {}) => {
    if (data?.enabled === true) notificationEnabledSockets.add(socket.id);
    else notificationEnabledSockets.delete(socket.id);
    acknowledge({ ok: true, enabled: notificationEnabledSockets.has(socket.id) });
  });

  socket.on("send-message", (data, acknowledge = () => {}) => {
    const text = String(data?.message || "").trim().slice(0, 2000);
    if (!text) return acknowledge({ ok: false, message: "Message cannot be empty." });

    const payload = {
      id: crypto.randomUUID(),
      username,
      sender: user.displayName,
      color: user.color,
      message: text,
      time: new Date().toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }),
      sentAt: new Date().toISOString()
    };

    messages.push(payload);
    if (messages.length > HISTORY_LIMIT) messages.shift();
    io.to(ROOM).emit("receive-message", payload);
    acknowledge({ ok: true, id: payload.id });
  });

  socket.on("i-am-online", (_data, acknowledge = () => {}) => {
    const recipient = partnerOf(username);
    const payload = {
      title: "ForMalli",
      message: `${user.displayName} is online now.`,
      from: user.displayName,
      sentAt: new Date().toISOString()
    };

    const delivered = emitToUser(recipient, "online-notification", payload, true);
    acknowledge({
      ok: true,
      delivered,
      message:
        delivered > 0
          ? "Chrome notification sent to the enabled device."
          : "Partner is offline or notifications are not enabled on their open app."
    });
  });

  socket.on("request-video-call", (_data, acknowledge = () => {}) => {
    const recipientUsername = partnerOf(username);
    if (activeSockets.get(recipientUsername).size === 0) {
      return acknowledge({ ok: false, message: "Partner is offline. Ask them to open ForMalli first." });
    }

    for (const [id, request] of videoRequests.entries()) {
      if (request.requesterUsername === username) videoRequests.delete(id);
    }

    const requestId = crypto.randomUUID();
    const request = {
      requestId,
      requesterUsername: username,
      requesterDisplayName: user.displayName,
      recipientUsername,
      expiresAt: Date.now() + VIDEO_REQUEST_TTL_MS
    };
    videoRequests.set(requestId, request);

    const payload = {
      requestId,
      from: user.displayName,
      expiresAt: request.expiresAt
    };
    emitToUser(recipientUsername, "video-call-request", payload);

    acknowledge({ ok: true, message: "Video request sent. Waiting for admission." });
  });

  socket.on("admit-video-call", (data, acknowledge = () => {}) => {
    const requestId = String(data?.requestId || "");
    const request = videoRequests.get(requestId);
    if (!request || request.expiresAt <= Date.now()) {
      videoRequests.delete(requestId);
      return acknowledge({ ok: false, message: "Video request expired." });
    }
    if (request.recipientUsername !== username) {
      return acknowledge({ ok: false, message: "You cannot admit this request." });
    }

    videoRequests.delete(requestId);
    const access = {
      requestId,
      meetUrl: GOOGLE_MEET_URL,
      requester: request.requesterDisplayName,
      admittedBy: user.displayName,
      usernames: [request.requesterUsername, request.recipientUsername],
      expiresAt: Date.now() + VIDEO_ACCESS_TTL_MS
    };
    videoAccess.set(requestId, access);

    emitToUser(request.requesterUsername, "video-call-approved", access);
    emitToUser(request.recipientUsername, "video-call-approved", access);
    acknowledge({ ok: true, access });
  });

  socket.on("reject-video-call", (data, acknowledge = () => {}) => {
    const requestId = String(data?.requestId || "");
    const request = videoRequests.get(requestId);
    if (!request || request.recipientUsername !== username) {
      return acknowledge({ ok: false, message: "Video request is no longer active." });
    }

    videoRequests.delete(requestId);
    emitToUser(request.requesterUsername, "video-call-rejected", {
      requestId,
      rejectedBy: user.displayName
    });
    acknowledge({ ok: true });
  });

  socket.on("disconnect", (reason) => {
    userSockets.delete(socket.id);
    notificationEnabledSockets.delete(socket.id);
    io.to(ROOM).emit("presence-state", presence());
    console.log(`[disconnect] ${username} ${socket.id} (${reason})`);
  });
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, request] of videoRequests.entries()) {
    if (request.expiresAt <= now) videoRequests.delete(id);
  }
  for (const [id, access] of videoAccess.entries()) {
    if (access.expiresAt <= now) videoAccess.delete(id);
  }
  for (const [ip, attempt] of loginAttempts.entries()) {
    if (attempt.resetAt <= now) loginAttempts.delete(ip);
  }
}, 30000);
cleanupTimer.unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ForMalli backend running on 0.0.0.0:${PORT}`);
  console.log(`Mode: ${isProduction ? "production" : "development"}`);
  console.log(`Meet: ${GOOGLE_MEET_URL}`);
  console.log(`Allowed origins: ${[...allowedOrigins].join(", ")}`);
});

const shutdown = () => {
  clearInterval(cleanupTimer);
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
