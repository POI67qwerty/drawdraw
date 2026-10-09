/*
 * 囲って塗るツールの計算コア（DOM / Canvas に依存しない純粋な処理）
 *
 * Clip Studio「隙間無く囲って塗る／消す」相当の挙動を目指す。
 *
 * すべての配列は幅 w・高さ h の画像を行優先で並べたもの（長さ w*h）。
 *   B0    : 線（1 = 線あり、しきい値済み）
 *   ink   : 線のアンチエイリアスを含む濃さ 0..255（省略可）。隙間なく塗るために使う
 *   FB    : 既存の塗り（1 = 塗り済み）。省略可（既存の塗りを守るときだけ渡す）
 *   seed  : 出発点（投げ縄の内側・ブラシで触れた所）
 *   allow : 囲み（1 = 囲みの中）。null なら画像全体。囲みは「外へ漏れない壁」として働く
 *   gap   : 隙間閉じ（px）。この幅以下の線の切れ目を閉じる
 *   bleed : 線の下へ塗りを差し込む深さ（px）。線の縁に白い隙間が出ないようにする
 *
 * 方式（クリスタの「隙間無く囲って塗る」に合わせたもの）
 *   1. 壁 = 線（＋既存の塗り）を gap だけ太らせたもの。線の切れ目（≤2*gap）は閉じる
 *   2. 囲みの中だけで部屋（壁の外側のつながり）を作る。囲みは壁になるので外へ漏れない
 *   3. 部屋のうち「囲みからはみ出さず、出発点に触れたもの」だけを塗る。
 *      → なぞりが領域を覆いきれていない／囲みが背景に触れている、という事故を防ぐ
 *   4. 壁で潰れるほど細い領域は、部屋の代わりに「壁の帯だけの孤立したつながり」を拾う
 *      → 目や口などの細いパーツも塗れる
 *   5. 最後に線の濃さ（ink）を辿って線の下へ bleed だけ塗りを差し込む。
 *      線の縁の半透明画素の下にも色が入るので、白い隙間も色のにじみも出ない（隙間なく塗る）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FillCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 正方形（半径 r、チェビシェフ距離）の膨張。累積和を使うので画素数に比例した時間で済む
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

  // ラベル付き画素から 8 方向へ depth 層ぶん広げる。近い方のラベルを引き継ぐ（境界は中間で会う）。
  // enter : 入ってよい画素
  // corner: 斜め移動の角抜け防止（この画素が 0 の方向への斜め移動はしない）。null なら無効
  function grow(lab, q, qt, depth, enter, corner, w, h, stop) {
    let qh = 0;
    for (let d = 0; d < depth && qh < qt; d++) {
      const end = qt;
      for (; qh < end; qh++) {
        const p = q[qh], x = p % w, y = (p - x) / w, L = lab[p];
        if (stop && (typeof stop === 'function' ? stop(p, L) : stop[p])) continue;  // 通り止め
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

  /*
   * 部屋のラベル付け。戻り値 { lab, nl }
   *   lab : 画素ごとのラベル（0 = 塗らない、1..nl = 領域）
   *
   * 採用ルール（クリスタの「隙間無く囲って塗る」に合わせる）
   *   - 壁 = 線（＋既存の塗り）を gap だけ太らせたもの。幅 2*gap 以下の線の切れ目は閉じる
   *   - 部屋 = 壁の帯の外側のつながり。出発点に触れた部屋だけを塗る
   *   - 囲み（allow）があるとき：囲みが部屋の半分未満しか覆えていない部屋は塗らない
   *     → なぞり／囲みが線を越えて背景に触れたとき、背景まで塗れる事故を防ぐ
   *   - 壁で潰れて部屋が無いほど細い領域は、「部屋のそばではない帯」を繋がりで拾う
   *     → 目・口・髪の毛の細い房なども塗れる（外の帯は部屋のそばなので拾われない）
   *   - 塗りは帯へ depth だけ広がる。そのとき「別の部屋のそば」へは、
   *     先に壁がある場合（＝線の下）だけ進み、隙間の通り道は抜けない
   */
  function labelRegions(o) {
    const { w, h, B0, FB, seed, allow } = o;
    const gap = o.gap | 0;
    const n = w * h;
    const keep = o.keep == null ? 0.5 : o.keep;   // 囲みが部屋をこれだけ覆えていれば塗る

    // 壁（線・既存の塗りを gap だけ太らせる → 幅 2*gap 以下の切れ目を閉じる）
    const blocked = new Uint8Array(n);
    for (let i = 0; i < n; i++) blocked[i] = B0[i] | (FB ? FB[i] : 0);
    const Z = gap > 0 ? dilate(blocked, w, h, gap) : blocked;

    const free = new Uint8Array(n);               // 壁の外
    for (let i = 0; i < n; i++) free[i] = blocked[i] ? 0 : 1;
    const roomM = new Uint8Array(n);              // 部屋（壁の帯の外側）
    for (let i = 0; i < n; i++) roomM[i] = free[i] && !Z[i] ? 1 : 0;
    const bandM = new Uint8Array(n);              // 壁の帯
    for (let i = 0; i < n; i++) bandM[i] = free[i] && Z[i] ? 1 : 0;
    // 部屋のそば（隙間の通り道になり得る所）
    const nearRoom = gap > 0 ? dilate(roomM, w, h, gap) : roomM;

    const lab = new Int32Array(n), q = new Int32Array(n);
    let nl = 0, qt = 0;

    // 1) 部屋を番号付け
    for (let i = 0; i < n; i++) {
      if (!roomM[i] || lab[i]) continue;
      qt = flood4(lab, roomM, q, qt, i, ++nl, w, h);
    }
    const size = new Float64Array(nl + 1), inA = new Float64Array(nl + 1), sd = new Uint8Array(nl + 1);
    for (let i = 0; i < n; i++) {
      const L = lab[i];
      if (!L) continue;
      size[L]++;
      if (!allow || allow[i]) inA[L]++;
    }
    // 出発点：部屋の上か、部屋の隣の帯の上なら、その部屋を出発済みとする
    for (let i = 0; i < n; i++) {
      if (!seed[i]) continue;
      const L = lab[i];
      if (L) { sd[L] = 1; continue; }
      if (!free[i]) continue;
      const x = i % w, y = (i - x) / w;
      if (x > 0 && lab[i - 1]) sd[lab[i - 1]] = 1;
      if (x < w - 1 && lab[i + 1]) sd[lab[i + 1]] = 1;
      if (y > 0 && lab[i - w]) sd[lab[i - w]] = 1;
      if (y < h - 1 && lab[i + w]) sd[lab[i + w]] = 1;
    }

    // 2) 細い領域の救済：部屋のそばではない帯を繋がりで番号付け
    const zone = new Uint8Array(n);
    for (let i = 0; i < n; i++) zone[i] = bandM[i] && !nearRoom[i] ? 1 : 0;
    const zlab = new Int32Array(n);
    let zn = 0;
    const zsize = [0], zinA = [0], zsd = [0];
    for (let i = 0; i < n; i++) {
      if (!zone[i] || zlab[i]) continue;
      const L = ++zn;
      zsize.push(0); zinA.push(0); zsd.push(0);
      let cnt = 0, ina = 0, sdd = 0;
      zlab[i] = L;
      q[0] = i;
      for (let qh = 0, qt2 = 1; qh < qt2; qh++) {
        const p = q[qh], x = p % w, y = (p - x) / w;
        cnt++;
        if (!allow || allow[p]) ina++;
        if (seed[p]) sdd = 1;
        let j;
        if (x > 0) { j = p - 1; if (zone[j] && !zlab[j]) { zlab[j] = L; q[qt2++] = j; } }
        if (x < w - 1) { j = p + 1; if (zone[j] && !zlab[j]) { zlab[j] = L; q[qt2++] = j; } }
        if (y > 0) { j = p - w; if (zone[j] && !zlab[j]) { zlab[j] = L; q[qt2++] = j; } }
        if (y < h - 1) { j = p + w; if (zone[j] && !zlab[j]) { zlab[j] = L; q[qt2++] = j; } }
      }
      zsize[L] = cnt; zinA[L] = ina; zsd[L] = sdd;
    }

    // 部屋の影響ラベル（gap で打ち止め）。別の部屋のそばでは広がらない
    const infl = new Int32Array(n);
    if (gap > 0) {
      let iqt = 0;
      for (let i = 0; i < n; i++) if (roomM[i]) { infl[i] = lab[i]; q[iqt++] = i; }
      for (let dd = 0, qh = 0; dd < gap && qh < iqt; dd++) {
        const end5 = iqt;
        for (; qh < end5; qh++) {
          const p = q[qh], x = p % w, y = (p - x) / w;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if ((dx | dy) === 0 || nx < 0 || nx >= w) continue;
              const j = ny * w + nx;
              if (free[j] && !infl[j]) { infl[j] = infl[p]; q[iqt++] = j; }
            }
          }
        }
      }
    }

    // 出発点補強：出発点が帯（壁ぎわ）の上にあるとき、その帯が属する部屋も出発済みとする。
    // 消すときは無効（中心線が線ぎわに触れるたび反対側の領域まで消えてしまうため）
    if (gap > 0 && o.bandSeed !== false) {
      for (let i = 0; i < n; i++) {
        if (!seed[i] || lab[i] || !free[i]) continue;
        const x = i % w, y = (i - x) / w;
        if (x > 0) { const v = lab[i - 1] || infl[i - 1]; if (v) sd[v] = 1; }
        if (x < w - 1) { const v = lab[i + 1] || infl[i + 1]; if (v) sd[v] = 1; }
        if (y > 0) { const v = lab[i - w] || infl[i - w]; if (v) sd[v] = 1; }
        if (y < h - 1) { const v = lab[i + w] || infl[i + w]; if (v) sd[v] = 1; }
      }
    }

    // 3) 採用判定
    const R = nl + zn;
    const ok = new Uint8Array(R + 1);
    for (let l = 1; l <= nl; l++) {
      if (sd[l] && (!allow || inA[l] >= size[l] * keep)) ok[l] = 1;
    }
    // 細い領域は壁に完全に囲われているので、囲みの覆い率は見ない（出発点だけで採用）
    for (let l = 1; l <= zn; l++) {
      if (zsd[l]) ok[nl + l] = 1;
    }

    // 4) 採用した部屋＋細い領域から、壁の帯へ depth だけ広げる。
    //    「別の部屋のそば」へは、その先に壁がある（＝線の下へ進む）ときだけ入る
    const outLab = new Int32Array(n);
    const oq = new Int32Array(n);
    let oqt = 0;
    for (let i = 0; i < n; i++) {
      const L = lab[i];
      if (L && ok[L]) { outLab[i] = L; oq[oqt++] = i; continue; }
      const ZL = zlab[i];
      if (ZL && ok[nl + ZL]) { outLab[i] = nl + ZL; oq[oqt++] = i; }
    }
    // 壁までの距離（gap で打ち止め）
    const dB = new Int32Array(n);
    {
      let bqt = 0;
      for (let i = 0; i < n; i++) if (blocked[i]) { dB[i] = 1; q[bqt++] = i; }
      for (let s = 2, qh = 0; s <= gap + 1 && qh < bqt; s++) {
        const end4 = bqt;
        for (; qh < end4; qh++) {
          const p = q[qh], x = p % w, y = (p - x) / w;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if ((dx | dy) === 0 || nx < 0 || nx >= w) continue;
              const j = ny * w + nx;
              if (!dB[j]) { dB[j] = s; q[bqt++] = j; }
            }
          }
        }
      }
    }
    // 栓（両側が壁にはさまれた所）＝線の切れ目を閉じた所。ここは通り抜けられる
    const squeeze = new Uint8Array(n);
    if (gap > 0) {
      const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!free[i] || !nearRoom[i]) continue;
          let hit = 0;
          for (const [dx, dy] of DIRS) {
            let a = 0, b = 0;
            for (let t = 1; t <= gap; t++) {
              const nx = x + dx * t, ny = y + dy * t;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) { a = 1; break; }
              if (blocked[ny * w + nx]) { a = 1; break; }
            }
            for (let t = 1; t <= gap; t++) {
              const nx = x - dx * t, ny = y - dy * t;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) { b = 1; break; }
              if (blocked[ny * w + nx]) { b = 1; break; }
            }
            if (a && b) { hit = 1; break; }
          }
          squeeze[i] = hit;
        }
      }
    }

    const depth = o.depth | 0;
    for (let d = 0, qh = 0; d < depth && qh < oqt; d++) {
      const end3 = oqt;
      for (; qh < end3; qh++) {
        const p = oq[qh], x = p % w, y = (p - x) / w, S = outLab[p];
        // 別の部屋のそば（隙間の通り道）からは広がらない。栓（閉じた切れ目）は抜ける
        const stopHere = nearRoom[p] && infl[p] !== S && !squeeze[p];
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if ((dx | dy) === 0 || nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (outLab[j] || !free[j]) continue;
            if (dx && dy && (!free[p + dx] || !free[p + dy * w])) continue;  // 角抜け防止
            if (stopHere) continue;
            // 部屋のそばへは、壁の下へ進むときだけ入る（隙間を抜けて外へ出ない）
            if (nearRoom[j] && !(dB[j] && dB[j] <= gap + 1)) continue;
            outLab[j] = S;
            oq[oqt++] = j;
          }
        }
      }
    }

    // 5) 囲みで切り戻す（clipPad ≥ 0 のとき。消す＝エッジに沿って消す用）。
    //    clipPad < 0 なら切らない：囲みは「どの領域を塗るか」の判定にだけ使う
    if (allow && (o.clipPad | 0) >= 0) {
      const clip = o.clipPad > 0 ? dilate(allow, w, h, o.clipPad) : allow;
      for (let i = 0; i < n; i++) if (outLab[i] && !clip[i]) outLab[i] = 0;
    }
    // ラベル番号を詰め直す
    const remap = new Int32Array(R + 1);
    let nn = 0;
    for (let i = 0; i < n; i++) if (outLab[i] && !remap[outLab[i]]) remap[outLab[i]] = ++nn;
    for (let i = 0; i < n; i++) outLab[i] = remap[outLab[i]];
    return { lab: outLab, nl: nn };
  }

  // 線で囲まれた領域を塗る。戻り値は塗る画素の 0/1 マスク
  // ink があれば、線のアンチエイリアスの下まで塗りを差し込む（隙間なく塗る）
  function fillRegion(o) {
    const { w, h, B0, allow, ink } = o;
    const n = w * h;
    const b = o.bleed | 0;
    const { lab } = labelRegions({ ...o, depth: (o.gap | 0) + 1 });

    if (ink && b > 0) {
      // 線の濃さがある画素へ、近い方の領域のラベルで差し込む。
      // 塗＝縁の下まで隙間なく（b+2）、消＝線の縁の下を掃除する「領域スケーリング」（b）
      const enter = new Uint8Array(n);
      const thr = o.inkThr == null ? 8 : o.inkThr | 0;
      for (let i = 0; i < n; i++) enter[i] = ink[i] >= thr && (!allow || allow[i] || B0[i]) ? 1 : 0;
      const q = new Int32Array(n);
      let qt = 0;
      for (let i = 0; i < n; i++) if (lab[i]) q[qt++] = i;
      grow(lab, q, qt, o.erase ? Math.max(1, b) : Math.max(1, b + 2), enter, null, w, h);
    } else if (b > 0) {
      const enter = new Uint8Array(n);
      for (let i = 0; i < n; i++) enter[i] = B0[i] && !(o.FB && o.FB[i]) && (!allow || allow[i]) ? 1 : 0;
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
