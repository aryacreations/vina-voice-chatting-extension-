const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

let socket;
let localStream;
let activeRoomId;
let callStatus = "idle";
let myPeerId = null;
let myUserId = null;   // persistent caller/receiver ID loaded from storage
let iceServers = [];
let activeRole;
let callGeneration = 0;

const peerConnections = new Map();
const remoteAudios = new Map();
const pendingCandidates = new Map();

// peerId → persistent userId (VINA-XXXXXXXX) received from the server
const peerUserIds = new Map();
// peerId → human-readable display name chosen by the user
const peerDisplayNames = new Map();
// peerId → RTCDataChannel for peer-to-peer control sync
const peerDataChannels = new Map();
// peerId → remote peer muted boolean
const peerMutedStates = new Map();
// peerIds currently detected as speaking (above VAD threshold)
const speakingPeers = new Set();
// peerId → { analyser, source, intervalId } for VAD cleanup
const vadHandles = new Map();
// Shared AudioContext for VAD (created lazily once)
let audioCtx = null;
// Our own display name for this call
let myDisplayName = null;
// Current remote audio volume [0, 1] — applied to all remote Audio elements
let remoteVolume = 1;
// Set when the host has admin-muted us — blocks self-unmute
let adminMutedByHost = false;
// Peers that WE (as host) have admin-muted — peerId → true
const peerAdminMutedByUs = new Set();

/* ── VAD threshold ──────────────────────────────────────────────────────
 * RMS energy above this value (0-255 scale from AnalyserNode) = speaking.
 * 4.5 is sensitive enough for normal/quiet speech while filtering silence.
 * ─────────────────────────────────────────────────────────────────────── */
const VAD_THRESHOLD = 4.5;
const VAD_POLL_MS   = 100;
const VAD_HANGOVER_MS = 350;

function buildPeerList() {
  const isMuted = localStream?.getAudioTracks().every((t) => !t.enabled) ?? false;
  const list = [{
    peerId: myPeerId,
    userId: myUserId,
    displayName: myDisplayName,
    muted: isMuted,
    speaking: !isMuted && speakingPeers.has("__local__"),
    isLocal: true,
    adminMuted: false,   // local user is never shown as admin-muted to themselves
  }];
  for (const peerId of peerConnections.keys()) {
    list.push({
      peerId,
      userId: peerUserIds.get(peerId) || null,
      displayName: peerDisplayNames.get(peerId) || null,
      muted: peerMutedStates.get(peerId) ?? false,
      speaking: speakingPeers.has(peerId),
      isLocal: false,
      adminMuted: peerAdminMutedByUs.has(peerId),
    });
  }
  return list;
}

function publishStatus(status, detail = "") {
  callStatus = status;
  chrome.runtime
    .sendMessage({
      target: "popup",
      type: "CALL_STATUS",
      status,
      detail,
      roomId: activeRoomId,
      userId: myUserId,
      role: activeRole,
      muted:
        localStream?.getAudioTracks().every((track) => !track.enabled) ?? false,
      peers: buildPeerList(),
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
    // Start local VAD so speaking state triggers for the user speaking
    startVad("__local__", localStream);
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

  // Negotiated data channel for peer-to-peer mute state sync
  try {
    const dataChannel = connection.createDataChannel("vina-control", { negotiated: true, id: 0 });
    peerDataChannels.set(targetPeerId, dataChannel);
    dataChannel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "mute-state") {
          peerMutedStates.set(targetPeerId, !!msg.muted);
          publishStatus(callStatus);
        } else if (msg.type === "admin-mute") {
          // Host commanded us to mute — force local tracks off and lock unmute
          adminMutedByHost = true;
          if (localStream) {
            localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
            speakingPeers.delete("__local__");
            for (const pc of peerConnections.values()) {
              for (const sender of pc.getSenders()) {
                if (sender.track?.kind === "audio") sender.track.enabled = false;
              }
            }
            for (const dc of peerDataChannels.values()) {
              if (dc.readyState === "open") {
                try { dc.send(JSON.stringify({ type: "mute-state", muted: true })); } catch {}
              }
            }
          }
          publishStatus(callStatus);
        } else if (msg.type === "admin-unmute") {
          // Host released the mute lock — re-enable mic
          adminMutedByHost = false;
          if (localStream) {
            localStream.getAudioTracks().forEach((t) => { t.enabled = true; });
            for (const pc of peerConnections.values()) {
              for (const sender of pc.getSenders()) {
                if (sender.track?.kind === "audio") sender.track.enabled = true;
              }
            }
            for (const dc of peerDataChannels.values()) {
              if (dc.readyState === "open") {
                try { dc.send(JSON.stringify({ type: "mute-state", muted: false })); } catch {}
              }
            }
          }
          publishStatus(callStatus);
        } else if (msg.type === "admin-kick") {
          // Host kicked us — defer so DC message handler finishes before teardown
          setTimeout(() => endCall(), 50);
        }
      } catch {}
    };
    dataChannel.onopen = () => {
      const isMuted = localStream?.getAudioTracks().every((t) => !t.enabled) ?? false;
      try { dataChannel.send(JSON.stringify({ type: "mute-state", muted: isMuted })); } catch {}
    };
  } catch {}

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
    const remoteStream = event.streams[0];
    let audioEl = remoteAudios.get(targetPeerId);
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.volume = remoteVolume;   // inherit current volume
      remoteAudios.set(targetPeerId, audioEl);
    }
    audioEl.srcObject = remoteStream;
    // Start VAD immediately on the incoming stream
    startVad(targetPeerId, remoteStream);
    audioEl
      .play()
      .catch(() => {
        publishStatus(
          "connected",
          "Click the extension and use Enable audio if playback is blocked.",
        );
      });
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

