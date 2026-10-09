/* 囲って塗るツール：画面の操作・描画・履歴・保存（塗りの計算は fillcore.js）
 *
 * 操作の流れ
 *   ブラシ/投げ縄でなぞる・囲む → 指を離した時に計算 → 塗り/消し/塗り分けを反映（元に戻せる）
 */
(function () {
  'use strict';

  const FC = window.FillCore;
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = n => Number(n).toLocaleString('ja-JP');

  const IS_IOS = /iP(ad|hone|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_APPLE = IS_IOS || /Mac/.test(navigator.platform || navigator.userAgent);
  const MOD = IS_APPLE ? '⌘' : 'Ctrl+';
  // iOS の canvas は約 1,677 万画素が上限。大きな画像はそれに合わせて縮小する
  const MAX_PX = IS_IOS ? 16.7e6 : 25e6;
  const HISTORY_BYTES = 200e6, HISTORY_STEPS = 50;
  const ACOL = { fill: '#2f6bff', erase: '#e0443e', split: '#1aa36b' };

  const fillC = $('fill'), lineC = $('line'), ovC = $('ov'), stack = $('stack'), wrap = $('wrap');
  const fctx = fillC.getContext('2d', { willReadFrequently: true });
  const lctx = lineC.getContext('2d', { willReadFrequently: true });
  const octx = ovC.getContext('2d');
  const srcC = document.createElement('canvas');
  const sctx = srcC.getContext('2d', { willReadFrequently: true });

  let W = 0, H = 0, zoom = 1, baseName = 'image';
  let lineAlpha = null;                 // 線の濃さ 0..255（W*H）
  let barrier = null, barrierThr = -1;  // しきい値で二値化した線（キャッシュ）
  let undoStack = [], redoStack = [];
  let action = 'fill', shape = 'brush';
  let busy = false;
  let spaceDown = false, panToolOn = false;
  let stroke = null;                    // 進行中のなぞり／囲み { id, kind, pts }
  let hoverPt = null, rafId = 0;
  const ptrs = new Map();               // 押している指・ペン
  let gesture = null, panning = null, lastPenAt = 0;

  // ---------- 小さな補助 ----------
  const radio = name => { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : ''; };
  const num = id => +$(id).value;
  const traceOn = () => radio('trace') !== 'raw';
  const useTrace = () => traceOn() || action === 'split';   // 塗り分けは常に線に沿う
  const wholeRange = () => radio('range') === 'whole';
  const protectOn = () => $('protect').checked;
  const brushSize = () => num('brush');
  const hexRGB = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const status = t => { $('st').textContent = t; };
  const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  function hsl(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = n => { const k = (n + h / 30) % 12; return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255; };
    return [f(0), f(8), f(4)];
  }

  // 全体配列（幅 W）から矩形を切り出す
  function crop(full, bx, by, bw, bh) {
    const out = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const s = (by + y) * W + bx;
      out.set(full.subarray(s, s + bw), y * bw);
    }
    return out;
  }
  // 既存の塗り（不透明な画素）のマスク
  function fillMaskOf(bx, by, bw, bh) {
    const d = fctx.getImageData(bx, by, bw, bh).data, out = new Uint8Array(bw * bh);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
    return out;
  }
  // マスクの外接矩形
  function boundsOf(M, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (!M[row + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  // 二値化した線（しきい値が変わったら作り直す）
  function getBarrier() {
    const thr = num('thr');
    if (barrier && barrierThr === thr) return barrier;
    const n = W * H, B = new Uint8Array(n);
    for (let i = 0; i < n; i++) B[i] = lineAlpha[i] >= thr ? 1 : 0;
    barrier = B; barrierThr = thr;
    return B;
  }

  // ---------- 画像の読み込み ----------
  function openFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); setImage(img, file.name); };
    img.onerror = () => { URL.revokeObjectURL(url); status('画像を読み込めませんでした'); };
    img.src = url;
  }

  function setImage(img, name) {
    let w = img.naturalWidth, h = img.naturalHeight, note = '';
    if (!w || !h) { status('画像が空です'); return; }
    if (w * h > MAX_PX) {
      const s = Math.sqrt(MAX_PX / (w * h));
      w = Math.floor(w * s); h = Math.floor(h * s);
      note = `（メモリ節約のため ${Math.round(s * 100)}% に縮小）`;
    }
    W = w; H = h;
    baseName = (name || 'image').replace(/\.[^.]+$/, '') || 'image';
    $('fname').textContent = name || '';
    srcC.width = W; srcC.height = H;
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(img, 0, 0, W, H);
    [fillC, lineC, ovC].forEach(c => { c.width = W; c.height = H; });
    undoStack = []; redoStack = [];
    barrier = null;
    const opaque = buildLine();
    stack.hidden = false;
    $('empty').hidden = true;
    $('size').textContent = `${fmt(W)} × ${fmt(H)}`;
    fit();
    updateHistoryButtons();
    if (opaque && !$('conv').checked) {
      status('線画を開きました。白背景なら「白背景の画像を透過化」をオンにしてください');
    } else {
      status(`${fmt(W)} × ${fmt(H)} を開きました${note}`);
    }
  }

  // 線画から「線の濃さ」を作る。不透明な画像で「白背景を透過化」がオンなら明るさを線の濃さに変換する
  function buildLine() {
    lctx.clearRect(0, 0, W, H);
    lctx.drawImage(srcC, 0, 0);
    const d = lctx.getImageData(0, 0, W, H), p = d.data, n = W * H;
    let opaque = true;
    for (let i = 3; i < p.length; i += 4) if (p[i] < 255) { opaque = false; break; }
    if ($('conv').checked && opaque) {
      for (let i = 0; i < p.length; i += 4) {
        const l = .299 * p[i] + .587 * p[i + 1] + .114 * p[i + 2];
        p[i] = p[i + 1] = p[i + 2] = 0;
        p[i + 3] = 255 - l;
      }
      lctx.putImageData(d, 0, 0);
    }
    lineAlpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) lineAlpha[i] = p[i * 4 + 3];
    barrier = null;
    return opaque;
  }

  // ---------- 表示（倍率・スクロール）----------
  function applySize() {
    stack.style.width = W * zoom + 'px';
    stack.style.height = H * zoom + 'px';
    stack.classList.toggle('px', zoom >= 2);
    $('zl').textContent = Math.round(zoom * 100) + '%';
  }
  function fit() {
    if (!W) return;
    const pad = 40;
    zoom = clamp(Math.min((wrap.clientWidth - pad) / W, (wrap.clientHeight - pad) / H), .05, 32);
    applySize();
    wrap.scrollLeft = 0; wrap.scrollTop = 0;
  }
  // (cx, cy) の位置にある画像の点を動かさないように拡大縮小する（画面座標）
  function zoomAt(z, cx, cy) {
    if (!W) return;
    z = clamp(z, .05, 32);
    const r0 = stack.getBoundingClientRect();
    const ix = (cx - r0.left) / zoom, iy = (cy - r0.top) / zoom;
    zoom = z;
    applySize();
    const r1 = stack.getBoundingClientRect();
    wrap.scrollLeft += r1.left + ix * zoom - cx;
    wrap.scrollTop += r1.top + iy * zoom - cy;
  }
  function zoomCenter(z) {
    const r = wrap.getBoundingClientRect();
    zoomAt(z, r.left + r.width / 2, r.top + r.height / 2);
  }

  // ---------- 画面上の描画（囲み線・ブラシの跡・カーソル）----------
  function drawOverlay() {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, W, H);
    if (!W) return;
    const z = zoom, col = ACOL[action];
    octx.save();
    octx.lineJoin = 'round';
    octx.lineCap = 'round';
    if (stroke && stroke.pts.length) {
      const P = stroke.pts;
      octx.strokeStyle = col;
      octx.beginPath();
      P.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
      if (stroke.kind === 'lasso') {
        octx.closePath();
        octx.setLineDash([6 / z, 4 / z]);
        octx.lineWidth = 2 / z;
        octx.stroke();
      } else {
        octx.globalAlpha = .4;
        octx.lineWidth = brushSize();
        octx.stroke();
      }
    } else if (hoverPt && shape === 'brush') {
      octx.strokeStyle = col;
      octx.lineWidth = 1.5 / z;
      octx.beginPath();
      octx.arc(hoverPt[0], hoverPt[1], brushSize() / 2, 0, Math.PI * 2);
      octx.stroke();
    }
    octx.restore();
  }
  function requestOverlay() {
    if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; drawOverlay(); });
  }

  // ---------- 履歴（元に戻す／やり直し）----------
  function snap(x, y, w, h) {
    undoStack.push({ x, y, img: fctx.getImageData(x, y, w, h) });
    redoStack = [];
    let total = 0;
    for (const s of undoStack) total += s.img.data.length;
    while (undoStack.length > 1 && (total > HISTORY_BYTES || undoStack.length > HISTORY_STEPS)) {
      total -= undoStack[0].img.data.length;
      undoStack.shift();
    }
    updateHistoryButtons();
  }
  function swap(from, to) {
    const s = from.pop();
    if (!s) return;
    const cur = { x: s.x, y: s.y, img: fctx.getImageData(s.x, s.y, s.img.width, s.img.height) };
    fctx.putImageData(s.img, s.x, s.y);
    to.push(cur);
    updateHistoryButtons();
    drawOverlay();
  }
  const undo = () => { if (!busy && W) swap(undoStack, redoStack); };
  const redo = () => { if (!busy && W) swap(redoStack, undoStack); };
  function updateHistoryButtons() {
    $('undo').disabled = !undoStack.length;
    $('redo').disabled = !redoStack.length;
  }

  // ---------- 反映 ----------
  // マスク M（矩形 bx,by,bw,bh）を塗る、または消す
  function applyMask(bx, by, bw, bh, M, erase) {
    let cnt = 0;
    for (let i = 0; i < M.length; i++) cnt += M[i];
    if (!cnt) return 0;
    snap(bx, by, bw, bh);
    const img = fctx.getImageData(bx, by, bw, bh), d = img.data;
    if (erase) {
      for (let i = 0; i < M.length; i++) if (M[i]) d[i * 4 + 3] = 0;
    } else {
      const [r, g, b] = hexRGB($('color').value);
      for (let i = 0; i < M.length; i++) {
        if (!M[i]) continue;
        d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
      }
    }
    fctx.putImageData(img, bx, by);
    return cnt;
  }
  // グループごとに色を変えて塗る（塗り分け）
  function paintGroups(bx, by, bw, bh, grp, G) {
    if (!G) return '塗れる領域がありませんでした';
    const seed = Math.random() * 360, LV = [.58, .5, .66];
    const cols = [null];
    for (let g = 1; g <= G; g++) cols.push(hsl((seed + (g - 1) * 137.508) % 360, .62, LV[(g - 1) % 3]));
    snap(bx, by, bw, bh);
    const img = fctx.getImageData(bx, by, bw, bh), d = img.data;
    for (let i = 0; i < grp.length; i++) {
      const g = grp[i];
      if (!g) continue;
      const c = cols[g];
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
    }
    fctx.putImageData(img, bx, by);
    return `${G} つの領域に塗り分けました`;
  }
  const doneMsg = (n, act) => (n ? `${fmt(n)} px ${act === 'erase' ? '消しました' : '塗りました'}` : '変化はありませんでした');

  // 線の区切りで塗る／消す（全体座標 S を出発点とする）
  function traceFull(S, act) {
    const B0 = getBarrier();
    const FB = protectOn() && act !== 'erase' ? fillMaskOf(0, 0, W, H) : null;
    const gap = num('gap');
    if (act === 'split') {
      const { grp, G } = FC.splitRegion({
        w: W, h: H, B0, FB, seed: S, allow: null, gap,
        objMode: radio('smode') === 'obj', pct: num('pct'),
      });
      return paintGroups(0, 0, W, H, grp, G);
    }
    const M = FC.fillRegion({ w: W, h: H, B0, FB, seed: S, allow: null, gap, bleed: num('bleed') });
    const bb = boundsOf(M, W, H);
    if (!bb) return '塗れる領域がありませんでした';
    return doneMsg(applyMask(bb.x, bb.y, bb.w, bb.h, crop(M, bb.x, bb.y, bb.w, bb.h), act === 'erase'), act);
  }

  // 囲みの box（画面の内側を含む矩形）と内側マスク
  function lassoBox(P, whole) {
    let bx = 0, by = 0, bw = W, bh = H;
    if (!whole) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of P) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      const pad = num('gap') + 3;
      bx = clamp(Math.floor(x0) - pad, 0, W - 1);
      by = clamp(Math.floor(y0) - pad, 0, H - 1);
      bw = clamp(Math.ceil(x1) + pad, 1, W) - bx;
      bh = clamp(Math.ceil(y1) + pad, 1, H) - by;
    }
    if (bw < 1 || bh < 1) return null;
    const c = mkCanvas(bw, bh), x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#000';
    x.beginPath();
    P.forEach(([px, py], i) => { const X = px - bx, Y = py - by; if (i) x.lineTo(X, Y); else x.moveTo(X, Y); });
    x.closePath();
    x.fill();
    const a = x.getImageData(0, 0, bw, bh).data, L = new Uint8Array(bw * bh);
    let any = 0;
    for (let i = 0; i < L.length; i++) if (a[i * 4 + 3] >= 128) { L[i] = 1; any++; }
    return any ? { bx, by, bw, bh, L } : null;
  }

  // 投げ縄の計算
  function jobLasso(P) {
    const act = action, erase = act === 'erase', tr = useTrace();
    const whole = wholeRange() && act !== 'split' && tr;
    const R = lassoBox(P, whole);
    if (!R) return '囲みが小さすぎます';
    if (!tr) return doneMsg(applyMask(R.bx, R.by, R.bw, R.bh, R.L, erase), act);
    const B0 = crop(getBarrier(), R.bx, R.by, R.bw, R.bh);
    const FB = protectOn() && !erase ? fillMaskOf(R.bx, R.by, R.bw, R.bh) : null;
    const gap = num('gap');
    if (act === 'split') {
      const { grp, G } = FC.splitRegion({
        w: R.bw, h: R.bh, B0, FB, seed: R.L, allow: R.L, gap,
        objMode: radio('smode') === 'obj', pct: num('pct'),
      });
      return paintGroups(R.bx, R.by, R.bw, R.bh, grp, G);
    }
    const M = FC.fillRegion({
      w: R.bw, h: R.bh, B0, FB, seed: R.L, allow: whole ? null : R.L, gap, bleed: num('bleed'),
    });
    return doneMsg(applyMask(R.bx, R.by, R.bw, R.bh, M, erase), act);
  }

  // ブラシ（なぞった線）の計算
  function strokeCanvas(P, size, bx, by, bw, bh, color) {
    const c = mkCanvas(bw, bh), x = c.getContext('2d');
    x.lineCap = 'round';
    x.lineJoin = 'round';
    x.lineWidth = size;
    x.strokeStyle = color;
    x.beginPath();
    P.forEach(([px, py], i) => { const X = px - bx, Y = py - by; if (i) x.lineTo(X, Y); else x.moveTo(X, Y); });
    x.stroke();
    return c;
  }
  function jobBrush(P, size) {
    const act = action, erase = act === 'erase', tr = useTrace();
    const pad = Math.ceil(size / 2) + 3;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of P) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const bx = clamp(Math.floor(x0 - pad), 0, W - 1), by = clamp(Math.floor(y0 - pad), 0, H - 1);
    const bw = clamp(Math.ceil(x1 + pad), 1, W) - bx, bh = clamp(Math.ceil(y1 + pad), 1, H) - by;
    if (!tr) {
      // 線を無視：なぞった所をそのまま塗る／消す（ふちは柔らかく）
      const c = strokeCanvas(P, size, bx, by, bw, bh, erase ? '#000' : $('color').value);
      snap(bx, by, bw, bh);
      fctx.save();
      if (erase) fctx.globalCompositeOperation = 'destination-out';
      fctx.drawImage(c, bx, by);
      fctx.restore();
      return erase ? 'なぞった所を消しました' : 'なぞった所を塗りました';
    }
    // 線に沿う：なぞった所を出発点にして、触れた領域を線の区切りで塗る
    const a = strokeCanvas(P, size, bx, by, bw, bh, '#000').getContext('2d').getImageData(0, 0, bw, bh).data;
    const S = new Uint8Array(W * H);
    for (let y = 0; y < bh; y++) {
      const row = (by + y) * W + bx;
      for (let x = 0; x < bw; x++) if (a[(y * bw + x) * 4 + 3]) S[row + x] = 1;
    }
    return traceFull(S, act);
  }

  // 計算は少し遅らせて、囲みの線を先に消す（画面がもたつかないように）
  function runJob(label, fn) {
    if (busy) return;
    busy = true;
    status(label);
    setTimeout(() => {
      try {
        const msg = fn();
        status(msg || '完了');
      } catch (err) {
        console.error(err);
        status('処理に失敗しました：' + ((err && err.message) || err));
      } finally {
        busy = false;
        drawOverlay();
        updateHistoryButtons();
      }
    }, 30);
  }
  function finishStroke(s) {
    const P = s.pts.slice();
    if (s.kind === 'brush') {
      if (P.length === 1) P.push([P[0][0] + 0.01, P[0][1]]);   // 1 回のタップも点として塗る
    } else if (P.length < 3) {
      status('もう少し大きく囲んでください');
      return;
    }
    const size = brushSize();
    runJob(s.kind === 'lasso' ? '囲んだ範囲を処理中…' : '処理中…', () => (s.kind === 'lasso' ? jobLasso(P) : jobBrush(P, size)));
  }

  // ---------- ポインター（マウス・タッチ・ペン）----------
  const toImg = e => {
    const r = ovC.getBoundingClientRect();
    return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height];
  };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;

  function onDown(e) {
    if (!W || busy) return;
    if (e.pointerType === 'pen') lastPenAt = performance.now();
    // Apple Pencil 使用中に触れた手のひらは無視する
    if (e.pointerType === 'touch' && performance.now() - lastPenAt < 1500) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    try { ovC.setPointerCapture(e.pointerId); } catch (_) { /* 古い環境では無視 */ }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (ptrs.size >= 2) {
      // 2 本指：拡大縮小と移動。描きかけの囲みは取り消す
      stroke = null;
      panning = null;
      drawOverlay();
      const [a, b] = [...ptrs.values()];
      gesture = { d: dist(a, b), z: zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      wrap.classList.add('grabbing');
      return;
    }
    if (spaceDown || panToolOn || e.button === 1) {
      panning = { id: e.pointerId, x: e.clientX, y: e.clientY };
      wrap.classList.add('grabbing');
      return;
    }
    const p = toImg(e);
    stroke = { id: e.pointerId, kind: shape === 'lasso' ? 'lasso' : 'brush', pts: [p] };
    hoverPt = p;
    drawOverlay();
  }

  function onMove(e) {
    const info = ptrs.get(e.pointerId);
    if (info) { info.x = e.clientX; info.y = e.clientY; }
    if (gesture && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      zoomAt(gesture.z * dist(a, b) / gesture.d, mx, my);
      wrap.scrollLeft -= mx - gesture.mx;
      wrap.scrollTop -= my - gesture.my;
      gesture.mx = mx; gesture.my = my;
      return;
    }
    if (panning && panning.id === e.pointerId) {
      wrap.scrollLeft -= e.clientX - panning.x;
      wrap.scrollTop -= e.clientY - panning.y;
      panning.x = e.clientX; panning.y = e.clientY;
      return;
    }
    if (!W) return;
    const p = toImg(e);
    if (stroke && stroke.id === e.pointerId) {
      hoverPt = p;
      const q = stroke.pts[stroke.pts.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 1) stroke.pts.push(p);
      requestOverlay();
      return;
    }
    if (!stroke && e.pointerType !== 'touch') {
      hoverPt = p;
      drawOverlay();
    }
  }

  function onUp(e) {
    ptrs.delete(e.pointerId);
    if (gesture) {
      if (ptrs.size < 2) { gesture = null; wrap.classList.remove('grabbing'); }
      return;
    }
    if (panning && panning.id === e.pointerId) {
      panning = null;
      wrap.classList.remove('grabbing');
      return;
    }
    if (stroke && stroke.id === e.pointerId) {
      const s = stroke;
      stroke = null;
      if (e.type === 'pointerup') finishStroke(s);
      drawOverlay();
    }
  }

  ovC.addEventListener('pointerdown', onDown);
  ovC.addEventListener('pointermove', onMove);
  ovC.addEventListener('pointerup', onUp);
  ovC.addEventListener('pointercancel', onUp);
  ovC.addEventListener('pointerleave', () => {
    if (!stroke && !ptrs.size) { hoverPt = null; drawOverlay(); }
  });

  // トラックパッドのピンチ（ctrl + ホイール）で拡大縮小。通常のスクロールはブラウザに任せる
  wrap.addEventListener('wheel', e => {
    if (!W || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomAt(zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
  }, { passive: false });

  // Safari のトラックパッドのピンチ（ジェスチャー）
  let gestureBase = null;
  addEventListener('gesturestart', e => { if (!W) return; e.preventDefault(); gestureBase = zoom; }, { passive: false });
  addEventListener('gesturechange', e => {
    if (!W || gestureBase == null || ptrs.size) return;
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    zoomAt(gestureBase * e.scale, e.clientX ?? r.left + r.width / 2, e.clientY ?? r.top + r.height / 2);
  }, { passive: false });
  addEventListener('gestureend', () => { gestureBase = null; });

  // ---------- 保存・コピー ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function savePNG(withLine, white, suffix) {
    if (!W) return;
    const c = mkCanvas(W, H), x = c.getContext('2d');
    if (white) { x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); }
    x.drawImage(fillC, 0, 0);
    if (withLine) x.drawImage(lineC, 0, 0);
    const name = baseName + suffix + '.png';
    c.toBlob(bl => { download(bl, name); status(`${name} を保存しました`); }, 'image/png');
  }
  document.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => {
    const [withLine, white, suffix] = b.dataset.s.split(',');
    savePNG(withLine === '1', white === '1', suffix);
    closeMenu();
  }));
  $('copyFill').addEventListener('click', () => {
    closeMenu();
    if (!W) return;
    if (!navigator.clipboard || !window.ClipboardItem) { status('このブラウザはコピーに未対応です。保存を使ってください'); return; }
    // クリックの直後に書き込みを始める（Safari 対策で Blob は Promise で渡す）
    const item = new ClipboardItem({ 'image/png': new Promise(r => fillC.toBlob(r, 'image/png')) });
    navigator.clipboard.write([item]).then(
      () => status('塗りをコピーしました'),
      () => status('コピーできませんでした。保存を使ってください')
    );
  });
  function saveAs() { savePNG(true, false, '_art_alpha'); }

  function closeMenu() { const m = $('menu'); if (m) m.open = false; }
  document.addEventListener('click', e => {
    const m = $('menu');
    if (m.open && !m.contains(e.target)) closeMenu();
  });

  // ---------- 画面の見た目（設定に応じて表示する項目）----------
  function refreshPanel() {
    action = radio('action');
    shape = radio('shape');
    const isSplit = action === 'split', isLasso = shape === 'lasso', tr = traceOn();
    const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
    show('row-trace', !isSplit);
    show('row-range', isLasso && !isSplit && tr);
    show('row-gap', isSplit || tr);
    show('row-bleed', !isSplit && tr);
    show('row-protect', action !== 'erase' && (isSplit || tr));
    show('row-color', action === 'fill');
    show('sec-brush', shape === 'brush');
    show('sec-split', isSplit);
    show('row-pct', isSplit && radio('smode') === 'parts');
    document.querySelectorAll('.tool').forEach(t => t.classList.toggle('on', !!t.querySelector('input:checked')));
    stack.dataset.tool = shape;
    const names = { fill: '塗る', erase: '消す', split: '塗り分け' };
    const how = { brush: 'ブラシでなぞる', lasso: '投げ縄で囲む' };
    const help = {
      fill: { brush: '塗りたい所をなぞると、線で区切られた領域が塗られます', lasso: '塗りたい所を囲むと、囲みの中の領域が塗られます' },
      erase: { brush: '消したい所をなぞると、線で区切られた領域が消えます', lasso: '消したい所を囲むと、囲みの中の領域が消えます' },
      split: { brush: 'なぞった領域を、線で区切られたパーツごとに別の色で塗り分けます', lasso: '囲みの中を、線で区切られたパーツごとに別の色で塗り分けます' },
    };
    $('hint').textContent = `${names[action]}：${how[shape]}。` + (!tr && !isSplit ? '（線を無視：なぞった所をそのまま）' : help[action][shape]);
    drawOverlay();
  }
  function setRadio(name, value) {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
    refreshPanel();
    saveSettings();
  }
  function togglePan() {
    panToolOn = !panToolOn;
    $('pan').setAttribute('aria-pressed', String(panToolOn));
    wrap.classList.toggle('grab', panToolOn);
    status(panToolOn ? '移動モード：ドラッグで表示位置を動かせます' : '');
  }
  function nudgeBrush(d) {
    const el = $('brush');
    el.value = clamp(+el.value + d * Math.max(1, Math.round(+el.value * 0.12)), +el.min, +el.max);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ---------- 設定の保存・復元 ----------
  const KEY = 'drawdraw-settings';
  const PERSIST_IDS = ['thr', 'conv', 'gap', 'bleed', 'protect', 'color', 'brush', 'pct'];
  const PERSIST_RADIO = ['trace', 'range', 'smode'];
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { s = {}; }
    for (const id of PERSIST_IDS) {
      const el = $(id);
      if (!el || !(id in s)) continue;
      if (el.type === 'checkbox') el.checked = !!s[id]; else el.value = s[id];
    }
    for (const name of PERSIST_RADIO) {
      if (!(name in s)) continue;
      const el = document.querySelector(`input[name="${name}"][value="${s[name]}"]`);
      if (el) el.checked = true;
    }
  }
  function saveSettings() {
    const s = {};
    for (const id of PERSIST_IDS) {
      const el = $(id);
      if (el) s[id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    for (const name of PERSIST_RADIO) s[name] = radio(name);
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) { /* 保存できなくても動作には影響しない */ }
  }
  function bindOutputs() {
    document.querySelectorAll('output[data-for]').forEach(o => {
      const el = $(o.dataset.for);
      const f = () => { o.textContent = el.value; };
      el.addEventListener('input', f);
      f();
    });
  }
  function markSwatch() {
    const v = $('color').value.toLowerCase();
    document.querySelectorAll('.sw').forEach(b => b.classList.toggle('on', b.dataset.color.toLowerCase() === v));
  }

  // ---------- イベント登録 ----------
  $('file').addEventListener('change', e => { openFile(e.target.files[0]); e.target.value = ''; });
  addEventListener('paste', e => {
    const items = [...((e.clipboardData && e.clipboardData.items) || [])];
    const it = items.find(i => i.type && i.type.startsWith('image/'));
    if (it) { e.preventDefault(); openFile(it.getAsFile()); }
  });
  addEventListener('dragover', e => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  addEventListener('drop', e => {
    const f = [...((e.dataTransfer && e.dataTransfer.files) || [])].find(f => f.type.startsWith('image/'));
    if (f) { e.preventDefault(); openFile(f); }
  });

  document.querySelectorAll('input[name="action"], input[name="shape"]').forEach(el =>
    el.addEventListener('change', () => { refreshPanel(); saveSettings(); }));
  document.querySelectorAll('input[name="trace"], input[name="range"], input[name="smode"]').forEach(el =>
    el.addEventListener('change', () => { refreshPanel(); saveSettings(); }));
  document.addEventListener('input', e => {
    if (e.target.matches('input[type="range"], input[type="color"]')) saveSettings();
    if (e.target.id === 'brush') drawOverlay();
    if (e.target.id === 'color') markSwatch();
  });
  document.addEventListener('change', e => {
    if (e.target.matches('input[type="checkbox"], input[type="color"]')) saveSettings();
  });
  $('conv').addEventListener('change', () => {
    if (!W) return;
    barrier = null;
    buildLine();
    drawOverlay();
    status('線画の読み取りを更新しました');
  });
  document.querySelectorAll('.sw').forEach(b => b.addEventListener('click', () => {
    $('color').value = b.dataset.color;
    markSwatch();
    saveSettings();
  }));

  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('zi').addEventListener('click', () => zoomCenter(zoom * 1.25));
  $('zo').addEventListener('click', () => zoomCenter(zoom / 1.25));
  $('zl').addEventListener('click', () => zoomCenter(1));
  $('fit').addEventListener('click', fit);
  $('showL').addEventListener('change', e => { lineC.style.display = e.target.checked ? '' : 'none'; });
  $('showF').addEventListener('change', e => { fillC.style.display = e.target.checked ? '' : 'none'; });
  $('chk').addEventListener('change', e => stack.classList.toggle('chk', e.target.checked));

  $('pan').addEventListener('click', togglePan);
  $('togglePanel').addEventListener('click', () => {
    const p = $('panel');
    const open = !p.classList.contains('open');
    p.classList.toggle('open', open);
    $('togglePanel').setAttribute('aria-expanded', String(open));
  });
  $('bAll').addEventListener('click', () => {
    if (!W) { status('先に画像を開いてください'); return; }
    runJob('画像全体を塗り分け中…', () => traceFull(new Uint8Array(W * H).fill(1), 'split'));
  });
  $('clr').addEventListener('click', () => {
    closeMenu();
    if (!W) return;
    snap(0, 0, W, H);
    fctx.clearRect(0, 0, W, H);
    status('塗りを消しました（元に戻せます）');
  });

  addEventListener('keydown', e => {
    const t = e.target;
    if (t && /^(TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (mod) {
      const kl = k.toLowerCase();
      if (kl === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (kl === 'y') { e.preventDefault(); redo(); }
      else if (kl === 's') { e.preventDefault(); saveAs(); }
      return;
    }
    if (k === ' ') {
      e.preventDefault();
      if (!e.repeat) { spaceDown = true; wrap.classList.add('grab'); }
      return;
    }
    if (k === 'Escape') {
      closeMenu();
      if (stroke) { stroke = null; hoverPt = null; drawOverlay(); status('取り消しました'); }
      return;
    }
    switch (k.toLowerCase()) {
      case 'f': setRadio('action', 'fill'); break;
      case 'e': setRadio('action', 'erase'); break;
      case 's': setRadio('action', 'split'); break;
      case 'b': setRadio('shape', 'brush'); break;
      case 'l': setRadio('shape', 'lasso'); break;
      case 'h': togglePan(); break;
      case '[': nudgeBrush(-1); break;
      case ']': nudgeBrush(1); break;
      case '0': fit(); break;
      case '1': zoomCenter(1); break;
      case '+': case '=': zoomCenter(zoom * 1.25); break;
      case '-': zoomCenter(zoom / 1.25); break;
      default: break;
    }
  });
  addEventListener('keyup', e => {
    if (e.key === ' ') {
      spaceDown = false;
      if (!panToolOn && !panning) wrap.classList.remove('grab');
    }
  });

  // ---------- 初期化 ----------
  loadSettings();
  bindOutputs();
  markSwatch();
  refreshPanel();
  updateHistoryButtons();
  status(IS_APPLE ? `画像を開いてください（${MOD}V で貼り付けもできます）` : '画像を開いてください（Ctrl+V で貼り付けもできます）');
})();
