const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { WebSocket } = require("ws");
const { createIceServers, createSignalingServer } = require("../src/server");

let httpServer;
let address;

before(async () => {
  ({ httpServer } = createSignalingServer({
    env: { NODE_ENV: "test" },
  }));
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  address = `ws://127.0.0.1:${httpServer.address().port}/signal`;
});

after(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
});

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(address);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    socket.once("error", onError);
    socket.once("message", (data) => {
      socket.off("error", onError);
      resolve(JSON.parse(data.toString()));
    });
  });
}

test("joins two peers and relays offers only to the other peer", async (context) => {
  const host = await connect();
  const guest = await connect();
  context.after(() => {
    host.close();
    guest.close();
  });

  host.send(JSON.stringify({ type: "join", roomId: "test-room" }));
  const hostJoined = await nextMessage(host);
  assert.equal(hostJoined.type, "joined");
  assert.equal(hostJoined.roomId, "test-room");
  assert.equal(hostJoined.role, "host");
  assert.equal(hostJoined.peerPresent, false);
  assert.ok(hostJoined.peerId);
  assert.deepEqual(hostJoined.peers, []);

  guest.send(JSON.stringify({ type: "join", roomId: "test-room" }));
  const guestJoined = await nextMessage(guest);
  assert.equal(guestJoined.type, "joined");
  assert.equal(guestJoined.roomId, "test-room");
  assert.equal(guestJoined.role, "guest");
  assert.equal(guestJoined.peerPresent, true);
  assert.ok(guestJoined.peerId);
  assert.deepEqual(guestJoined.peers, [
    {
      peerId: hostJoined.peerId,
      userId: null,
      displayName: null,
    },
  ]);

  const hostPeerJoined = await nextMessage(host);
  assert.equal(hostPeerJoined.type, "peer-joined");
  assert.equal(hostPeerJoined.peerId, guestJoined.peerId);

  const offer = { type: "offer", sdp: "test-sdp" };
  const relayedOffer = nextMessage(guest);
  host.send(JSON.stringify({ type: "offer", payload: offer }));
  const receivedOffer = await relayedOffer;
  assert.equal(receivedOffer.type, "offer");
  assert.deepEqual(receivedOffer.payload, offer);
});

test("rejects an 11th participant in a full room (10 participant limit)", async (context) => {
  const peers = await Promise.all(Array.from({ length: 11 }, () => connect()));
  context.after(() => peers.forEach((peer) => peer.close()));

  for (let i = 0; i < 10; i++) {
    peers[i].send(JSON.stringify({ type: "join", roomId: "full-room" }));
    const joinedMsg = await nextMessage(peers[i]);
    assert.equal(joinedMsg.type, "joined");
  }

  peers[10].send(JSON.stringify({ type: "join", roomId: "full-room" }));
  const response = await nextMessage(peers[10]);
  assert.equal(response.type, "error");
  assert.match(response.message, /full|maximum 10 participants/);
});

test("enforces the configured room limit", async (context) => {
  const capped = createSignalingServer({
    env: { NODE_ENV: "test", MAX_ROOMS: "1" },
  });
  await new Promise((resolve) =>
    capped.httpServer.listen(0, "127.0.0.1", resolve),
  );
  const cappedAddress = `ws://127.0.0.1:${capped.httpServer.address().port}/signal`;
  context.after(() => capped.close());
  const peers = await Promise.all([
    new Promise((resolve, reject) => {
      const socket = new WebSocket(cappedAddress);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    }),
    new Promise((resolve, reject) => {
      const socket = new WebSocket(cappedAddress);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    }),
  ]);
  context.after(() => peers.forEach((peer) => peer.close()));

  peers[0].send(JSON.stringify({ type: "join", roomId: "room-one" }));
  assert.equal((await nextMessage(peers[0])).type, "joined");
  peers[1].send(JSON.stringify({ type: "join", roomId: "room-two" }));
  assert.match((await nextMessage(peers[1])).message, /room limit/);
});

test("promotes the remaining participant when the room creator leaves", async (context) => {
  const host = await connect();
  const guest = await connect();
  context.after(() => guest.close());

  host.send(JSON.stringify({ type: "join", roomId: "handoff-room" }));
  const hostJoined = await nextMessage(host);
  guest.send(JSON.stringify({ type: "join", roomId: "handoff-room" }));
  await nextMessage(guest);
  await nextMessage(host);

  host.close();
  const peerLeftMsg = await nextMessage(guest);
  assert.equal(peerLeftMsg.type, "peer-left");
  assert.equal(peerLeftMsg.role, "host");
  assert.equal(peerLeftMsg.peerId, hostJoined.peerId);

  const replacement = await connect();
  context.after(() => replacement.close());
  replacement.send(JSON.stringify({ type: "join", roomId: "handoff-room" }));
  const replacementJoined = await nextMessage(replacement);
  assert.equal(replacementJoined.type, "joined");
  assert.equal(replacementJoined.role, "guest");

  const guestPeerJoined = await nextMessage(guest);
  assert.equal(guestPeerJoined.type, "peer-joined");
  assert.equal(guestPeerJoined.peerId, replacementJoined.peerId);
});

