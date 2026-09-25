const serverUrlInput = document.querySelector("#server-url");
const createRoomButton = document.querySelector("#create-room");
const joinForm = document.querySelector("#join-form");
const joinCodeInput = document.querySelector("#join-code");
const roomCode = document.querySelector("#room-code");
const copyRoomButton = document.querySelector("#copy-room");
const statusText = document.querySelector("#status-text");
const statusDetail = document.querySelector("#status-detail");
const signalIndicator = document.querySelector("#signal");
const callControls = document.querySelector("#call-controls");
const muteButton = document.querySelector("#mute-button");
const leaveButton = document.querySelector("#leave-button");
const enableAudioButton = document.querySelector("#enable-audio");
const toast = document.querySelector("#toast");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const statusLabels = {
  idle: "Ready when you are",
  ended: "Call ended",
  "requesting-microphone": "Requesting microphone",
  waiting: "Waiting for someone",
  connecting: "Connecting audio",
  connected: "Voice connected",
  reconnecting: "Connection interrupted",
  error: "Could not connect",
};

function setStatus({
  status = "idle",
  detail = "",
  roomId = null,
  muted = false,
}) {
  statusText.textContent = statusLabels[status] || status;
  statusDetail.textContent = detail;
  signalIndicator.dataset.state = status;
  callControls.hidden = ![
    "requesting-microphone",
    "waiting",
    "connecting",
    "connected",
    "reconnecting",
    "error",
  ].includes(status);
  muteButton.classList.toggle("is-muted", muted);
  muteButton.title = muted ? "Unmute microphone" : "Mute microphone";
  muteButton.setAttribute("aria-label", muteButton.title);
  enableAudioButton.hidden =
    status !== "connected" || !detail.includes("Enable audio");
  if (roomId) roomCode.textContent = roomId;
  copyRoomButton.disabled = !roomId;
  createRoomButton.disabled = callControls.hidden === false;
  joinForm.querySelector("button").disabled = callControls.hidden === false;
}

async function sendBackgroundMessage(message) {
  const response = await chrome.runtime.sendMessage({
    ...message,
    target: "background",
  });
  if (!response?.ok)
    throw new Error(
      response?.error || "The extension could not complete that action.",
    );
}

async function startCall(roomId, role) {
  toast.textContent = "";
  const serverUrl = serverUrlInput.value.trim();
  let server;
  try {
    server = new URL(serverUrl);
  } catch {
    throw new Error("Enter a valid signaling server URL.");
  }
  if (!["ws:", "wss:"].includes(server.protocol)) {
    throw new Error("The signaling URL must start with ws:// or wss://.");
  }
  if (server.protocol === "ws:" && !LOCAL_HOSTS.has(server.hostname)) {
    throw new Error("Use WSS for remote signaling servers; WS is allowed only on localhost.");
  }
  if (!LOCAL_HOSTS.has(server.hostname)) {
    const permissionOrigin = `${server.protocol === "wss:" ? "https:" : "http:"}//${server.host}/*`;
    const granted = await chrome.permissions.request({
      origins: [permissionOrigin],
    });
    if (!granted)
      throw new Error("Permission to connect to this signaling server was not granted.");
  }
  await sendBackgroundMessage({ type: "START_CALL", roomId, role, serverUrl });
  roomCode.textContent = roomId;
  setStatus({
    status: "requesting-microphone",
    detail: "Allow microphone access to join.",
    roomId,
  });
}

createRoomButton.addEventListener("click", async () => {
  const randomBytes = crypto.getRandomValues(new Uint8Array(24));
  const roomId = btoa(String.fromCharCode(...randomBytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  try {
    await startCall(roomId, "host");
  } catch (error) {
    toast.textContent = error.message;
  }
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const roomId = joinCodeInput.value.trim();
  try {
    await startCall(roomId, "guest");
  } catch (error) {
    toast.textContent = error.message;
  }
});

copyRoomButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomCode.textContent);
    toast.textContent = "Room code copied.";
  } catch {
    toast.textContent = "Could not copy the room code.";
  }
});

muteButton.addEventListener("click", async () => {
  try {
    await sendBackgroundMessage({ type: "CALL_ACTION", action: "toggle-mute" });
  } catch (error) {
    toast.textContent = error.message;
  }
});

leaveButton.addEventListener("click", async () => {
  try {
    await sendBackgroundMessage({ type: "CALL_ACTION", action: "leave" });
  } catch (error) {
    toast.textContent = error.message;
  }
});

enableAudioButton.addEventListener("click", async () => {
  chrome.runtime.sendMessage({ target: "offscreen", type: "ENABLE_AUDIO" });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target === "popup" && message.type === "CALL_STATUS") {
    setStatus(message);
  }
});

setStatus({});
chrome.runtime
  .sendMessage({ target: "background", type: "GET_CALL_STATUS" })
  .catch(() => {});
