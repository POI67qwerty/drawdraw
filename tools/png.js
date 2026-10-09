'use strict';
// 依存なしの最小 PNG 書き出し（RGBA）＋ 簡単な AA ラスタライズ。テスト用。
const zlib = require('node:zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 2x2 スーパーサンプリングで線分を AA 描画。alpha 0..255 のグレースケール配列に足し込む
function drawLineAA(a, w, h, x0, y0, x1, y1, lw, alpha = 255) {
  const S = 4, r = lw / 2;
  const minx = Math.max(0, Math.floor(Math.min(x0, x1) - r - 2)), maxx = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + r + 2));
  const miny = Math.max(0, Math.floor(Math.min(y0, y1) - r - 2)), maxy = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + r + 2));
  const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1;
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      let cnt = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const px = x + (sx + 0.5) / S - 0.5, py = y + (sy + 0.5) / S - 0.5;
        let t = ((px - x0) * dx + (py - y0) * dy) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = x0 + t * dx, qy = y0 + t * dy;
        if (Math.hypot(px - qx, py - qy) <= r) cnt++;
      }
      if (!cnt) continue;
      const v = Math.round(alpha * cnt / (S * S));
      const i = y * w + x;
      a[i] = Math.min(255, a[i] + v);
    }
  }
}
function drawPolyAA(a, w, h, pts, lw, alpha = 255, close = true) {
  for (let i = 0; i + 1 < pts.length; i++) drawLineAA(a, w, h, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], lw, alpha);
  if (close && pts.length > 2) {
    const p = pts[pts.length - 1], q = pts[0];
    drawLineAA(a, w, h, p[0], p[1], q[0], q[1], lw, alpha);
  }
}
function circlePts(cx, cy, R, n = 200) {
  const p = [];
  for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2; p.push([cx + R * Math.cos(t), cy + R * Math.sin(t)]); }
  return p;
}
// 円弧（角度 a0..a1、rad）
function arcPts(cx, cy, R, a0, a1, n = 120) {
  const p = [];
  for (let i = 0; i <= n; i++) { const t = a0 + (a1 - a0) * i / n; p.push([cx + R * Math.cos(t), cy + R * Math.sin(t)]); }
  return p;
}
module.exports = { encodePNG, drawLineAA, drawPolyAA, circlePts, arcPts };
