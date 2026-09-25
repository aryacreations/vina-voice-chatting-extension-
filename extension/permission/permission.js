const grantBtn = document.querySelector("#grant-btn");
const statusMsg = document.querySelector("#status-msg");
const iconContainer = document.querySelector("#icon-container");

async function checkExistingPermission() {
  try {
    const permission = await navigator.permissions.query({ name: "microphone" });
    if (permission.state === "granted") {
      showSuccess("Microphone permission is already granted! You can close this tab.");
    }
  } catch {
    // Ignore query errors
  }
}

function showSuccess(msg) {
  grantBtn.style.display = "none";
  statusMsg.textContent = msg;
  statusMsg.className = "status-message success";
  iconContainer.style.background = "rgba(16, 185, 129, 0.15)";
  iconContainer.style.color = "#10b981";
  setTimeout(() => {
    window.close();
  }, 2000);
}

function showError(msg) {
  statusMsg.textContent = msg;
  statusMsg.className = "status-message error";
}

grantBtn.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    showSuccess("Permission granted! Closing tab...");
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      showError("Microphone access was blocked. Please click the camera/mic icon in your address bar to reset permission and try again.");
    } else {
      showError("Could not access microphone: " + err.message);
    }
  }
});

checkExistingPermission();
