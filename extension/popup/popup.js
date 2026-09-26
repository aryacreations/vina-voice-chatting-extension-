/* ── element refs ───────────────────────────────────── */
const serverUrlInput   = document.querySelector("#server-url");
const serverTag        = document.querySelector("#server-tag");
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
const userIdButton     = document.querySelector("#user-id");
const displayNameInput = document.querySelector("#display-name");
const participantsSection = document.querySelector("#participants-section");
const participantsList    = document.querySelector("#participants-list");
const participantsCount   = document.querySelector("#participants-count");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Hosts already covered by manifest host_permissions — no runtime permission prompt needed
const MANIFEST_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "vina-voice-chatting-extension.onrender.com",
]);
let lastCallParams = null;   // kept so "Done – Try again" can re-issue the same call

let myUserId = null;
let myDisplayName = null;

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
function updateServerTag(url) {
  if (!serverTag) return;
  try {
    const parsed = new URL(url);
    const isLocal = LOCAL_HOSTS.has(parsed.hostname);
    serverTag.textContent = isLocal ? "LOCAL" : "REMOTE";
    serverTag.className = isLocal ? "local-tag" : "local-tag live-tag";
  } catch {
    serverTag.textContent = "SERVER";
    serverTag.className = "local-tag";
  }
}

function showMicGuide() {
  micGuide.hidden = false;
  mainUi.hidden   = true;
}
function hideMicGuide() {
  micGuide.hidden = true;
  mainUi.hidden   = false;
}

function setStatus({ status = "idle", detail = "", roomId = null, muted = false, peers = [] }) {
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

  renderParticipants(peers, inCall);
}

/* ── participant roster ─────────────────────────────────────────────────── */

// Mic SVG — reused for every participant card
const MIC_SVG = `<svg class="participant-mic" viewBox="0 0 24 24" aria-hidden="true">
  <rect x="9" y="2" width="6" height="12" rx="3"></rect>
  <path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"></path>
</svg>`;

function renderParticipants(peers, inCall) {
  participantsSection.hidden = !inCall || peers.length === 0;
  if (!inCall || peers.length === 0) { participantsList.innerHTML = ""; return; }

  participantsCount.textContent = peers.length;

  // Keyed diff — update existing cards in place to avoid flicker
  const existing = new Map();
  for (const li of participantsList.children) {
    existing.set(li.dataset.peerId, li);
  }

  const fragment = document.createDocumentFragment();
  for (const peer of peers) {
    const key = peer.peerId || "local";
    let card = existing.get(key);

    if (!card) {
      card = document.createElement("li");
      card.dataset.peerId = key;
      card.className = "participant-card";
      card.innerHTML = `
        <div class="participant-avatar">${MIC_SVG}</div>
        <div class="participant-info">
          <span class="participant-id"></span>
          <span class="participant-sub" hidden></span>
          <span class="participant-role"></span>
        </div>
        <div class="participant-badges"></div>`;
    }

    const avatar   = card.querySelector(".participant-avatar");
    const idEl     = card.querySelector(".participant-id");
    const subEl    = card.querySelector(".participant-sub");
    const roleEl   = card.querySelector(".participant-role");
    const badgesEl = card.querySelector(".participant-badges");

    // Primary label: displayName → userId → short peerId
    const primaryLabel = peer.displayName
      || (peer.isLocal ? myDisplayName : null)
      || peer.userId
      || (peer.isLocal ? myUserId : null)
      || (peer.peerId ? peer.peerId.slice(0, 13) : "—");
    // Secondary label: userId (only if different from primary)
    const secondaryLabel = peer.userId && peer.userId !== primaryLabel ? peer.userId : null;

    idEl.textContent  = primaryLabel;
    if (subEl) subEl.textContent = secondaryLabel || "";
    if (subEl) subEl.hidden = !secondaryLabel;
    roleEl.textContent = peer.isLocal ? "You" : "Peer";

    card.classList.toggle("is-local",    !!peer.isLocal);
    card.classList.toggle("is-speaking", !!peer.speaking);
    card.classList.toggle("is-muted-card", !!peer.muted);
    avatar.classList.toggle("is-speaking", !!peer.speaking);
    avatar.classList.toggle("is-muted",    !!peer.muted);
    idEl.classList.toggle("is-local",    !!peer.isLocal);

    // Badges
    badgesEl.innerHTML = "";
    if (peer.speaking) {
      const b = document.createElement("span");
      b.className = "badge badge-speaking"; b.textContent = "SPEAKING";
      badgesEl.appendChild(b);
    }
    if (peer.muted) {
      const b = document.createElement("span");
      b.className = "badge badge-muted"; b.textContent = "MUTED";
      badgesEl.appendChild(b);
    }

    fragment.appendChild(card);
    existing.delete(key);
  }

  // Remove cards for peers who left
  for (const stale of existing.values()) stale.remove();
  participantsList.appendChild(fragment);
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
  if (serverUrl) {
    chrome.storage.local.set({ serverUrl }).catch(() => {});
  }
  let server;
  try { server = new URL(serverUrl); }
  catch { toast.textContent = "Enter a valid signaling server URL."; return; }

  if (!["ws:", "wss:"].includes(server.protocol)) {
    toast.textContent = "The URL must start with ws:// or wss://."; return;
  }
  if (server.protocol === "ws:" && !LOCAL_HOSTS.has(server.hostname)) {
    toast.textContent = "Use WSS for remote servers; WS is only allowed on localhost."; return;
  }

  // Optional host permission for servers not already covered by the manifest
  if (!MANIFEST_HOSTS.has(server.hostname)) {
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
    const displayName = displayNameInput.value.trim() || null;
    myDisplayName = displayName;
    if (displayName) chrome.storage.local.set({ displayName }).catch(() => {});
    await sendBackgroundMessage({
      type: "START_CALL",
      roomId,
      role,
      serverUrl,
      userId: myUserId,
      displayName,
    });
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
    const displayName = displayNameInput.value.trim() || myDisplayName || null;
    await sendBackgroundMessage({
      type: "START_CALL",
      roomId,
      role,
      serverUrl,
      userId: myUserId,
      displayName,
    });
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
  // Optimistic toggle — flip immediately so the button feels instant.
  // The offscreen will confirm the real state via CALL_STATUS shortly after.
  const wasMuted = muteButton.classList.contains("is-muted");
  muteButton.classList.toggle("is-muted", !wasMuted);
  muteButton.title = wasMuted ? "Mute microphone" : "Unmute microphone";
  muteButton.setAttribute("aria-label", muteButton.title);
  try { await sendBackgroundMessage({ type: "CALL_ACTION", action: "toggle-mute" }); }
  catch (err) {
    // Revert on failure
    muteButton.classList.toggle("is-muted", wasMuted);
    toast.textContent = err.message;
  }
});

