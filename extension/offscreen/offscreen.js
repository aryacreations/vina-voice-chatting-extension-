const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

let socket;
let localStream;
let activeRoomId;
let callStatus = "idle";
let myPeerId = null;
let iceServers = [];
let activeRole;
let callGeneration = 0;

const peerConnections = new Map();
const remoteAudios = new Map();
const pendingCandidates = new Map();

function publishStatus(status, detail = "") {
  callStatus = status;
  chrome.runtime
    .sendMessage({
      target: "popup",
      type: "CALL_STATUS",
      status,
      detail,
      roomId: activeRoomId,
      muted:
        localStream?.getAudioTracks().every((track) => !track.enabled) ?? false,
    })
    .catch(() => {});
}

function sendSignal(type, payload, targetPeerId) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, payload, targetPeerId }));
  }
}

async function getOrCreateLocalStream() {
  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  }
  return localStream;
}

function updateOverallStatus() {
  const activePeersCount = peerConnections.size;
  if (activePeersCount === 0) {
    publishStatus(
      "waiting",
      activeRole === "host"
        ? "Room ready. Waiting for people to join."
        : "Joined room. Waiting for participants.",
    );
    return;
  }

  let connectedCount = 0;
  for (const pc of peerConnections.values()) {
    if (pc.connectionState === "connected") {
      connectedCount++;
    }
  }

  if (connectedCount > 0) {
    publishStatus(
      "connected",
      `Voice connected (${connectedCount + 1} in room)`,
    );
  } else {
    publishStatus("connecting", "Connecting audio...");
  }
}

async function flushIceCandidates(targetPeerId, connection, generation) {
  if (!connection?.remoteDescription) return;
  const candidates = pendingCandidates.get(targetPeerId) || [];
  pendingCandidates.delete(targetPeerId);
  for (const candidate of candidates) {
    if (generation !== callGeneration) return;
    await connection.addIceCandidate(candidate);
  }
}

async function getOrCreatePeerConnection(targetPeerId, generation = callGeneration) {
  if (peerConnections.has(targetPeerId)) {
    return peerConnections.get(targetPeerId);
  }

  const connection = new RTCPeerConnection({ iceServers });
  peerConnections.set(targetPeerId, connection);

  const stream = await getOrCreateLocalStream();
  if (generation !== callGeneration) {
    connection.close();
    peerConnections.delete(targetPeerId);
    return null;
  }

  for (const track of stream.getTracks()) {
    connection.addTrack(track, stream);
  }

  connection.ontrack = (event) => {
    if (generation !== callGeneration) return;
    let audioEl = remoteAudios.get(targetPeerId);
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      remoteAudios.set(targetPeerId, audioEl);
    }
    audioEl.srcObject = event.streams[0];
    audioEl
      .play()
      .catch(() =>
        publishStatus(
          "connected",
          "Click the extension and use Enable audio if playback is blocked.",
        ),
      );
  };

  connection.onicecandidate = ({ candidate }) => {
    if (candidate && generation === callGeneration) {
      sendSignal("ice-candidate", candidate.toJSON(), targetPeerId);
    }
  };

  connection.onconnectionstatechange = () => {
    if (generation !== callGeneration) return;
    if (connection.connectionState === "failed") {
      closePeer(targetPeerId);
    }
    updateOverallStatus();
  };

  return connection;
}

function closePeer(targetPeerId) {
  const pc = peerConnections.get(targetPeerId);
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.close();
    peerConnections.delete(targetPeerId);
  }
  const audio = remoteAudios.get(targetPeerId);
  if (audio) {
    audio.pause();
    audio.srcObject = null;
    remoteAudios.delete(targetPeerId);
  }
  pendingCandidates.delete(targetPeerId);
}

async function startCall({ roomId, serverUrl, role }) {
  if (
    callStatus !== "idle" &&
    callStatus !== "ended" &&
    callStatus !== "error"
  ) {
    throw new Error(
      "A call is already active. Leave it before starting another.",
    );
  }
  if (!ROOM_ID_PATTERN.test(roomId || "")) {
    throw new Error(
      "Room codes must be 4-64 letters, numbers, dashes, or underscores.",
    );
  }
  if (!["host", "guest"].includes(role)) {
    throw new Error("Unknown room role.");
  }
  let endpoint;
  try {
    endpoint = new URL(serverUrl);
  } catch {
    throw new Error("Enter a valid signaling server URL.");
  }
  if (
    !["ws:", "wss:"].includes(endpoint.protocol) ||
    (endpoint.protocol === "ws:" && !LOCAL_HOSTS.has(endpoint.hostname))
  ) {
    throw new Error("Use WSS for remote signaling servers; WS is allowed only on localhost.");
  }

  activeRoomId = roomId;
  activeRole = role;
  const generation = ++callGeneration;
  pendingCandidates.clear();
  publishStatus("connecting", "Joining the signaling server.");

  try {
    const callSocket = new WebSocket(serverUrl);
    socket = callSocket;
    callSocket.addEventListener("open", () => {
      if (generation === callGeneration) {
        callSocket.send(JSON.stringify({ type: "join", roomId }));
      }
    });
    let messageQueue = Promise.resolve();
    callSocket.addEventListener("message", ({ data }) => {
      messageQueue = messageQueue.then(() => {
        if (generation === callGeneration) return handleServerMessage(data, generation);
      }).catch(async (error) => {
        if (generation !== callGeneration) return;
        await endCall();
        publishStatus("error", error.message);
      });
    });
    callSocket.addEventListener("error", async () => {
      if (generation !== callGeneration) return;
      await endCall();
      publishStatus(
        "error",
        "Could not reach the signaling server. Check that it is running.",
      );
    });
    callSocket.addEventListener("close", () => {
      if (
        generation === callGeneration &&
        callStatus !== "ended" &&
        callStatus !== "error"
      ) {
        publishStatus("error", "Signaling connection closed.");
      }
    });
  } catch (error) {
    if (generation !== callGeneration) return;
    await endCall();
    publishStatus(
      "error",
      error.name === "NotAllowedError"
        ? "Microphone access was denied."
        : error.message,
    );
  }
}