test("allows only the host to mute, unmute, and remove room participants", async (context) => {
  const host = await connect();
  const guest = await connect();
  context.after(() => {
    host.close();
    guest.close();
  });

  host.send(JSON.stringify({ type: "join", roomId: "moderation-room" }));
  const hostJoined = await nextMessage(host);
  guest.send(JSON.stringify({ type: "join", roomId: "moderation-room" }));
  const guestJoined = await nextMessage(guest);
  await nextMessage(host);

  guest.send(
    JSON.stringify({
      type: "moderate",
      action: "kick",
      targetPeerId: hostJoined.peerId,
    }),
  );
  assert.equal((await nextMessage(guest)).type, "moderation-error");

  for (const action of ["mute", "unmute"]) {
    const moderation = nextMessage(guest);
    host.send(
      JSON.stringify({
        type: "moderate",
        action,
        targetPeerId: guestJoined.peerId,
      }),
    );
    const result = await moderation;
    assert.equal(result.type, "moderation");
    assert.equal(result.action, action);
  }

  const kickMessage = nextMessage(guest);
  const closeCode = new Promise((resolve) =>
    guest.once("close", (code) => resolve(code)),
  );
  const peerLeft = nextMessage(host);
  host.send(
    JSON.stringify({
      type: "moderate",
      action: "kick",
      targetPeerId: guestJoined.peerId,
    }),
  );
  assert.equal((await kickMessage).action, "kick");
  assert.equal(await closeCode, 4001);
  assert.equal((await peerLeft).type, "peer-left");
});

test("rejects JSON null without crashing the signaling server", async (context) => {
  const peer = await connect();
  context.after(() => peer.close());

  peer.send("null");
  assert.deepEqual(await nextMessage(peer), {
    type: "error",
    message: "Invalid signaling message.",
  });
});

test("issues short-lived Coturn REST credentials without exposing the shared secret", () => {
  const config = {
    stunUrls: [],
    turnUrls: [
      "turn:turn.example.test:3478?transport=udp",
      "turns:turn.example.test:5349?transport=tcp",
    ],
    turnSecret: "test-only-secret-that-is-long-enough",
    turnCredentialTtlSeconds: 600,
  };
  const now = 1_800_000_000_000;
  const [server] = createIceServers(config, now);
  const [username, nonce] = server.username.split(":");
  const expectedPassword = crypto
    .createHmac("sha1", config.turnSecret)
    .update(server.username)
    .digest("base64");

  assert.equal(Number(username), Math.floor(now / 1000) + 600);
  assert.match(nonce, /^[a-f0-9]{24}$/);
  assert.equal(server.credential, expectedPassword);
  assert.deepEqual(server.urls, config.turnUrls);
  assert.equal(JSON.stringify(server).includes(config.turnSecret), false);
});

test("requires origins and TURN configuration when NODE_ENV is production", () => {
  assert.throws(
    () => createSignalingServer({ env: { NODE_ENV: "production" } }),
    /ALLOWED_ORIGINS/,
  );
  assert.throws(
    () =>
      createSignalingServer({
        env: {
          NODE_ENV: "production",
          ALLOWED_ORIGINS: "https://voice.example.test",
        },
      }),
    /TURN_URLS and TURN_SHARED_SECRET/,
  );
  assert.throws(
    () =>
      createSignalingServer({
        env: {
          NODE_ENV: "production",
          ALLOWED_ORIGINS: "http://voice.example.test",
          TURN_URLS: "turn:turn.example.test:3478?transport=udp",
          TURN_SHARED_SECRET: "test-only-secret-that-is-long-enough",
        },
      }),
    /HTTPS or valid Chrome extension origins/,
  );
  assert.throws(
    () =>
      createSignalingServer({
        env: {
          NODE_ENV: "production",
          ALLOWED_ORIGINS: "https://voice.example.test",
          TURN_URLS: "turn:turn.example.test:3478?transport=udp",
          TURN_SHARED_SECRET: "weak",
        },
      }),
    /at least 32 bytes/,
  );
});

test("enforces configured browser origins on the WebSocket upgrade", async (context) => {
  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const restricted = createSignalingServer({
    env: {
      NODE_ENV: "production",
      ALLOWED_ORIGINS: extensionOrigin,
      TURN_URLS: "turn:turn.example.test:3478?transport=udp",
      TURN_SHARED_SECRET: "test-only-secret-that-is-long-enough",
    },
  });
  await new Promise((resolve) =>
    restricted.httpServer.listen(0, "127.0.0.1", resolve),
  );
  const restrictedAddress = `ws://127.0.0.1:${restricted.httpServer.address().port}/signal`;
  context.after(() => restricted.close());

  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = new WebSocket(restrictedAddress, {
        headers: { origin: "https://attacker.example.test" },
      });
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    }),
  );

  const allowed = await new Promise((resolve, reject) => {
    const socket = new WebSocket(restrictedAddress, {
      headers: { origin: extensionOrigin },
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
  context.after(() => allowed.close());
  allowed.send(JSON.stringify({ type: "join", roomId: "protected-room" }));
  const joined = await nextMessage(allowed);
  const turnServer = joined.iceServers.find((iceServer) => iceServer.username);
  assert.ok(turnServer);
  assert.deepEqual(turnServer.urls, [
    "turn:turn.example.test:3478?transport=udp",
  ]);
  assert.equal(
    turnServer.credential.includes("test-only-secret-that-is-long-enough"),
    false,
  );
});

test("rejects oversized or malformed signaling payload fields", async (context) => {
  const host = await connect();
  context.after(() => host.close());
  host.send(JSON.stringify({ type: "join", roomId: "schema-room" }));
  await nextMessage(host);

  host.send(
    JSON.stringify({
      type: "offer",
      payload: { type: "offer", sdp: "x".repeat(48 * 1024 + 1) },
    }),
  );
  assert.equal((await nextMessage(host)).type, "error");
  host.send(
    JSON.stringify({
      type: "ice-candidate",
      payload: { candidate: "candidate", unexpected: true },
    }),
  );
  assert.equal((await nextMessage(host)).type, "error");
  host.send(
    JSON.stringify({
      type: "ice-candidate",
      payload: { candidate: "candidate" },
      roomId: "different-room",
    }),
  );
  assert.equal((await nextMessage(host)).type, "error");
});
