const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

let socket;
let peerConnection;
let localStream;
let activeRoomId;
let callStatus = "idle";
let pendingCandidates = [];
let remoteAudio;
let iceServers = [];
let activeRole;
let callGeneration = 0;

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

function sendSignal(type, payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, payload }));
  }
}

async function flushIceCandidates(connection, generation) {
  if (!connection?.remoteDescription) return;
  const candidates = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of candidates) {
    if (generation !== callGeneration) return;
    await connection.addIceCandidate(candidate);
  }
}

async function createPeerConnection(generation = callGeneration) {
  const connection = new RTCPeerConnection({ iceServers });
  peerConnection = connection;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  if (generation !== callGeneration) {
    stream.getTracks().forEach((track) => track.stop());
    connection.close();
    return;
  }
  localStream = stream;

  for (const track of stream.getTracks()) {
    connection.addTrack(track, stream);
  }

  connection.ontrack = (event) => {
    if (generation !== callGeneration || peerConnection !== connection) return;
    if (!remoteAudio) {
      remoteAudio = new Audio();
      remoteAudio.autoplay = true;
      remoteAudio.playsInline = true;
    }
    remoteAudio.srcObject = event.streams[0];
    remoteAudio
      .play()
      .catch(() =>
        publishStatus(
          "connected",
          "Click the extension and use Enable audio if playback is blocked.",
        ),
      );
  };

  connection.onicecandidate = ({ candidate }) => {
    if (
      candidate &&
      generation === callGeneration &&
      peerConnection === connection
    ) {
      sendSignal("ice-candidate", candidate.toJSON());
    }
  };

  connection.onconnectionstatechange = () => {
    if (generation !== callGeneration || peerConnection !== connection) return;
    if (connection.connectionState === "connected")
      publishStatus("connected");
    if (connection.connectionState === "disconnected")
      publishStatus("reconnecting", "Connection interrupted.");
    if (connection.connectionState === "failed") {
      endCall().then(() =>
        publishStatus(
          "error",
          "WebRTC could not find a route. A TURN server may be required.",
        ),
      );
    }
  };
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
  pendingCandidates = [];
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
    if (message.role !== activeRole)
      throw new Error(
        "That room already exists. Create a different room or join the existing one.",
      );
    if (!Array.isArray(message.iceServers) || message.iceServers.length === 0) {
      throw new Error("The signaling server did not provide ICE configuration.");
    }
    iceServers = message.iceServers;
    publishStatus("requesting-microphone", "Allow microphone access to join.");
    await createPeerConnection(generation);
    if (generation !== callGeneration) return;
    publishStatus(
      "waiting",
      activeRole === "host"
        ? "Room ready. Waiting for someone to join."
        : "Joined room. Connecting...",
    );
  } else if (message.type === "peer-joined" && activeRole === "host") {
    const connection = peerConnection;
    const offer = await connection.createOffer();
    if (generation !== callGeneration) return;
    await connection.setLocalDescription(offer);
    if (generation !== callGeneration) return;
    sendSignal("offer", peerConnection.localDescription.toJSON());
    publishStatus("connecting");
  } else if (message.type === "offer" && activeRole === "guest") {
    const connection = peerConnection;
    await connection.setRemoteDescription(message.payload);
    if (generation !== callGeneration) return;
    await flushIceCandidates(connection, generation);
    if (generation !== callGeneration) return;
    const answer = await connection.createAnswer();
    if (generation !== callGeneration) return;
    await connection.setLocalDescription(answer);
    if (generation !== callGeneration) return;
    sendSignal("answer", connection.localDescription.toJSON());
    publishStatus("connecting");
  } else if (message.type === "answer" && activeRole === "host") {
    const connection = peerConnection;
    await connection.setRemoteDescription(message.payload);
    if (generation !== callGeneration) return;
    await flushIceCandidates(connection, generation);
    if (generation !== callGeneration) return;
    publishStatus("connecting");
  } else if (message.type === "ice-candidate") {
    const connection = peerConnection;
    if (connection?.remoteDescription) {
      await connection.addIceCandidate(message.payload);
    } else {
      pendingCandidates.push(message.payload);
    }
  } else if (message.type === "peer-left") {
    activeRole = message.role || activeRole;
    publishStatus(
      "waiting",
      "The other person left. Waiting for them to rejoin.",
    );
    peerConnection?.close();
    peerConnection = null;
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    if (remoteAudio) remoteAudio.srcObject = null;
    pendingCandidates = [];
    await createPeerConnection(generation);
    if (generation !== callGeneration) return;
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
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.close();
  }
  peerConnection = null;
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  if (remoteAudio) {
    remoteAudio.pause();
    remoteAudio.srcObject = null;
  }
  pendingCandidates = [];
  iceServers = [];
  activeRoomId = null;
  activeRole = null;
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
  } else if (message.type === "ENABLE_AUDIO" && remoteAudio) {
    remoteAudio
      .play()
      .then(() => publishStatus(callStatus))
      .catch(() =>
        publishStatus(callStatus, "Audio playback is blocked by the browser."),
      );
  }
});
