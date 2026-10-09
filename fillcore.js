/*
 * 囲って塗るツールの計算コア（DOM / Canvas に依存しない純粋な処理）
 *
 * すべての配列は幅 w・高さ h の画像を行優先で並べたもの（長さ w*h、1 = 対象）。
 *   B0    : 線（1 = 線あり）
 *   FB    : 既存の塗り（1 = 塗り済み）。省略可（既存の塗りを守るときだけ渡す）
 *   seed  : 出発点（投げ縄の内側・ブラシで触れた所）
 *   allow : 行き来してよい範囲（1 = 可）。null なら画像全体
 *   gap   : 隙間閉じ（px）。線の両側へこの距離ぶん壁を広げるので、幅 2*gap 以下の隙間を閉じる
 *   bleed : 線の下へのはみ出し（px）。線の下まで塗って白い縁が出ないようにする
 *
 * 方式：
 *   1. 線（と既存の塗り）を gap だけ太らせた「壁」を作る
 *   2. 壁の外側の連結領域（部屋）のうち、出発点を含むものを塗る（4 方向でつながる範囲）
 *   3. 部屋から壁の中へ gap+1 だけ広げ、隙間の中央まで届かせる（壁の向こうの部屋へは漏れない）
 *   4. 必要なら線の下へ bleed だけはみ出させる
 * 壁の内側（壁にならない部分）と部屋の外側は、囲みや線で決まるので、隙間があっても隣へ漏れにくい。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FillCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 正方形（半径 r）の膨張。累積和を使うので画素数に比例した時間で済む
  function dilate(src, w, h, r) {
    const out = new Uint8Array(w * h);
    if (r <= 0) { out.set(src); return out; }
    const tmp = new Uint8Array(w * h);
    const pre = new Int32Array(Math.max(w, h) + 1);
    for (let y = 0; y < h; y++) {
      const b = y * w;
      pre[0] = 0;
      for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[b + x];
      for (let x = 0; x < w; x++) {
        const a = Math.max(0, x - r), c = Math.min(w - 1, x + r);
        tmp[b + x] = pre[c + 1] - pre[a] > 0 ? 1 : 0;
      }
    }
    for (let x = 0; x < w; x++) {
      pre[0] = 0;
      for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        const a = Math.max(0, y - r), c = Math.min(h - 1, y + r);
        out[y * w + x] = pre[c + 1] - pre[a] > 0 ? 1 : 0;
      }
    }
    return out;
  }

  // 4 方向のつながりでラベルを塗る。キュー q の qt 以降を使い、新しい末尾を返す
  function flood4(lab, mask, q, qt, s, label, w, h) {
    const qs = qt;
    lab[s] = label;
    q[qt++] = s;
    for (let qh = qs; qh < qt; qh++) {
      const p = q[qh], x = p % w, y = (p - x) / w;
      let j;
      if (x > 0) { j = p - 1; if (!lab[j] && mask[j]) { lab[j] = label; q[qt++] = j; } }
      if (x < w - 1) { j = p + 1; if (!lab[j] && mask[j]) { lab[j] = label; q[qt++] = j; } }
      if (y > 0) { j = p - w; if (!lab[j] && mask[j]) { lab[j] = label; q[qt++] = j; } }
      if (y < h - 1) { j = p + w; if (!lab[j] && mask[j]) { lab[j] = label; q[qt++] = j; } }
    }
    return qt;
  }

  // ラベル付き画素から 8 方向へ depth 層ぶん広げる。近い方のラベルを引き継ぐ。
  // enter : 入ってよい画素
  // corner: 斜め移動の角抜け防止（この画素が 0 の方向への斜め移動はしない）。null なら無効
  function grow(lab, q, qt, depth, enter, corner, w, h) {
    let qh = 0;
    for (let d = 0; d < depth && qh < qt; d++) {
      const end = qt;
      for (; qh < end; qh++) {
        const p = q[qh], x = p % w, y = (p - x) / w, L = lab[p];
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if ((dx | dy) === 0 || nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (lab[j] || !enter[j]) continue;
            if (corner && dx && dy && (!corner[p + dx] || !corner[p + dy * w])) continue;
            lab[j] = L;
            q[qt++] = j;
          }
        }
      }
    }
    return qt;
  }

  // 部屋（壁の外）に番号を付け、壁の中へ隙間の中央まで広げる
  function labelRegions(o) {
    const { w, h, B0, FB, seed, allow } = o;
    const gap = o.gap | 0;
    const depth = o.depth;
    const n = w * h;

    const blocked = new Uint8Array(n);
    for (let i = 0; i < n; i++) blocked[i] = B0[i] | (FB ? FB[i] : 0);
    const Z = dilate(blocked, w, h, gap);          // 壁（線・既存の塗りを gap だけ太らせたもの）
    const free = new Uint8Array(n);                // 通ってよい画素
    for (let i = 0; i < n; i++) free[i] = !blocked[i] && (!allow || allow[i]) ? 1 : 0;

    const room = blocked;                          // 壁の外（作業用に再利用）
    for (let i = 0; i < n; i++) room[i] = free[i] && !Z[i] ? 1 : 0;

    const lab = new Int32Array(n), q = new Int32Array(n);
    let nl = 0, qt = 0;
    const nb4 = (p, x, y, f) => {
      if (x > 0) f(p - 1);
      if (x < w - 1) f(p + 1);
      if (y > 0) f(p - w);
      if (y < h - 1) f(p + w);
    };

    // 1) 出発点を含む部屋を番号付け。出発点が壁の帯の中でも、すぐ隣の部屋を含める
    for (let i = 0; i < n; i++) {
      if (lab[i] || !seed[i] || !free[i]) continue;
      if (room[i]) { qt = flood4(lab, room, q, qt, i, ++nl, w, h); continue; }
      const x = i % w, y = (i - x) / w;
      nb4(i, x, y, j => { if (!lab[j] && room[j]) qt = flood4(lab, room, q, qt, j, ++nl, w, h); });
    }

    // 2) 部屋から壁の中へ広げる（隙間の中央で止まり、向こう側の部屋へは届かない）
    if (depth > 0 && qt > 0) grow(lab, q, qt, depth, free, free, w, h);

    // 3) 部屋とつながらない出発点（幅の狭い領域など）は、壁の帯の中だけでつながる範囲を塗る。
    //    部屋の近く（隙間幅以内）の帯には入らない。入ると、隙間の向こう側の壁の帯へ回り込んで染み出すため
    const nearRoom = dilate(room, w, h, gap);
    const zone = new Uint8Array(n);
    for (let i = 0; i < n; i++) zone[i] = free[i] && Z[i] && !nearRoom[i] ? 1 : 0;
    for (let i = 0; i < n; i++) {
      if (!lab[i] && seed[i] && free[i]) flood4(lab, zone, q, 0, i, ++nl, w, h);
    }
    return { lab, nl };
  }

  // 線で囲まれた領域を塗る。戻り値は塗る画素の 0/1 マスク
  function fillRegion(o) {
    const { w, h, B0, FB, allow } = o;
    const n = w * h;
    const { lab } = labelRegions({ ...o, depth: (o.gap | 0) + 1 });
    const b = o.bleed | 0;
    if (b > 0) {
      const enter = new Uint8Array(n);
      for (let i = 0; i < n; i++) enter[i] = B0[i] && !(FB && FB[i]) && (!allow || allow[i]) ? 1 : 0;
      const q = new Int32Array(n);
      let qt = 0;
      for (let i = 0; i < n; i++) if (lab[i]) q[qt++] = i;
      grow(lab, q, qt, b, enter, null, w, h);
    }
    const M = new Uint8Array(n);
    for (let i = 0; i < n; i++) M[i] = lab[i] ? 1 : 0;
    return M;
  }

  // 線で区切られた領域ごとに番号を付ける（塗り分け）。
  // 戻り値 grp は 1..G のグループ番号（0 = 塗らない）。小さすぎる領域は塗らない
  function splitRegion(o) {
    const { w, h } = o;
    const n = w * h;
    const minGroup = o.minGroup || 30;
    const { lab, nl } = labelRegions({ ...o, depth: (o.gap | 0) + 1 });

    const areas = new Float64Array(nl + 1);
    for (let i = 0; i < n; i++) if (lab[i]) areas[lab[i]]++;

    // 隣り合う領域どうしの境界の長さ
    const nbr = Array.from({ length: nl + 1 }, () => new Map());
    const link = (a, b) => {
      if (a && b && a !== b) {
        nbr[a].set(b, (nbr[a].get(b) || 0) + 1);
        nbr[b].set(a, (nbr[b].get(a) || 0) + 1);
      }
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, l = lab[i];
        if (!l) continue;
        if (x < w - 1) link(l, lab[i + 1]);
        if (y < h - 1) link(l, lab[i + w]);
      }
    }

    const par = new Int32Array(nl + 1);
    for (let l = 0; l <= nl; l++) par[l] = l;
    const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    const size = Float64Array.from(areas);
    // a を b に吸収（a, b は代表番号）
    const union = (a, b) => {
      for (const [c, cnt] of nbr[a]) {
        nbr[c].delete(a);
        if (c === b) continue;
        nbr[c].set(b, (nbr[c].get(b) || 0) + cnt);
        nbr[b].set(c, (nbr[b].get(c) || 0) + cnt);
      }
      nbr[b].delete(a);
      nbr[a] = new Map();
      size[b] += size[a];
      par[a] = b;
    };

    if (o.objMode) {
      // オブジェクト単位：境界がしっかり接している領域は1つにまとめる（1体＝1色）
      for (let a = 1; a <= nl; a++) {
        for (const [b, cnt] of [...nbr[find(a)]]) {
          if (cnt < 3) continue;
          const ra = find(a), rb = find(b);
          if (ra !== rb) union(ra, rb);
        }
      }
    } else {
      // パーツ単位：全体の pct% より小さい領域は、一番長く接している隣へまとめる
      let total = 0;
      for (let l = 1; l <= nl; l++) total += areas[l];
      const T = Math.max(minGroup, total * (o.pct || 0) / 100);
      const order = [];
      for (let l = 1; l <= nl; l++) order.push(l);
      order.sort((a, b) => areas[a] - areas[b]);
      for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (const l of order) {
          if (find(l) !== l || size[l] >= T) continue;
          let best = 0, bc = 0;
          for (const [c, cnt] of nbr[l]) if (cnt > bc) { bc = cnt; best = c; }
          if (best) { union(l, best); changed = true; }
        }
        if (!changed) break;
      }
    }

    const gid = new Int32Array(nl + 1);
    let G = 0;
    for (let l = 1; l <= nl; l++) if (find(l) === l && size[l] >= minGroup) gid[l] = ++G;
    const grp = new Int32Array(n);
    for (let i = 0; i < n; i++) if (lab[i]) grp[i] = gid[find(lab[i])];
    return { grp, G };
  }

  return { dilate, labelRegions, fillRegion, splitRegion };
});
