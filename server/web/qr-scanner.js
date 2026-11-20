export function scanQR(preview, onRead, onError, onReady) {
  let stopped = false;
  let stream;
  let worker;
  let timer;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (worker) worker.terminate();
    if (stream) stream.getTracks().forEach(track => track.stop());
    preview.srcObject = null;
  }

  function fail(message) {
    if (stopped) return;
    stop();
    onError(message);
  }

  async function start() {
    try {
      const captured = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: {ideal: "environment"}, width: {ideal: 640}, height: {ideal: 480}, frameRate: {ideal: 15, max: 24}},
        audio: false
      });
      if (stopped) {
        captured.getTracks().forEach(track => track.stop());
        return;
      }
      stream = captured;
      for (const track of stream.getVideoTracks()) {
        track.onended = () => fail("The scanning camera disconnected.");
      }
      preview.srcObject = stream;
      await preview.play();
      if (stopped) return;
    } catch (error) {
      fail(error.name === "NotAllowedError" ? "Allow camera access to scan a QR code, or enter the pairing code." :
        "Could not open the scanning camera. Try again or enter the pairing code.");
      return;
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", {alpha: false, willReadFrequently: true});
    if (!context) {
      fail("The QR scanner is unavailable. Enter the pairing code.");
      return;
    }
    try {
      worker = new Worker("/qr-worker.js");
    } catch {
      fail("The QR scanner could not load. Enter the pairing code.");
      return;
    }
    worker.onerror = () => fail("The QR scanner could not load. Enter the pairing code.");
    worker.onmessage = event => {
      if (stopped) return;
      if (event.data) {
        stop();
        onRead(event.data);
      } else {
        timer = setTimeout(readFrame, 250);
      }
    };
    onReady();
    readFrame();

    function readFrame() {
      if (stopped) return;
      const {videoWidth, videoHeight} = preview;
      if (!videoWidth || !videoHeight || preview.readyState < 2) {
        timer = setTimeout(readFrame, 250);
        return;
      }
      const scale = Math.min(1, 480 / Math.max(videoWidth, videoHeight));
      const width = Math.max(1, Math.round(videoWidth * scale));
      const height = Math.max(1, Math.round(videoHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      try {
        context.drawImage(preview, 0, 0, width, height);
        const {data} = context.getImageData(0, 0, width, height);
        worker.postMessage({pixels: data.buffer, width, height}, [data.buffer]);
      } catch {
        fail("Could not read the camera preview. Try again or enter the pairing code.");
      }
    }
  }

  start().catch(() => fail("The QR scanner is unavailable. Enter the pairing code."));
  return stop;
}
