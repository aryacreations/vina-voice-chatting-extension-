/* ── element refs ───────────────────────────────────── */
const serverUrlInput   = document.querySelector("#server-url");
const createRoomButton = document.querySelector("#create-room");
const joinForm         = document.querySelector("#join-form");
const joinCodeInput    = document.querySelector("#join-code");
const roomCode         = document.querySelector("#room-code");
const copyRoomButton   = document.querySelector("#copy-room");
const statusText       = document.querySelector("#status-text");
const statusDetail     = document.querySelector("#status-detail");
const signalIndicator  = document.querySelector("#signal");
const callControls     = document.querySelector("#call-controls");
const muteButton       = document.querySelector("#mute-button");
const leaveButton      = document.querySelector("#leave-button");
const enableAudioButton= document.querySelector("#enable-audio");
const toast            = document.querySelector("#toast");
const micGuide         = document.querySelector("#mic-guide");
const mainUi           = document.querySelector("#main-ui");
const retryBtn         = document.querySelector("#retry-after-settings");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
let lastCallParams = null;   // kept so "Done – Try again" can re-issue the same call

/* ── status labels ──────────────────────────────────── */
const statusLabels = {
  idle:                   "Ready when you are",
  ended:                  "Call ended",
  "requesting-microphone":"Connecting…",
  waiting:                "Waiting for participants",
  connecting:             "Connecting audio",
  connected:              "Voice connected",
  reconnecting:           "Connection interrupted",
  error:                  "Could not connect",
};

/* ── helpers ────────────────────────────────────────── */
function showMicGuide() {
  micGuide.hidden = false;
  mainUi.hidden   = true;
}
function hideMicGuide() {
  micGuide.hidden = true;
  mainUi.hidden   = false;
}

function setStatus({ status = "idle", detail = "", roomId = null, muted = false }) {
  statusText.textContent = statusLabels[status] || status;
  statusDetail.textContent = detail;
  signalIndicator.dataset.state = status;

  const inCall = ["requesting-microphone","waiting","connecting","connected","reconnecting","error"].includes(status);
  callControls.hidden = !inCall;
  muteButton.classList.toggle("is-muted", muted);
  muteButton.title = muted ? "Unmute microphone" : "Mute microphone";
  muteButton.setAttribute("aria-label", muteButton.title);
  enableAudioButton.hidden = status !== "connected" || !detail.includes("Enable audio");

  if (roomId) roomCode.textContent = roomId;
  copyRoomButton.disabled = !roomId;
  createRoomButton.disabled = inCall;
  joinForm.querySelector("button").disabled = inCall;
}

async function sendBackgroundMessage(message) {
  const res = await chrome.runtime.sendMessage({ ...message, target: "background" });
  if (!res?.ok) throw new Error(res?.error || "The extension could not complete that action.");
}

function generate6CharCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

/* ── mic permission (MUST be called inside a user-gesture handler) ── */
async function requestMicPermission() {
  // getUserMedia from a popup button click = Chrome's native permission dialog.
  // We stop the stream immediately — we only need permission granted.
  // The offscreen document opens its own stream for the actual call.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  stream.getTracks().forEach(t => t.stop());
}

/* ── start call ─────────────────────────────────────── */
async function startCall(roomId, role) {
  toast.textContent = "";
  hideMicGuide();

  const serverUrl = serverUrlInput.value.trim();
  let server;
  try { server = new URL(serverUrl); }
  catch { toast.textContent = "Enter a valid signaling server URL."; return; }

  if (!["ws:", "wss:"].includes(server.protocol)) {
    toast.textContent = "The URL must start with ws:// or wss://."; return;
  }
  if (server.protocol === "ws:" && !LOCAL_HOSTS.has(server.hostname)) {
    toast.textContent = "Use WSS for remote servers; WS is only allowed on localhost."; return;
  }

  // Optional host permission for non-localhost servers
  if (!LOCAL_HOSTS.has(server.hostname)) {
    const origin = `${server.protocol === "wss:" ? "https:" : "http:"}//${server.host}/*`;
    const ok = await chrome.permissions.request({ origins: [origin] });
    if (!ok) { toast.textContent = "Permission for this server was not granted."; return; }
  }

  // ── Microphone permission ────────────────────────────
  // Called here, inside the button click handler = user gesture.
  // Chrome shows its native "Allow microphone?" dialog.
  try {
    await requestMicPermission();
  } catch (err) {
    // NotAllowedError → Chrome blocked or user dismissed the dialog.
    // Show the step-by-step guide so the user knows how to fix it in extension settings.
    lastCallParams = { roomId, role, serverUrl };
    showMicGuide();
    return;
  }

  // Mic granted — launch the call
  lastCallParams = { roomId, role, serverUrl };
  roomCode.textContent = roomId;
  setStatus({ status: "requesting-microphone", detail: "Joining room…", roomId });

  try {
    await sendBackgroundMessage({ type: "START_CALL", roomId, role, serverUrl });
  } catch (err) {
    toast.textContent = err.message;
    setStatus({ status: "idle" });
    lastCallParams = null;
  }
}

/* ── button handlers ────────────────────────────────── */
createRoomButton.addEventListener("click", () => startCall(generate6CharCode(), "host"));

joinForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const code = joinCodeInput.value.trim().toUpperCase();
  if (code.length < 4) { toast.textContent = "Enter a valid room code."; return; }
  startCall(code, "guest");
});

// "Done – Try again" button in the mic guide
retryBtn.addEventListener("click", async () => {
  if (!lastCallParams) { hideMicGuide(); return; }
  const { roomId, role, serverUrl } = lastCallParams;
  hideMicGuide();
  toast.textContent = "";

  // Try mic permission again — now it should succeed since the user allowed it in settings
  try {
    await requestMicPermission();
  } catch {
    // Still blocked — show the guide again
    showMicGuide();
    toast.textContent = "Microphone still blocked. Please follow the steps above.";
    return;
  }

  // Clean up any previous failed state
  try { await sendBackgroundMessage({ type: "CALL_ACTION", action: "leave" }); } catch { /* ok */ }

  roomCode.textContent = roomId;
  setStatus({ status: "requesting-microphone", detail: "Joining room…", roomId });

  try {
    await sendBackgroundMessage({ type: "START_CALL", roomId, role, serverUrl });
  } catch (err) {
    toast.textContent = err.message;
    setStatus({ status: "idle" });
  }
});

copyRoomButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomCode.textContent);
    toast.textContent = "Room code copied!";
    setTimeout(() => { if (toast.textContent === "Room code copied!") toast.textContent = ""; }, 2000);
  } catch { toast.textContent = "Could not copy the room code."; }
});

muteButton.addEventListener("click", async () => {
  try { await sendBackgroundMessage({ type: "CALL_ACTION", action: "toggle-mute" }); }
  catch (err) { toast.textContent = err.message; }
});

leaveButton.addEventListener("click", async () => {
  lastCallParams = null;
  hideMicGuide();
  try { await sendBackgroundMessage({ type: "CALL_ACTION", action: "leave" }); }
  catch (err) { toast.textContent = err.message; }
});

enableAudioButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ target: "offscreen", type: "ENABLE_AUDIO" });
});

/* ── receive status updates from offscreen ──────────── */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "popup" || msg.type !== "CALL_STATUS") return;
  if (msg.status === "ended" || msg.status === "idle") lastCallParams = null;
  setStatus(msg);
});

/* ── init ───────────────────────────────────────────── */
setStatus({});
chrome.runtime.sendMessage({ target: "background", type: "GET_CALL_STATUS" }).catch(() => {});
