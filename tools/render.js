'use strict';
// lineAlpha と fill マスク（または RGBA）を合成して PNG を出す。
const fs = require('fs');
const { encodePNG } = require('./png.js');

// line: alpha 0..255（黒い線）。fill: RGBA Uint8ClampedArray/Uint8Array(w*h*4)
function composite(w, h, line, fill, bg = [255, 255, 255]) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r = bg[0], g = bg[1], b = bg[2];
    const fa = fill[i * 4 + 3] / 255;
    r = fill[i * 4] * fa + r * (1 - fa); g = fill[i * 4 + 1] * fa + g * (1 - fa); b = fill[i * 4 + 2] * fa + b * (1 - fa);
    const la = line[i] / 255;
    r = r * (1 - la); g = g * (1 - la); b = b * (1 - la);
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  return out;
}
function writePNG(path, w, h, rgba) { fs.writeFileSync(path, encodePNG(w, h, rgba)); }
function maskToRGBA(w, h, M, col = [47, 107, 255]) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (!M[i]) continue;
    out[i * 4] = col[0]; out[i * 4 + 1] = col[1]; out[i * 4 + 2] = col[2]; out[i * 4 + 3] = 255;
  }
  return out;
}
// ズーム（最近傍）
function scale(w, h, rgba, s) {
  const W = w * s, H = h * s, out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((y / s | 0) * w + (x / s | 0)) * 4, o = (y * W + x) * 4;
    out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2]; out[o + 3] = rgba[i + 3];
  }
  return { w: W, h: H, rgba: out };
}
module.exports = { composite, writePNG, maskToRGBA, scale };
