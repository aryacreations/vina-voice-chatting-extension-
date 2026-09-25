const OFFSCREEN_URL = "offscreen/offscreen.html";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
let creatingOffscreen;

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
  const allowedByManifest = LOCAL_HOSTS.has(server.hostname);
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
