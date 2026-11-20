"use strict";
importScripts("/qr-decoder.js");

self.onmessage = ({data: {pixels, width, height}}) => {
  const result = self.jsQR(new Uint8ClampedArray(pixels), width, height,
    {inversionAttempts: "dontInvert"});
  self.postMessage(result ? result.data : "");
};
