'use strict';
// 最小の DOM + Canvas2D スタブ（script.js を Node で動かして検証するため）
const { drawPolyAA } = require('./png.js');

class ImageData {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
}
class Ctx {
  constructor(canvas) {
    this.c = canvas;
    this.lineWidth = 1; this.strokeStyle = '#000'; this.fillStyle = '#000';
    this.lineCap = 'butt'; this.lineJoin = 'miter'; this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this._path = []; this._cur = null;
  }
  B() { return this.c._buf; }
  setTransform() {} save() {} restore() {} setLineDash() {}
  clearRect(x, y, w, h) {
    const B = this.B(), W = this.c.width;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const o = ((y + j) * W + x + i) * 4;
      B[o] = B[o + 1] = B[o + 2] = B[o + 3] = 0;
    }
  }
  beginPath() { this._path = []; this._cur = null; }
  moveTo(x, y) { this._cur = [[x, y]]; this._path.push(this._cur); }
  lineTo(x, y) { if (!this._cur) this.moveTo(x, y); else this._cur.push([x, y]); }
  closePath() { this._closed = true; }
  arc(x, y, r) { // カーソル円くらいなので無視せずパスにだけ入れる
    if (!this._cur) this.moveTo(x + r, y);
  }
  stroke() {
    const W = this.c.width, H = this.c.height, B = this.B();
    const a = new Uint8Array(W * H);
    for (const sub of this._path) drawPolyAA(a, W, H, sub, this.lineWidth, 255, false);
    for (let i = 0; i < W * H; i++) if (a[i]) { const o = i * 4; B[o + 3] = 255; }
    this._path = [];
  }
  fill() {
    const W = this.c.width, H = this.c.height, B = this.B();
    const pts = this._path[0] || [];
    if (pts.length < 3) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    for (let y = Math.max(0, y0 | 0); y <= Math.min(H - 1, y1); y++) {
      for (let x = Math.max(0, x0 | 0); x <= Math.min(W - 1, x1); x++) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if ((yi > y + 0.5) !== (yj > y + 0.5) && x + 0.5 < (xj - xi) * (y + 0.5 - yi) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) { const o = (y * W + x) * 4; B[o + 3] = 255; }
      }
    }
    this._path = [];
  }
  getImageData(x, y, w, h) {
    const B = this.B(), W = this.c.width, out = new ImageData(w, h);
    for (let j = 0; j < h; j++) out.data.set(B.subarray(((y + j) * W + x) * 4, ((y + j) * W + x + w) * 4), j * w * 4);
    return out;
  }
  putImageData(img, x, y) {
    const B = this.B(), W = this.c.width;
    for (let j = 0; j < img.height; j++) B.set(img.data.subarray(j * img.width * 4, (j + 1) * img.width * 4), ((y + j) * W + x) * 4);
  }
  drawImage(src, dx, dy) {
    const W = this.c.width, B = this.B();
    const SB = src._buf || src._pixels;
    const SW = src.width;
    for (let j = 0; j < src.height; j++) B.set(SB.subarray(j * SW * 4, (j + 1) * SW * 4), ((dy + j) * W + dx) * 4);
  }
}
class Canvas {
  constructor(id) {
    this.id = id; this._w = 300; this._h = 150; this._buf = new Uint8ClampedArray(300 * 150 * 4);
    this.style = {}; this._ctx = new Ctx(this);
  }
  get width() { return this._w; }
  set width(v) { this._w = v | 0; this._buf = new Uint8ClampedArray(this._w * this._h * 4); }
  get height() { return this._h; }
  set height(v) { this._h = v | 0; this._buf = new Uint8ClampedArray(this._w * this._h * 4); }
  getContext() { return this._ctx; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  setPointerCapture() {} addEventListener(t, f) { (this._ls ||= {})[t] = f; }
  dispatch(t, e) { if (this._ls && this._ls[t]) this._ls[t](e); }
  toBlob(cb) { cb(new Blob([])); }
}
class El {
  constructor(id, tag) {
    this.id = id; this.tagName = tag || 'DIV'; this.value = ''; this.checked = false; this.hidden = false;
    this.disabled = false; this.textContent = ''; this.title = ''; this.style = {}; this.dataset = {};
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
    this.children = [];
  }
  addEventListener(t, f) { (this._ls ||= {})[t] = f; }
  dispatch(t, e) { if (this._ls && this._ls[t]) this._ls[t](e || { target: this }); }
  setAttribute() {} getAttribute() { return null; }
  appendChild() {} remove() {} click() {}
  matches() { return false; }
  querySelector() { return null; }
  contains() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  set width(v) { this._w = v; } get width() { return this._w || 0; }
  set height(v) { this._h = v; } get height() { return this._h || 0; }
}
function makeDom(ids, radioDef, initState) {
  const els = {};
  for (const id of ids) els[id] = id === 'fill' || id === 'line' || id === 'ov' ? new Canvas(id) : new El(id);
  els.wrap = Object.assign(els.wrap, { clientWidth: 900, clientHeight: 700 });
  // 既定値
  Object.assign(els.thr, { value: '50', type: 'range' });
  Object.assign(els.gap, { value: '8', type: 'range' });
  Object.assign(els.bleed, { value: '0', type: 'range' });
  Object.assign(els.brush, { value: '40', type: 'range', min: '1', max: '300' });
  Object.assign(els.pct, { value: '3', type: 'range' });
  els.conv.checked = true; els.protect.checked = true; els.showL.checked = true; els.showF.checked = true;
  els.color = Object.assign(els.color, { value: '#f2b8a0', type: 'color' });
  // ラジオボタン（本物の radio グループらしく排他で checked を管理）
  const state = Object.assign({}, initState);
  const groups = {};
  for (const name of Object.keys(radioDef)) {
    groups[name] = radioDef[name].map(v => {
      const e = new El(name + '-' + v, 'INPUT');
      e.type = 'radio'; e.name = name; e.value = v;
      Object.defineProperty(e, 'checked', {
        get: () => state[name] === v,
        set: on => { if (on) state[name] = v; },
      });
      return e;
    });
    if (!(name in state)) state[name] = radioDef[name][0];
  }
  const qsa = sel => {
    const out = [];
    for (const part of sel.split(',')) {
      const p = part.trim();
      const m = p.match(/^input\[name="(\w+)"\](:checked)?(\[value="(\w+)"\])?$/);
      if (m) {
        const list = groups[m[1]] || [];
        if (m[2]) { const c = list.find(e => e.checked); if (c) out.push(c); }
        else if (m[4]) { const c = list.find(e => e.value === m[4]); if (c) out.push(c); }
        else out.push(...list);
      }
    }
    return out;
  };
  const document = {
    getElementById: id => els[id] || (els[id] = new El(id)),
    querySelector: sel => (qsa(sel)[0] || null),
    querySelectorAll: sel => qsa(sel),
    createElement: tag => (tag === 'canvas' ? new Canvas('tmp' + Math.random()) : new El('tmp', tag.toUpperCase())),
    addEventListener() {}, body: new El('body'),
  };
  return { els, document, qsa, state };
}
module.exports = { makeDom, Canvas, El, Ctx, ImageData };
