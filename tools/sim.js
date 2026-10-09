'use strict';
// 現行 script.js の jobBrush / jobLasso と同じ処理を Node で再現して PNG を出す
const fs = require('fs');
const FC = require('../fillcore.js');
const { makeScene } = require('./scene.js');
const { composite, writePNG, maskToRGBA, scale } = require('./render.js');
const { drawPolyAA, drawLineAA } = require('./png.js');

const W = 300, H = 300;
const lineAlpha = makeScene(W, H);
const OPT = { thr: 50, gap: 8, bleed: 0, protect: true, color: [242, 184, 160] };

function barrier() {
  const B = new Uint8Array(W * H);
  for (let i = 0; i < B.length; i++) B[i] = lineAlpha[i] >= OPT.thr ? 1 : 0;
  return B;
}
function strokeMask(pts, size) {
  const a = new Uint8Array(W * H);
  drawPolyAA(a, W, H, pts, size, 255, false);
  const m = new Uint8Array(W * H);
  for (let i = 0; i < m.length; i++) m[i] = a[i] > 0 ? 1 : 0;
  return m;
}
function lassoMask(pts) {
  // 偶奇則で多角形内を判定
  const m = new Uint8Array(W * H);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  for (let y = Math.max(0, y0 | 0); y <= Math.min(H - 1, y1); y++) {
    for (let x = Math.max(0, x0 | 0); x <= Math.min(W - 1, x1); x++) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y + 0.5) !== (yj > y + 0.5) && x + 0.5 < (xj - xi) * (y + 0.5 - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) m[y * W + x] = 1;
    }
  }
  return m;
}
function applyMask(M, fill, erase) {
  for (let i = 0; i < M.length; i++) {
    if (!M[i]) continue;
    if (erase) { fill[i * 4 + 3] = 0; continue; }
    fill[i * 4] = OPT.color[0]; fill[i * 4 + 1] = OPT.color[1]; fill[i * 4 + 2] = OPT.color[2]; fill[i * 4 + 3] = 255;
  }
}
// 現行 jobBrush（線に沿う）
function currentBrush(pts, size, fill) {
  const S = strokeMask(pts, size);
  const B0 = barrier();
  const FB = OPT.protect ? maskFromFill(fill) : null;
  const M = FC.fillRegion({ w: W, h: H, B0, FB, seed: S, allow: null, gap: OPT.gap, bleed: OPT.bleed });
  applyMask(M, fill, false);
  return M;
}
function currentLasso(pts, fill, whole) {
  const L = lassoMask(pts);
  const B0 = barrier();
  const FB = OPT.protect ? maskFromFill(fill) : null;
  const M = FC.fillRegion({ w: W, h: H, B0, FB, seed: L, allow: whole ? null : L, gap: OPT.gap, bleed: OPT.bleed });
  applyMask(M, fill, false);
  return M;
}
function maskFromFill(fill) {
  const m = new Uint8Array(W * H);
  for (let i = 0; i < m.length; i++) m[i] = fill[i * 4 + 3] >= 128 ? 1 : 0;
  return m;
}
const newFill = () => new Uint8Array(W * H * 4);

function dump(name, fill, zoomPx) {
  const c = composite(W, H, lineAlpha, fill);
  const s = scale(W, H, c, zoomPx || 2);
  writePNG(`tools/out/${name}.png`, s.w, s.h, s.rgba);
}
module.exports = { W, H, lineAlpha, OPT, barrier, strokeMask, lassoMask, applyMask, currentBrush, currentLasso, maskFromFill, newFill, dump, composite, writePNG, maskToRGBA, scale, FC };

// ---- 新 script.js 相当 ----
function cropArr(full, bx, by, bw, bh) {
  const out = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) out.set(full.subarray((by + y) * W + bx, (by + y) * W + bx + bw), y * bw);
  return out;
}
function runRegion(bx, by, bw, bh, S, allow, fill, act, erase) {
  const B0 = cropArr(barrier(), bx, by, bw, bh);
  const FB = OPT.protect && !erase ? cropArr(maskFromFill(fill), bx, by, bw, bh) : null;
  const M = FC.fillRegion({
    w: bw, h: bh, B0, FB, seed: S, allow, gap: OPT.gap, bandSeed: !erase,
    bleed: erase ? 0 : OPT.bleed,
    ink: erase ? null : cropArr(lineAlpha, bx, by, bw, bh),
    inkThr: 8,
    keep: erase ? 0 : 0.5,
    clipPad: erase ? 1 : -1,
  });
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      if (!M[i]) continue;
      const o = ((by + y) * W + bx + x) * 4;
      if (erase) { fill[o + 3] = 0; continue; }
      fill[o] = OPT.color[0]; fill[o + 1] = OPT.color[1]; fill[o + 2] = OPT.color[2]; fill[o + 3] = 255;
    }
  }
  return M;
}
function newBrush(pts0, size, fill, act) {
  const pts = pts0.slice();
  if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1]]);
  act = act || 'fill';
  const erase = act === 'erase';
  const pad = Math.ceil(size / 2) + OPT.gap + OPT.bleed + 5;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const bx = Math.max(0, Math.floor(x0 - pad)), by = Math.max(0, Math.floor(y0 - pad));
  const bw = Math.min(W, Math.ceil(x1 + pad)) - bx, bh = Math.min(H, Math.ceil(y1 + pad)) - by;
  const a = new Uint8Array(bw * bh);
  drawPolyAA(a, bw, bh, pts.map(([x, y]) => [x - bx, y - by]), size, 255, false);
  const S = new Uint8Array(bw * bh);
  for (let i = 0; i < S.length; i++) S[i] = a[i] > 0 ? 1 : 0;
  if (erase) return runRegion(bx, by, bw, bh, S, S, fill, act, erase);
  const Sf = new Uint8Array(W * H);
  for (let y = 0; y < bh; y++) Sf.set(S.subarray(y * bw, y * bw + bw), (by + y) * W + bx);
  return runRegion(0, 0, W, H, Sf, Sf, fill, act, erase);
}
function newLasso(pts, fill, act, whole) {
  act = act || 'fill';
  const erase = act === 'erase';
  const L = lassoMask(pts);
  if (whole) return runRegion(0, 0, W, H, L, null, fill, act, erase);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (L[y * W + x]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const pad = OPT.gap + OPT.bleed + 5;
  const bx = Math.max(0, x0 - pad), by = Math.max(0, y0 - pad);
  const bw = Math.min(W, x1 + pad + 1) - bx, bh = Math.min(H, y1 + pad + 1) - by;
  const Lc = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) Lc[y * bw + x] = L[(by + y) * W + bx + x];
  if (erase) return runRegion(bx, by, bw, bh, Lc, Lc, fill, act, erase);
  const Lf = new Uint8Array(W * H);
  for (let y = 0; y < bh; y++) Lf.set(Lc.subarray(y * bw, y * bw + bw), (by + y) * W + bx);
  return runRegion(0, 0, W, H, Lf, whole ? null : Lf, fill, act, erase);
}
module.exports.newBrush = newBrush;
module.exports.newLasso = newLasso;