async function handleServerMessage(data, generation) {
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    throw new Error("The signaling server sent an invalid message.");
  }

  if (message.type === "joined") {
    if (!Array.isArray(message.iceServers) || message.iceServers.length === 0) {
      throw new Error("The signaling server did not provide ICE configuration.");
    }
    iceServers = message.iceServers;
    myPeerId = message.peerId;

    publishStatus("requesting-microphone", "Accessing microphone...");
    await getOrCreateLocalStream();
    if (generation !== callGeneration) return;

    const existingPeers = Array.isArray(message.peers) ? message.peers : [];
    for (const peerId of existingPeers) {
      const pc = await getOrCreatePeerConnection(peerId, generation);
      if (!pc || generation !== callGeneration) return;
      const offer = await pc.createOffer();
      if (generation !== callGeneration) return;
      await pc.setLocalDescription(offer);
      if (generation !== callGeneration) return;
      sendSignal("offer", pc.localDescription.toJSON(), peerId);
    }

    updateOverallStatus();
  } else if (message.type === "peer-joined") {
    const peerId = message.peerId || "default";
    await getOrCreatePeerConnection(peerId, generation);
    updateOverallStatus();
  } else if (message.type === "offer") {
    const fromPeerId = message.fromPeerId || "default";
    const pc = await getOrCreatePeerConnection(fromPeerId, generation);
    if (!pc || generation !== callGeneration) return;
    await pc.setRemoteDescription(message.payload);
    if (generation !== callGeneration) return;
    await flushIceCandidates(fromPeerId, pc, generation);
    if (generation !== callGeneration) return;
    const answer = await pc.createAnswer();
    if (generation !== callGeneration) return;
    await pc.setLocalDescription(answer);
    if (generation !== callGeneration) return;
    sendSignal("answer", pc.localDescription.toJSON(), fromPeerId);
    updateOverallStatus();
  } else if (message.type === "answer") {
    const fromPeerId = message.fromPeerId || "default";
    const pc = peerConnections.get(fromPeerId);
    if (pc) {
      await pc.setRemoteDescription(message.payload);
      if (generation !== callGeneration) return;
      await flushIceCandidates(fromPeerId, pc, generation);
    }
    updateOverallStatus();
  } else if (message.type === "ice-candidate") {
    const fromPeerId = message.fromPeerId || "default";
    const pc = peerConnections.get(fromPeerId);
    if (pc?.remoteDescription) {
      await pc.addIceCandidate(message.payload);
    } else {
      if (!pendingCandidates.has(fromPeerId)) {
        pendingCandidates.set(fromPeerId, []);
      }
      pendingCandidates.get(fromPeerId).push(message.payload);
    }
  } else if (message.type === "peer-left") {
    const peerId = message.peerId || "default";
    if (message.role) activeRole = message.role;
    closePeer(peerId);
    updateOverallStatus();
  } else if (message.type === "error") {
    throw new Error(message.message);
  }
}

async function endCall() {
  callGeneration += 1;
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close();
  }
  socket = null;

  for (const targetPeerId of Array.from(peerConnections.keys())) {
    closePeer(targetPeerId);
  }

  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  pendingCandidates.clear();
  iceServers = [];
  activeRoomId = null;
  activeRole = null;
  myPeerId = null;
  publishStatus("ended");
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "offscreen") return;

  if (message.type === "START_CALL") {
    startCall(message).catch((error) => publishStatus("error", error.message));
  } else if (message.type === "CALL_ACTION" && message.action === "leave") {
    endCall();
  } else if (
    message.type === "CALL_ACTION" &&
    message.action === "toggle-mute" &&
    localStream
  ) {
    const shouldEnable = localStream
      .getAudioTracks()
      .some((track) => !track.enabled);
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = shouldEnable;
    });
    publishStatus(callStatus);
  } else if (message.type === "STATUS_QUERY") {
    publishStatus(callStatus);
  } else if (message.type === "ENABLE_AUDIO") {
    for (const audioEl of remoteAudios.values()) {
      audioEl.play().catch(() => {});
    }
    publishStatus(callStatus);
  }
});
