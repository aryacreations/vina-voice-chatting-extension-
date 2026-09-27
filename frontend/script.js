const video = document.querySelector(".video-screen video");

video?.addEventListener("loadeddata", () => {
  video.closest(".video-screen").classList.add("has-video");
});

video?.addEventListener("error", () => {
  video.closest(".video-screen").classList.remove("has-video");
});
