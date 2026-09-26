const http = require("node:http");
const crypto = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const SIGNAL_TYPES = new Set(["offer", "answer", "ice-candidate"]);
const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];
const MAX_SDP_LENGTH = 48 * 1024;
const MAX_CANDIDATE_LENGTH = 4096;

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function readConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const allowedOrigins = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const turnUrls = (env.TURN_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const turnSecret = env.TURN_SHARED_SECRET || "";

  if (production && allowedOrigins.length === 0) {
    throw new Error("ALLOWED_ORIGINS must be configured in production.");
  }
  if (production && turnSecret && Buffer.byteLength(turnSecret) < 32) {
    throw new Error("TURN_SHARED_SECRET must contain at least 32 bytes in production.");
  }
  for (const origin of allowedOrigins) {
    if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) continue;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("ALLOWED_ORIGINS must contain valid HTTP(S) origins.");
    }
    if (
      !/^https?:$/.test(parsed.protocol) ||
      parsed.origin !== origin ||
      (production && parsed.protocol !== "https:")
    ) {
      throw new Error("ALLOWED_ORIGINS must contain HTTPS or valid Chrome extension origins in production.");
    }
  }
  if (
    turnUrls.length > 8 ||
    turnUrls.some((url) => {
      try {
        return !["turn:", "turns:"].includes(new URL(url).protocol);
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("TURN_URLS must contain at most eight valid turn: or turns: URLs.");
  }
  if (Boolean(turnUrls.length) !== Boolean(turnSecret)) {
    throw new Error("TURN_URLS and TURN_SHARED_SECRET must be configured together.");
  }
  if (production && turnUrls.length === 0) {
    throw new Error("TURN_URLS and TURN_SHARED_SECRET are required in production.");
  }

  return {
    production,
    allowedOrigins: new Set(allowedOrigins),
    stunUrls: (env.STUN_URLS || DEFAULT_STUN_URLS.join(","))
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
    turnUrls,
    turnSecret,
    turnCredentialTtlSeconds: positiveInteger(
      env.TURN_CREDENTIAL_TTL_SECONDS,
      3600,
      3600,
    ),
    maxRooms: positiveInteger(env.MAX_ROOMS, 5000, 100000),
    maxConnections: positiveInteger(env.MAX_CONNECTIONS, 1000, 10000),
    heartbeatIntervalMs: positiveInteger(env.HEARTBEAT_INTERVAL_MS, 30000, 300000),
  };
}

function createIceServers(config, now = Date.now()) {
  const iceServers = config.stunUrls.map((url) => ({ urls: url }));
  if (config.turnUrls.length === 0) return iceServers;

  const expiresAt = Math.floor(now / 1000) + config.turnCredentialTtlSeconds;
  const username = `${expiresAt}:${crypto.randomBytes(12).toString("hex")}`;
  const credential = crypto
    .createHmac("sha1", config.turnSecret)
    .update(username)
    .digest("base64");
  iceServers.push({
    urls: config.turnUrls,
    username,
    credential,
  });
  return iceServers;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function isValidSignal(type, payload) {
  if (!SIGNAL_TYPES.has(type) || !isRecord(payload)) {
    return false;
  }

  if (type === "offer" || type === "answer") {
    return (
      hasOnlyKeys(payload, ["type", "sdp"]) &&
      (payload.type === "offer" || payload.type === "answer") &&
      typeof payload.sdp === "string" &&
      payload.sdp.length > 0 &&
      payload.sdp.length <= MAX_SDP_LENGTH
    );
  }

  return (
    hasOnlyKeys(payload, [
      "candidate",
      "sdpMid",
      "sdpMLineIndex",
      "usernameFragment",
    ]) &&
    typeof payload.candidate === "string" &&
    payload.candidate.length <= MAX_CANDIDATE_LENGTH &&
    (payload.sdpMid === undefined ||
      payload.sdpMid === null ||
      (typeof payload.sdpMid === "string" && payload.sdpMid.length <= 256)) &&
    (payload.sdpMLineIndex === undefined ||
      payload.sdpMLineIndex === null ||
      (Number.isInteger(payload.sdpMLineIndex) &&
        payload.sdpMLineIndex >= 0 &&
        payload.sdpMLineIndex <= 65535)) &&
    (payload.usernameFragment === undefined ||
      (typeof payload.usernameFragment === "string" &&
        payload.usernameFragment.length <= 256))
  );
}

function createSignalingServer(options = {}) {
  const config = readConfig(options.env || process.env);
  const maxRoomParticipants = positiveInteger(
    options.env?.MAX_ROOM_PARTICIPANTS || process.env.MAX_ROOM_PARTICIPANTS,
    10,
    100,
  );
  const rooms = new Map();
  const clients = new Set();
  const httpServer = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    response.writeHead(404);
    response.end("Not found");
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    const path = (request.url || "").split("?")[0];
    if (
      !["/signal", "/health", "/"].includes(path) ||
      (config.allowedOrigins.size > 0 && !config.allowedOrigins.has(origin)) ||
      (config.production && !origin)
    ) {
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  });

  webSocketServer.on("connection", (socket) => {
    if (clients.size >= config.maxConnections) {
      socket.close(1013, "Server is at capacity");
      return;
    }
    clients.add(socket);
    socket.isAlive = true;
    socket.peerId = crypto.randomBytes(8).toString("hex");
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.roomId = null;
    socket.role = null;
    socket.userId = null;   // persistent caller ID sent by the extension

    socket.on("message", (rawMessage, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Text messages only");
        return;
      }
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
      } catch {
        socket.close(1008, "Invalid JSON");
        return;
      }

      if (
        !isRecord(message) ||
        !hasOnlyKeys(message, [
          "type",
          "roomId",
          "userId",
          "displayName",
          "payload",
          "targetPeerId",
          "fromPeerId",
        ])
      ) {
        send(socket, { type: "error", message: "Invalid signaling message." });
        return;
      }

      if (message.type === "join") {
        if (
          socket.roomId ||
          !hasOnlyKeys(message, ["type", "roomId", "userId", "displayName"]) ||
          typeof message.roomId !== "string" ||
          !ROOM_ID_PATTERN.test(message.roomId)
        ) {
          send(socket, {
            type: "error",
            message:
              "Room codes must be 4-64 letters, numbers, dashes, or underscores.",
          });
          return;
        }

        let room = rooms.get(message.roomId);
        if (room?.length >= maxRoomParticipants) {
          send(socket, {
            type: "error",
            message: `That room is full (maximum ${maxRoomParticipants} participants).`,
          });
          return;
        }

        if (!room) {
          if (rooms.size >= config.maxRooms) {
            send(socket, {
              type: "error",
              message: "The server has reached its room limit.",
            });
            return;
          }
          room = [];
          rooms.set(message.roomId, room);
        }

        socket.roomId = message.roomId;
        socket.role = room.length === 0 ? "host" : "guest";
        // Store the persistent caller ID (may be absent for older clients)
        socket.userId = (typeof message.userId === "string" && message.userId.length <= 32)
          ? message.userId : null;
        // Store the human-readable display name
        socket.displayName = (typeof message.displayName === "string" && message.displayName.trim().length > 0)
          ? message.displayName.trim().slice(0, 50) : null;
        const existingPeers = room.map((peer) => ({
          peerId: peer.peerId,
          userId: peer.userId,
          displayName: peer.displayName,
        }));
        room.push(socket);

        send(socket, {
          type: "joined",
          roomId: socket.roomId,
          role: socket.role,
          peerId: socket.peerId,
          peers: existingPeers,
          peerPresent: room.length >= 2,
          iceServers: createIceServers(config),
        });

        for (const peer of room) {
          if (peer !== socket) {
            send(peer, {
              type: "peer-joined",
              peerId: socket.peerId,
              userId: socket.userId,
              displayName: socket.displayName,
            });
          }
        }
        return;
      }

      if (!socket.roomId) {
        send(socket, {
          type: "error",
          message: "Join a room before sending signaling messages.",
        });
        return;
      }

      if (
        !isValidSignal(message.type, message.payload)
      ) {
        send(socket, { type: "error", message: "Invalid signaling message." });
        return;
      }

      const room = rooms.get(socket.roomId) || [];
      if (message.targetPeerId) {
        const target = room.find((peer) => peer.peerId === message.targetPeerId);
        if (target && target !== socket) {
          send(target, {
            type: message.type,
            payload: message.payload,
            fromPeerId: socket.peerId,
          });
        }
      } else {
        for (const peer of room) {
          if (peer !== socket) {
            send(peer, {
              type: message.type,
              payload: message.payload,
              fromPeerId: socket.peerId,
            });
          }
        }
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
      if (!socket.roomId) return;

      const room = rooms.get(socket.roomId) || [];
      for (const peer of room) {
        if (peer !== socket) {
          if (room[0] === socket && room[1] === peer) {
            peer.role = "host";
          }
          send(peer, {
            type: "peer-left",
            peerId: socket.peerId,
            role: peer.role,
          });
        }
      }

      const remaining = room.filter((peer) => peer !== socket);
      if (remaining.length === 0) {
        rooms.delete(socket.roomId);
      } else {
        rooms.set(socket.roomId, remaining);
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, config.heartbeatIntervalMs);
  heartbeat.unref();

  async function close() {
    clearInterval(heartbeat);
    for (const client of clients) client.close(1001, "Server shutting down");
    await new Promise((resolve) => webSocketServer.close(resolve));
    await new Promise((resolve) => {
      if (!httpServer.listening) return resolve();
      httpServer.close(resolve);
    });
  }

  return { httpServer, webSocketServer, rooms, close };
}

if (require.main === module) {
  const signalingServer = createSignalingServer();
  const { httpServer } = signalingServer;
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "0.0.0.0";
  httpServer.listen(port, host, () => {
    console.log(
      `Voice chat signaling server listening on ${host}:${port}`,
    );
  });

  // ── Keep-alive self-ping ────────────────────────────────────────────────────
  // Set KEEPALIVE_URL=https://your-app.onrender.com/health to prevent Render's
  // free-tier service from sleeping after 15 minutes of inactivity.
  // The server pings itself every 14 minutes using only Node built-ins.
  const KEEPALIVE_URL = process.env.KEEPALIVE_URL;
  if (KEEPALIVE_URL) {
    const { get } = require(KEEPALIVE_URL.startsWith("https") ? "node:https" : "node:http");
    const FOURTEEN_MINUTES = 14 * 60 * 1000;
    const keepAliveTimer = setInterval(() => {
      get(KEEPALIVE_URL, (res) => {
        console.log(`[keepalive] ${new Date().toISOString()} → ${res.statusCode} ${KEEPALIVE_URL}`);
      }).on("error", (err) => {
        console.error(`[keepalive] ping failed: ${err.message}`);
      });
    }, FOURTEEN_MINUTES);
    keepAliveTimer.unref(); // Don't block process exit
    console.log(`[keepalive] Self-ping every 14 min → ${KEEPALIVE_URL}`);
  }
  // ───────────────────────────────────────────────────────────────────────────

  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      signalingServer.close().then(() => process.exit(0));
      setTimeout(() => process.exit(1), 10000).unref();
    });
  }
}

module.exports = { createIceServers, createSignalingServer, readConfig };