function stopVad(peerId) {
  const handle = vadHandles.get(peerId);
  if (handle) {
    clearInterval(handle.intervalId);
    try { handle.source.disconnect(); } catch { /* ok */ }
    vadHandles.delete(peerId);
  }
  speakingPeers.delete(peerId);
}

function startVad(peerId, stream) {
  stopVad(peerId); // clear any previous analyser for this peer
  if (!stream || stream.getAudioTracks().length === 0) return;
  try {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    const source   = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    let lastSpokeAt = 0;
    const intervalId = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      // Compute RMS energy (128 = silence in time-domain representation)
      let sum = 0;
      for (const v of data) { const s = v - 128; sum += s * s; }
      const rms = Math.sqrt(sum / data.length);

      const isMuted = (peerId === "__local__") &&
        (localStream?.getAudioTracks().every((t) => !t.enabled) ?? false);
      const wasSpeaking = speakingPeers.has(peerId);

      const now = Date.now();
      if (!isMuted && rms > VAD_THRESHOLD) {
        lastSpokeAt = now;
      }

      // Smooth hangover so indicator doesn't jitter/flicker between syllables
      const isSpeaking = !isMuted && (now - lastSpokeAt < VAD_HANGOVER_MS);

      if (isSpeaking) {
        speakingPeers.add(peerId);
      } else {
        speakingPeers.delete(peerId);
      }
      if (speakingPeers.has(peerId) !== wasSpeaking) {
        publishStatus(callStatus); // only re-publish when speaking state changes
      }
    }, VAD_POLL_MS);

    vadHandles.set(peerId, { source, analyser, intervalId });
  } catch {
    // AudioContext might not be available in offscreen — degrade gracefully
  }
}

function closePeer(targetPeerId) {
  stopVad(targetPeerId);
  peerUserIds.delete(targetPeerId);
  peerDisplayNames.delete(targetPeerId);
  peerMutedStates.delete(targetPeerId);
  const dc = peerDataChannels.get(targetPeerId);
  if (dc) {
    try { dc.close(); } catch { /* ok */ }
    peerDataChannels.delete(targetPeerId);
  }
  const pc = peerConnections.get(targetPeerId);
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;  // prevent stale callbacks after close
    pc.close();
    peerConnections.delete(targetPeerId);
  }
  const audio = remoteAudios.get(targetPeerId);
  if (audio) {
    audio.autoplay = false;
    audio.pause();
    audio.srcObject = null;
    try { audio.load(); } catch { /* ok - fully resets the media pipeline */ }
    remoteAudios.delete(targetPeerId);
  }
  pendingCandidates.delete(targetPeerId);
}

