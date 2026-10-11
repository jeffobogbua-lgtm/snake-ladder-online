const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ACCESS_STORE_PATH = process.env.ACCESS_STORE_PATH || path.join(__dirname, "data", "access-store.json");
const accessSessions = new Map();

function readAccessStore() {
  try {
    const d = JSON.parse(fs.readFileSync(ACCESS_STORE_PATH, "utf8"));
    return { tokens: Array.isArray(d.tokens) ? d.tokens : [], redemptions: Array.isArray(d.redemptions) ? d.redemptions : [] };
  } catch { return { tokens: [], redemptions: [] }; }
}
let accessStore = readAccessStore();
function saveAccessStore() {
  fs.mkdirSync(path.dirname(ACCESS_STORE_PATH), { recursive: true });
  const tmp = ACCESS_STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(accessStore, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ACCESS_STORE_PATH);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || "")), bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function cleanToken(v) {
  return typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 48) : "";
}
function validSession(token) {
  const s = accessSessions.get(token);
  if (!s || s.expiresAt <= Date.now()) { if (token) accessSessions.delete(token); return null; }
  return s;
}
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const RECONNECT_GRACE_MS = 2 * 60 * 1000;
const rooms = new Map();
const reconnectSlots = new Map();

const SNAKES = Object.freeze({
  16: 6, 47: 26, 49: 11, 56: 53, 62: 19,
  64: 60, 87: 24, 93: 73, 95: 75, 98: 78
});
const LADDERS = Object.freeze({
  1: 38, 4: 14, 9: 31, 21: 42, 28: 84,
  36: 44, 51: 67, 71: 91, 80: 100
});

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(express.json({ limit: "20kb" }));

app.post("/api/redeem", (req, res) => {
  const code = cleanToken(req.body?.token);
  const name = cleanName(req.body?.name);
  if (!code) return res.status(400).json({ ok: false, error: "Enter your access token." });
  if (!name) return res.status(400).json({ ok: false, error: "Choose a player name." });
  const record = accessStore.tokens.find(t => t.code === code);
  if (!record) return res.status(403).json({ ok: false, error: "That token is invalid." });
  if (record.redeemedAt) return res.status(403).json({ ok: false, error: "That token has already been used." });
  if (record.revokedAt) return res.status(403).json({ ok: false, error: "That token has been revoked." });
  if (record.redeemBy <= Date.now()) return res.status(403).json({ ok: false, error: "That token has expired. Request a new one on WhatsApp." });
  const now = Date.now();
  record.redeemedAt = now;
  record.redeemedBy = name;
  record.accessExpiresAt = now + record.accessDurationMs;
  accessStore.redemptions.push({ tokenId: record.id, name, redeemedAt: now, accessExpiresAt: record.accessExpiresAt });
  saveAccessStore();
  const sessionToken = crypto.randomBytes(32).toString("hex");
  accessSessions.set(sessionToken, { name, expiresAt: record.accessExpiresAt, tokenId: record.id });
  res.json({ ok: true, accessToken: sessionToken, name, expiresAt: record.accessExpiresAt });
});

app.get("/api/access-status", (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer\\s+/i, "");
  const session = validSession(token);
  if (!session) return res.status(401).json({ ok: false, error: "Access expired. Redeem a new token." });
  res.json({ ok: true, name: session.name, expiresAt: session.expiresAt });
});

