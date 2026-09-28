const video = document.querySelector(".video-screen video");

function showVideoIfReady() {
  if (video && video.readyState >= 2) {
    video.closest(".video-screen")?.classList.add("has-video");
  }
}

video?.addEventListener("loadeddata", () => {
  video.closest(".video-screen")?.classList.add("has-video");
});

video?.addEventListener("canplay", () => {
  video.closest(".video-screen")?.classList.add("has-video");
});

video?.addEventListener("error", () => {
  video.closest(".video-screen")?.classList.remove("has-video");
});

showVideoIfReady();