leaveButton.addEventListener("click", async () => {
  lastCallParams = null;
  hideMicGuide();
  // Update the popup UI immediately — don't wait for the offscreen round-trip.
  setStatus({ status: "ended" });
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
async function init() {
  setStatus({});

  // Load the persistent user ID from the service worker.
  try {
    const res = await chrome.runtime.sendMessage({ target: "background", type: "GET_USER_ID" });
    if (res?.ok && res.userId) {
      myUserId = res.userId;
      userIdButton.textContent = res.userId;
      userIdButton.title = `Your Caller ID: ${res.userId} — click to copy`;
    }
  } catch {
    userIdButton.textContent = "Error";
  }

  const DEFAULT_SERVER_URL = "wss://vina-voice-chatting-extension.onrender.com/signal";

  // Load and persist the signaling server URL.
  try {
    const stored = await chrome.storage.local.get("serverUrl");
    const isOldDefault = !stored.serverUrl
      || stored.serverUrl === "ws://localhost:3000/signal"
      || stored.serverUrl === "wss://vina-voice-chatting-extension.onrender.com/health";
    if (stored.serverUrl && !isOldDefault) {
      serverUrlInput.value = stored.serverUrl;
    } else {
      serverUrlInput.value = DEFAULT_SERVER_URL;
      await chrome.storage.local.set({ serverUrl: DEFAULT_SERVER_URL });
    }
  } catch {
    serverUrlInput.value = DEFAULT_SERVER_URL;
  }
  updateServerTag(serverUrlInput.value.trim());

  serverUrlInput.addEventListener("input", () => {
    const url = serverUrlInput.value.trim();
    updateServerTag(url);
    if (url) chrome.storage.local.set({ serverUrl: url }).catch(() => {});
  });
  serverUrlInput.addEventListener("change", () => {
    const url = serverUrlInput.value.trim();
    updateServerTag(url);
    if (url) chrome.storage.local.set({ serverUrl: url }).catch(() => {});
  });

  // Load and persist the display name.
  try {
    const stored = await chrome.storage.local.get("displayName");
    if (stored.displayName) {
      myDisplayName = stored.displayName;
      displayNameInput.value = stored.displayName;
    }
  } catch { /* ok — storage unavailable */ }

  // Save display name whenever the user finishes editing.
  displayNameInput.addEventListener("blur", async () => {
    const name = displayNameInput.value.trim();
    myDisplayName = name || null;
    try { await chrome.storage.local.set({ displayName: name }); } catch { /* ok */ }
  });

  chrome.runtime.sendMessage({ target: "background", type: "GET_CALL_STATUS" }).catch(() => {});
}

// Click-to-copy the caller ID from the header badge
userIdButton.addEventListener("click", async () => {
  if (!myUserId) return;
  try {
    await navigator.clipboard.writeText(myUserId);
    const original = userIdButton.textContent;
    userIdButton.textContent = "Copied!";
    setTimeout(() => { userIdButton.textContent = original; }, 1500);
  } catch {
    toast.textContent = "Could not copy the caller ID.";
  }
});

init();
