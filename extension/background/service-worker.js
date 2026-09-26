const OFFSCREEN_URL = "offscreen/offscreen.html";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Hosts already declared in manifest host_permissions — no runtime permission prompt needed
const MANIFEST_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "vina-voice-chatting-extension.onrender.com",
]);
let creatingOffscreen;

/* ── User ID ─────────────────────────────────────────────────────────
 * Generated once on install and persisted in chrome.storage.local.
 * Format: VINA-XXXXXXXX  (8 uppercase alphanumeric chars)
 * Used as caller-id, receiver-id, and mute-identity across all peers.
 * ─────────────────────────────────────────────────────────────────── */
function generateUserId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, b => chars[b % chars.length]).join("");
  return `VINA-${suffix}`;
}

chrome.runtime.onInstalled.addListener(async () => {
  const { userId } = await chrome.storage.local.get("userId");
  if (!userId) {
    await chrome.storage.local.set({ userId: generateUserId() });
  }
});

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  if (existingContexts.length > 0) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA", "WEB_RTC"],
        justification:
          "Keep microphone capture and a WebRTC voice call active after the popup closes.",
      })
      .finally(() => {
        creatingOffscreen = undefined;
      });
  }
  await creatingOffscreen;
}

async function requestServerPermission(serverUrl) {
  let server;
  try {
    server = new URL(serverUrl);
  } catch {
    throw new Error("Enter a valid signaling server URL.");
  }

  if (
    !["ws:", "wss:"].includes(server.protocol) ||
    (server.protocol === "ws:" && !LOCAL_HOSTS.has(server.hostname))
  ) {
    throw new Error("Use WSS for remote signaling servers; WS is allowed only on localhost.");
  }

  const permissionOrigin = `${server.protocol === "wss:" ? "https:" : "http:"}//${server.host}/*`;
  const allowedByManifest = MANIFEST_HOSTS.has(server.hostname);
  if (allowedByManifest) return;

  const hasPermission = await chrome.permissions.contains({
    origins: [permissionOrigin],
  });
  if (!hasPermission)
    throw new Error("Grant permission for this signaling server from the popup.");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "background") return;

  (async () => {
    if (message.type === "GET_USER_ID") {
      const { userId } = await chrome.storage.local.get("userId");
      // Lazily create the ID if it was somehow missing (e.g. storage cleared)
      if (!userId) {
        const newId = generateUserId();
        await chrome.storage.local.set({ userId: newId });
        sendResponse({ ok: true, userId: newId });
      } else {
        sendResponse({ ok: true, userId });
      }
      return;
    }

    if (message.type === "START_CALL") {
      await requestServerPermission(message.serverUrl);
      await ensureOffscreenDocument();
      chrome.runtime.sendMessage({ ...message, target: "offscreen" });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CALL_ACTION") {
      await ensureOffscreenDocument();
      chrome.runtime.sendMessage({ ...message, target: "offscreen" });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "GET_CALL_STATUS") {
      await ensureOffscreenDocument();
      chrome.runtime.sendMessage({ target: "offscreen", type: "STATUS_QUERY" });
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown extension command." });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error.message || "The extension could not start the call.",
    });
  });

  return true;
});