async function startCall({ roomId, serverUrl, role, userId, displayName }) {
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
  myUserId = userId || null;
  if (!myUserId) {
    try {
      const stored = await chrome.storage.local.get("userId");
      myUserId = stored?.userId || null;
    } catch { /* ok */ }
  }
  myDisplayName = (typeof displayName === "string" && displayName.trim())
    ? displayName.trim() : null;
  if (!myDisplayName) {
    try {
      const stored = await chrome.storage.local.get("displayName");
      myDisplayName = (typeof stored?.displayName === "string" && stored.displayName.trim())
        ? stored.displayName.trim() : null;
    } catch { /* ok */ }
  }
  const generation = ++callGeneration;
  pendingCandidates.clear();
  publishStatus("connecting", "Joining the signaling server.");

  try {
    const callSocket = new WebSocket(serverUrl);
    socket = callSocket;
    callSocket.addEventListener("open", () => {
      if (generation === callGeneration) {
        callSocket.send(JSON.stringify({
          type: "join",
          roomId,
          userId: myUserId,
          displayName: myDisplayName,
        }));
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

    // peers is now [{peerId, userId, displayName}] from the updated server
    const existingPeers = Array.isArray(message.peers) ? message.peers : [];
    for (const peerInfo of existingPeers) {
      const peerId      = typeof peerInfo === "object" ? peerInfo.peerId      : peerInfo;
      const userId      = typeof peerInfo === "object" ? peerInfo.userId      : null;
      const displayName = typeof peerInfo === "object" ? peerInfo.displayName : null;
      if (userId)      peerUserIds.set(peerId, userId);
      if (displayName) peerDisplayNames.set(peerId, displayName);
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
    if (message.userId)      peerUserIds.set(peerId, message.userId);
    if (message.displayName) peerDisplayNames.set(peerId, message.displayName);
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

  // Safety net: stop any remote audio elements that fell out of sync with
  // peerConnections (e.g. from a failed-then-removed peer).
  stopVad("__local__");
  for (const peerId of [...vadHandles.keys()]) stopVad(peerId);
  speakingPeers.clear();
  peerUserIds.clear();
  peerDisplayNames.clear();
  for (const dc of peerDataChannels.values()) {
    try { dc.close(); } catch { /* ok */ }
  }
  peerDataChannels.clear();
  peerMutedStates.clear();
  for (const audio of remoteAudios.values()) {
    audio.autoplay = false;
    audio.pause();
    audio.srcObject = null;
    try { audio.load(); } catch { /* ok */ }
  }
  remoteAudios.clear();

  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  pendingCandidates.clear();
  iceServers = [];
  activeRoomId = null;
  activeRole = null;
  myPeerId = null;
  myUserId = null;
  myDisplayName = null;
  adminMutedByHost = false;       // clear host-mute lock for next call
  peerAdminMutedByUs.clear();     // clear admin-mute tracking for next call
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
    // Block self-unmute when admin has locked the mic
    if (adminMutedByHost) {
      publishStatus(callStatus); // re-sync UI so muted indicator stays correct
      return;
    }

    // Determine target state: if ALL tracks are enabled → mute; else → unmute.
    const allEnabled = localStream.getAudioTracks().every((t) => t.enabled);
    const shouldMute = allEnabled;

    // 1. Set enabled on the MediaStreamTrack (controls what enters the encoder).
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !shouldMute;
    });

    // 2. Clear speaking state immediately if muted
    if (shouldMute) {
      speakingPeers.delete("__local__");
    }

    // 3. Mirror the change on every RTCRtpSender so the WebRTC layer
    //    definitely sends silence — belt-and-suspenders for Chrome.
    for (const pc of peerConnections.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track && sender.track.kind === "audio") {
          sender.track.enabled = !shouldMute;
        }
      }
    }

    // 4. Broadcast mute state across peer data channels
    for (const dc of peerDataChannels.values()) {
      if (dc.readyState === "open") {
        try { dc.send(JSON.stringify({ type: "mute-state", muted: shouldMute })); } catch {}
      }
    }

    publishStatus(callStatus);
  } else if (message.type === "STATUS_QUERY") {
    publishStatus(callStatus);
  } else if (message.type === "ENABLE_AUDIO") {
    for (const audioEl of remoteAudios.values()) {
      audioEl.play().catch(() => {});
    }
    publishStatus(callStatus);
  } else if (message.type === "SET_VOLUME") {
    // Clamp to [0, 1] for safety
    remoteVolume = Math.min(1, Math.max(0, Number(message.volume) || 0));
    for (const audioEl of remoteAudios.values()) {
      audioEl.volume = remoteVolume;
    }
  } else if (message.type === "ADMIN_MUTE_PEER" && message.peerId) {
    // Track and send admin-mute via data channel
    peerAdminMutedByUs.add(message.peerId);
    const dc = peerDataChannels.get(message.peerId);
    if (dc?.readyState === "open") {
      try { dc.send(JSON.stringify({ type: "admin-mute" })); } catch {}
    }
    publishStatus(callStatus);
  } else if (message.type === "ADMIN_UNMUTE_PEER" && message.peerId) {
    // Release admin-mute lock on the peer
    peerAdminMutedByUs.delete(message.peerId);
    const dc = peerDataChannels.get(message.peerId);
    if (dc?.readyState === "open") {
      try { dc.send(JSON.stringify({ type: "admin-unmute" })); } catch {}
    }
    publishStatus(callStatus);
  } else if (message.type === "ADMIN_KICK_PEER" && message.peerId) {
    // Tell the peer to leave, then close our side
    const dc = peerDataChannels.get(message.peerId);
    if (dc?.readyState === "open") {
      try { dc.send(JSON.stringify({ type: "admin-kick" })); } catch {}
    }
    // Give the DC message a moment to transmit before tearing down
    setTimeout(() => {
      peerAdminMutedByUs.delete(message.peerId);
      closePeer(message.peerId);
      updateOverallStatus();
    }, 300);
  }
});