app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ ok: false, error: "Admin access is not configured. Set ADMIN_PASSWORD in your hosting environment." });
  if (!safeEqual(req.body?.password, ADMIN_PASSWORD)) return res.status(401).json({ ok: false, error: "Incorrect admin password." });
  const token = crypto.randomBytes(32).toString("hex");
  accessSessions.set("admin:" + token, { admin: true, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  res.json({ ok: true, adminToken: token });
});
function requireAdmin(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\\s+/i, "");
  const session = validSession("admin:" + token);
  if (!session?.admin) return res.status(401).json({ ok: false, error: "Admin login required." });
  next();
}
app.get("/api/admin/tokens", requireAdmin, (_req, res) => {
  res.json({ ok: true, tokens: accessStore.tokens.map(({ code, createdAt, redeemBy, accessDurationMs, redeemedAt, redeemedBy, accessExpiresAt, revokedAt }) => ({ code, createdAt, redeemBy, accessDurationMs, redeemedAt, redeemedBy, accessExpiresAt, revokedAt })) });
});
app.post("/api/admin/tokens", requireAdmin, (req, res) => {
  const redeemHours = Number(req.body?.redeemHours), accessHours = Number(req.body?.accessHours);
  if (!Number.isFinite(redeemHours) || redeemHours <= 0 || redeemHours > 8760) return res.status(400).json({ ok: false, error: "Token redemption validity must be 1–8760 hours." });
  if (!Number.isFinite(accessHours) || accessHours <= 0 || accessHours > 8760) return res.status(400).json({ ok: false, error: "Access duration must be 1–8760 hours." });
  let code;
  do { code = "EFE-" + crypto.randomBytes(5).toString("hex").toUpperCase(); } while (accessStore.tokens.some(t => t.code === code));
  const record = { id: crypto.randomUUID(), code, createdAt: Date.now(), redeemBy: Date.now() + redeemHours * 3600000, accessDurationMs: accessHours * 3600000, redeemedAt: null, redeemedBy: null, accessExpiresAt: null, revokedAt: null };
  accessStore.tokens.push(record); saveAccessStore();
  res.json({ ok: true, token: { code, createdAt: record.createdAt, redeemBy: record.redeemBy, accessDurationMs: record.accessDurationMs } });
});
app.post("/api/admin/revoke", requireAdmin, (req, res) => {
  const record = accessStore.tokens.find(t => t.code === cleanToken(req.body?.token));
  if (!record) return res.status(404).json({ ok: false, error: "Token not found." });
  record.revokedAt = Date.now(); saveAccessStore(); res.json({ ok: true });
});

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 18);
}

function cleanRoomCode(value) {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    currentTurn: room.currentTurn,
    winnerId: room.winnerId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      connected: Boolean(p.socketId),
      color: p.color
    })),
    lastMove: room.lastMove,
    chat: room.chat.slice(-40)
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}

function findPlayer(room, socketId) {
  return room.players.find((p) => p.socketId === socketId);
}

function chooseTurnAfterRemoval(room, removedIndex) {
  if (!room.players.length) {
    room.currentTurn = 0;
    return;
  }
  if (removedIndex < room.currentTurn) room.currentTurn -= 1;
  if (room.currentTurn >= room.players.length) room.currentTurn = 0;
}

function deleteRoom(room) {
  for (const player of room.players) {
    if (player.reconnectToken) reconnectSlots.delete(player.reconnectToken);
  }
  rooms.delete(room.code);
}

function nextConnectedTurn(room, fromIndex) {
  if (!room.players.length) return 0;
  for (let offset = 1; offset <= room.players.length; offset += 1) {
    const index = (fromIndex + offset) % room.players.length;
    if (room.players[index].socketId) return index;
  }
  return fromIndex % room.players.length;
}

function appendChat(room, player, message) {
  room.chat.push({
    id: crypto.randomUUID(),
    playerId: player ? player.id : "system",
    name: player ? player.name : "Game",
    message: String(message).slice(0, 240),
    at: Date.now()
  });
  if (room.chat.length > 100) room.chat.splice(0, room.chat.length - 100);
}

function systemMessage(room, message) {
  appendChat(room, null, message);
}

function leaveRoom(socket, options = {}) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  if (!room) return;

  const player = findPlayer(room, socket.id);
  socket.leave(code);
  if (!player) return;

  player.socketId = null;
  if (options.intentional) {
    const index = room.players.findIndex((p) => p.id === player.id);
    if (player.reconnectToken) reconnectSlots.delete(player.reconnectToken);
    room.players.splice(index, 1);
    chooseTurnAfterRemoval(room, index);
    if (room.hostId === player.id) room.hostId = room.players[0]?.id || null;
    systemMessage(room, `${player.name} left the room.`);
  } else {
    player.disconnectedAt = Date.now();
    systemMessage(room, `${player.name} disconnected. They have 2 minutes to reconnect.`);
    setTimeout(() => {
      const currentRoom = rooms.get(code);
      if (!currentRoom) return;
      const index = currentRoom.players.findIndex((p) => p.id === player.id);
      if (index < 0 || currentRoom.players[index].socketId || !player.disconnectedAt) return;
      const wasTurn = currentRoom.currentTurn === index;
      if (player.reconnectToken) reconnectSlots.delete(player.reconnectToken);
      currentRoom.players.splice(index, 1);
      chooseTurnAfterRemoval(currentRoom, index);
      if (currentRoom.hostId === player.id) currentRoom.hostId = currentRoom.players[0]?.id || null;
      if (wasTurn && currentRoom.players.length) {
        currentRoom.currentTurn = nextConnectedTurn(currentRoom, Math.max(-1, index - 1));
      }
      systemMessage(currentRoom, `${player.name} was removed after the reconnect timeout.`);
      if (!currentRoom.players.length) deleteRoom(currentRoom);
      else emitRoom(currentRoom);
    }, RECONNECT_GRACE_MS);
  }

  if (!room.players.length) {
    deleteRoom(room);
    return;
  }

  if (room.currentTurn >= room.players.length) room.currentTurn = 0;
  emitRoom(room);
}

