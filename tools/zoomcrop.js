'use strict';
const { composite, writePNG } = require('./render.js');
function zoomCrop(w, h, line, fill, x0, y0, cw, ch, s) {
  const full = composite(w, h, line, fill);
  const W = cw * s, H = ch * s, out = new Uint8Array(W * H * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = ((y0 + y) * w + (x0 + x)) * 4, o = (y * s * W + x * s) * 4;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
      const oo = ((y * s + dy) * W + x * s + dx) * 4;
      out[oo] = full[i]; out[oo + 1] = full[i + 1]; out[oo + 2] = full[i + 2]; out[oo + 3] = 255;
    }
  }
  return { w: W, h: H, rgba: out };
}
module.exports = { zoomCrop };