function joinSocket(socket, room, player) {
  player.socketId = socket.id;
  player.disconnectedAt = null;
  socket.data.roomCode = room.code;
  socket.join(room.code);
}

io.use((socket, next) => {
  const bearer = typeof socket.handshake.auth?.accessToken === "string" ? socket.handshake.auth.accessToken : "";
  const session = validSession(bearer);
  if (!session) return next(new Error("Access required. Redeem a valid token first."));
  socket.data.accessName = session.name;
  socket.data.accessExpiresAt = session.expiresAt;
  next();
});

io.on("connection", (socket) => {
  const accessExpiryTimer = setTimeout(() => {
    socket.emit("access:expired");
    socket.disconnect(true);
  }, Math.min(Math.max(0, socket.data.accessExpiresAt - Date.now()), 2147483647));
  socket.on("disconnect", () => clearTimeout(accessExpiryTimer));
  socket.on("room:create", (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const name = cleanName(payload?.name);
    if (!name) return reply({ ok: false, error: "Enter a player name first." });

    const code = makeRoomCode();
    const player = {
      id: crypto.randomUUID(),
      name,
      position: 0,
      socketId: socket.id,
      reconnectToken: crypto.randomBytes(24).toString("hex"),
      disconnectedAt: null,
      color: 0
    };
    const room = {
      code,
      status: "waiting",
      hostId: player.id,
      players: [player],
      currentTurn: 0,
      winnerId: null,
      lastMove: null,
      chat: [],
      createdAt: Date.now()
    };
    rooms.set(code, room);
    reconnectSlots.set(player.reconnectToken, { roomCode: code, playerId: player.id });
    joinSocket(socket, room, player);
    reply({ ok: true, code, playerId: player.id, reconnectToken: player.reconnectToken });
    emitRoom(room);
  });

  socket.on("room:join", (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const name = cleanName(payload?.name);
    const code = cleanRoomCode(payload?.code);
    const room = rooms.get(code);
    if (!name) return reply({ ok: false, error: "Enter a player name first." });
    if (!room) return reply({ ok: false, error: "Room not found. Check the code." });
    if (room.status !== "waiting") return reply({ ok: false, error: "This game has already started." });
    if (room.players.length >= MAX_PLAYERS) return reply({ ok: false, error: "This room is full." });

    const player = {
      id: crypto.randomUUID(),
      name,
      position: 0,
      socketId: socket.id,
      reconnectToken: crypto.randomBytes(24).toString("hex"),
      disconnectedAt: null,
      color: room.players.length
    };
    room.players.push(player);
    reconnectSlots.set(player.reconnectToken, { roomCode: code, playerId: player.id });
    joinSocket(socket, room, player);
    systemMessage(room, `${name} joined the room.`);
    reply({ ok: true, code, playerId: player.id, reconnectToken: player.reconnectToken });
    emitRoom(room);
  });

  socket.on("room:reconnect", (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const token = typeof payload?.reconnectToken === "string" ? payload.reconnectToken : "";
    const slot = reconnectSlots.get(token);
    if (!slot) return reply({ ok: false, error: "Your previous session can no longer be restored. Join the room again." });
    const room = rooms.get(slot.roomCode);
    const player = room?.players.find((p) => p.id === slot.playerId);
    if (!room || !player || player.socketId || !player.disconnectedAt) {
      return reply({ ok: false, error: "That player session is no longer available." });
    }
    if (Date.now() - player.disconnectedAt > RECONNECT_GRACE_MS) {
      reconnectSlots.delete(token);
      return reply({ ok: false, error: "The reconnect window has expired. Join the room again." });
    }
    joinSocket(socket, room, player);
    systemMessage(room, `${player.name} reconnected.`);
    reply({ ok: true, code: room.code, playerId: player.id, reconnectToken: token });
    emitRoom(room);
  });

  socket.on("game:start", (_payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const room = rooms.get(socket.data.roomCode);
    const player = room && findPlayer(room, socket.id);
    if (!room || !player) return reply({ ok: false, error: "Join a room first." });
    if (room.hostId !== player.id) return reply({ ok: false, error: "Only the host can start the game." });
    if (room.status !== "waiting") return reply({ ok: false, error: "The game has already started." });
    if (room.players.length < MIN_PLAYERS) return reply({ ok: false, error: "You need at least 2 players to start." });
    room.status = "playing";
    room.currentTurn = 0;
    room.winnerId = null;
    room.players.forEach((p) => { p.position = 0; });
    room.lastMove = null;
    systemMessage(room, "The game has started!");
    reply({ ok: true });
    emitRoom(room);
  });

  socket.on("game:roll", (_payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const room = rooms.get(socket.data.roomCode);
    const player = room && findPlayer(room, socket.id);
    if (!room || !player) return reply({ ok: false, error: "Join a room first." });
    if (room.status !== "playing") return reply({ ok: false, error: "The game is not in progress." });
    if (room.winnerId) return reply({ ok: false, error: "The game has already ended." });
    const current = room.players[room.currentTurn];
    if (!current || current.id !== player.id) return reply({ ok: false, error: "It is not your turn." });

    const roll = crypto.randomInt(1, 7);
    const from = player.position;
    let landed = from;
    let event = null;
    if (from === 0) {
      if (roll === 6) landed = 1;
    } else if (from + roll <= 100) {
      landed = from + roll;
    }

    if (landed > 0 && SNAKES[landed]) {
      event = { type: "snake", from: landed, to: SNAKES[landed] };
      landed = SNAKES[landed];
    } else if (landed > 0 && LADDERS[landed]) {
      event = { type: "ladder", from: landed, to: LADDERS[landed] };
      landed = LADDERS[landed];
    }

    player.position = landed;
    room.lastMove = {
      playerId: player.id,
      playerName: player.name,
      roll,
      from,
      landed: event ? event.from : landed,
      to: landed,
      event,
      at: Date.now()
    };

    if (landed === 100) {
      room.winnerId = player.id;
      room.status = "finished";
      systemMessage(room, `${player.name} won the game!`);
    } else {
      room.currentTurn = nextConnectedTurn(room, room.currentTurn);
      const summary = from === 0 && roll !== 6
        ? `${player.name} rolled ${roll}; a 6 is needed to enter.`
        : event?.type === "snake"
          ? `${player.name} rolled ${roll} and slid down a snake to ${landed}.`
          : event?.type === "ladder"
            ? `${player.name} rolled ${roll} and climbed a ladder to ${landed}!`
            : `${player.name} rolled ${roll} and moved to ${landed}.`;
      systemMessage(room, summary);
    }

    reply({ ok: true, roll });
    emitRoom(room);
  });

  socket.on("game:restart", (_payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const room = rooms.get(socket.data.roomCode);
    const player = room && findPlayer(room, socket.id);
    if (!room || !player) return reply({ ok: false, error: "Join a room first." });
    if (room.hostId !== player.id) return reply({ ok: false, error: "Only the host can restart the game." });
    room.status = "waiting";
    room.currentTurn = 0;
    room.winnerId = null;
    room.lastMove = null;
    room.players.forEach((p) => { p.position = 0; });
    systemMessage(room, "The host reset the game. Start when everyone is ready.");
    reply({ ok: true });
    emitRoom(room);
  });

  socket.on("chat:send", (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const room = rooms.get(socket.data.roomCode);
    const player = room && findPlayer(room, socket.id);
    const message = typeof payload?.message === "string"
      ? payload.message.replace(/[<>]/g, "").trim().slice(0, 240)
      : "";
    if (!room || !player) return reply({ ok: false, error: "Join a room first." });
    if (!message) return reply({ ok: false, error: "Type a message first." });
    appendChat(room, player, message);
    reply({ ok: true });
    emitRoom(room);
  });

  socket.on("room:leave", (_payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    leaveRoom(socket, { intentional: true });
    reply({ ok: true });
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Snake & Ladder Online listening on port ${PORT}`);
});
