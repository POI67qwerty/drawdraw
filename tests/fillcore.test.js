'use strict';
// 実行: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const FC = require('../fillcore.js');

// '#' = 線、'o' = 既存の塗り（FB）、それ以外 = 何もない所
function parse(rows) {
  const h = rows.length, w = rows[0].length;
  const B0 = new Uint8Array(w * h), FB = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = rows[y][x];
    if (c === '#') B0[y * w + x] = 1;
    if (c === 'o') FB[y * w + x] = 1;
  }
  return { w, h, B0, FB };
}
const pointMask = (w, h, pts) => {
  const s = new Uint8Array(w * h);
  for (const [x, y] of pts) s[y * w + x] = 1;
  return s;
};
const rectMask = (w, h, x0, y0, x1, y1) => {
  const m = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = 1;
  return m;
};
const count = m => m.reduce((a, v) => a + v, 0);
const at = (m, w, x, y) => m[y * w + x];
const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

// 幅 1 の円。上側中央に gapPx 幅の切れ目を入れられる
function circleArt(size, R, gapPx) {
  const c = (size - 1) / 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    let r = '';
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const onLine = Math.abs(d - R) < 0.6;
      const inGap = gapPx > 0 && y < c - R + 2 && Math.abs(x - c) < gapPx / 2;
      r += onLine && !inGap ? '#' : '.';
    }
    rows.push(r);
  }
  return rows;
}

test('閉じた箱は内側だけ塗られる（bleed=0）', () => {
  const p = parse([
    '##########',
    '#........#',
    '#........#',
    '#........#',
    '##########',
  ]);
  const M = FC.fillRegion({ ...p, seed: pointMask(p.w, p.h, [[5, 2]]), allow: null, gap: 2, bleed: 0 });
  assert.equal(count(M), 8 * 3);
  assert.equal(diff(M, rectMask(p.w, p.h, 1, 1, 8, 3)), 0);
});

test('bleed=1 で線の下まで塗る（白い縁が出ない）', () => {
  const p = parse([
    '##########',
    '#........#',
    '#........#',
    '#........#',
    '##########',
  ]);
  const M = FC.fillRegion({ ...p, seed: pointMask(p.w, p.h, [[5, 2]]), allow: null, gap: 2, bleed: 1 });
  assert.equal(count(M), 10 * 5);
});

test('幅 2*gap 以下の隙間は閉じる（漏れは隙間の直下 1px 以内に収まる）', () => {
  const p = parse([
    '..........................',
    '..........................',
    '..........................',
    '....###################...',
    '....#.................#...',
    '....#.................#...',
    '....#.................#...',
    '....#####...###########...',  // 下辺の隙間 3px（x=9..11）。gap=2 なら閉じる（2*2=4 ≥ 3）
    '..........................',
    '..........................',
    '..........................',
  ]);
  const M = FC.fillRegion({ ...p, seed: pointMask(p.w, p.h, [[12, 5]]), allow: null, gap: 2, bleed: 0 });
  // 箱の外へは「隙間の直下 1px」を除いて漏れない
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const inside = x >= 5 && x <= 21 && y >= 4 && y <= 8;
    if (!inside) assert.equal(at(M, p.w, x, y), 0, `外側 (${x},${y}) が塗られた`);
  }
  // 内側は全部（隙間の中央付近まで）塗られている
  for (let y = 4; y <= 6; y++) for (let x = 6; x <= 20; x++) assert.equal(at(M, p.w, x, y), 1, `内側 (${x},${y})`);
  assert.equal(at(M, p.w, 10, 7), 1, '隙間の中');
});

test('幅 2*gap より広い隙間は閉じない（囲みで止める。囲みの外は塗らない）', () => {
  const p = parse([
    '..........................',
    '..........................',
    '....#################.....',
    '....#.................#...',
    '....#.................#...',
    '....##...............##...',  // 下辺の隙間 15px。gap=2 では閉じない
    '..........................',
    '..........................',
    '..........................',
  ]);
  const free = FC.fillRegion({ ...p, seed: pointMask(p.w, p.h, [[12, 4]]), allow: null, gap: 2, bleed: 0 });
  assert.equal(at(free, p.w, 12, 7), 1, '囲みなし（領域全体）だと外まで塗られる');
  const allow = rectMask(p.w, p.h, 5, 3, 21, 5);
  const clipped = FC.fillRegion({ ...p, seed: pointMask(p.w, p.h, [[12, 4]]), allow, gap: 2, bleed: 0 });
  // 囲みが領域を覆いきれていない（隙間で外とつながる）ので、外へは塗らない
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    if (!allow[y * p.w + x]) assert.equal(at(clipped, p.w, x, y), 0, `囲みの外 (${x},${y})`);
  }
});

test('囲み（ブラシ／投げ縄）が閉領域を覆っていれば、領域全体を隙間なく塗る', () => {
  const p = parse([
    '..........................',
    '..........................',
    '..........................',
    '..........................',
    '....###################...',
    '....#.................#...',
    '....#.................#...',
    '....#.................#...',
    '....###################...',
    '..........................',
    '..........................',
    '..........................',
  ]);
  // 囲み＝領域より 1px だけ大きいブラシ跡（背景の部屋も少し含む）
  const allow = rectMask(p.w, p.h, 3, 3, 23, 9);
  const seed = rectMask(p.w, p.h, 8, 5, 16, 7);
  const M = FC.fillRegion({ ...p, seed, allow, gap: 2, bleed: 0 });
  assert.equal(diff(M, rectMask(p.w, p.h, 5, 5, 21, 7)), 0, '領域ぴったり塗る（線の上と背景は塗らない）');
  // 囲みが背景の半分未満しか覆えていないときは塗らない（背景まで塗れる事故の防止）
  const seed2 = rectMask(p.w, p.h, 0, 10, 2, 11);
  const M2 = FC.fillRegion({ ...p, seed: seed2, allow: rectMask(p.w, p.h, 0, 10, 2, 11), gap: 2, bleed: 0 });
  assert.equal(count(M2), 0, '背景の細切れは塗らない');
});

test('斜めの線で区切られた両側は漏れない（4 方向のつながりで判定）', () => {
  const N = 6;
  const rows = [];
  for (let y = 0; y < N; y++) {
    let r = '';
    for (let x = 0; x < N; x++) r += x === y ? '#' : '.';
    rows.push(r);
  }
  const p = parse(rows);
  const M = FC.fillRegion({ ...p, seed: pointMask(p.w, p.h, [[5, 0]]), allow: null, gap: 0, bleed: 0 });
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (x > y) assert.equal(at(M, p.w, x, y), 1, `(${x},${y}) は塗る`);
    if (x < y) assert.equal(at(M, p.w, x, y), 0, `(${x},${y}) は塗らない`);
  }
});

test('細い領域（幅 5 px、gap=3 で全部が壁の中）も塗れる', () => {
  const p = parse([
    '#######',
    '#.....#',
    '#######',
  ]);
  const M = FC.fillRegion({ ...p, seed: pointMask(p.w, p.h, [[3, 1]]), allow: null, gap: 3, bleed: 0 });
  for (let x = 1; x <= 5; x++) assert.equal(at(M, p.w, x, 1), 1, `x=${x}`);
});

test('既存の塗り（FB）は上書きせず、その手前で止まる', () => {
  const p = parse([
    '###############',
    '#.............#',
    '#...ooooo.....#',
    '#...ooooo.....#',
    '#.............#',
    '###############',
  ]);
  const M = FC.fillRegion({ ...p, seed: pointMask(p.w, p.h, [[12, 2]]), allow: null, gap: 1, bleed: 0 });
  for (let i = 0; i < p.FB.length; i++) if (p.FB[i]) assert.equal(M[i], 0, '既存の塗りは塗らない');
  assert.equal(at(M, p.w, 12, 2), 1);
  assert.equal(at(M, p.w, 12, 4), 1);
  assert.equal(at(M, p.w, 2, 2), 0, '既存の塗りで区切られた左の小さな部屋は塗らない');
});

test('円（隙間なし）：内側は全部塗り、外側は塗らない', () => {
  const p = parse(circleArt(61, 24, 0));
  const c = 30;
  const M = FC.fillRegion({ ...p, seed: pointMask(p.w, p.h, [[c, c]]), allow: null, gap: 6, bleed: 1 });
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const d = Math.hypot(x - c, y - c);
    const m = M[y * p.w + x];
    if (d < 22.5) assert.equal(m, 1, `内側 (${x},${y}) が塗られていない`);
    if (d > 25.5) assert.equal(m, 0, `外側 (${x},${y}) が塗られた`);
  }
});

test('円（上に 4px の切れ目）：切れ目の内側まで塗り、円の外へ漏れない', () => {
  const p = parse(circleArt(61, 24, 4));
  const c = 30;
  const M = FC.fillRegion({ ...p, seed: pointMask(p.w, p.h, [[c, c]]), allow: null, gap: 3, bleed: 1 });
  for (let y = c - 24 + 2; y < c - 24 + 6; y++) assert.equal(at(M, p.w, c, y), 1, `切れ目の内側 y=${y}`);
  for (let y = 0; y < c - 24 - 2; y++) for (let x = 0; x < p.w; x++) assert.equal(at(M, p.w, x, y), 0, `外 (${x},${y})`);
});

test('塗り分け：線で仕切られた 2 部屋は 2 グループ', () => {
  const rows = ['#'.repeat(50)];
  for (let y = 0; y < 12; y++) rows.push('#' + '.'.repeat(23) + '#' + '.'.repeat(23) + '#');
  rows.push('#'.repeat(50));
  const p = parse(rows);
  const S = pointMask(p.w, p.h, [[10, 5], [35, 5]]);
  const { grp, G } = FC.splitRegion({ ...p, seed: S, allow: null, gap: 2, objMode: false, pct: 3 });
  assert.equal(G, 2);
  assert.equal(grp[5 * p.w + 10] !== grp[5 * p.w + 35], true, '別のグループ');
  assert.equal(grp[5 * p.w + 0], 0, '線の上は塗らない');
});

test('塗り分け：隙間で通じている 2 部屋は、オブジェクト単位で 1 つにまとまる', () => {
  // 下の壁に 2px の切れ目（gap=2 で閉じる）。境界が接するので 1 グループ
  const rows = ['#'.repeat(30)];
  for (let y = 0; y < 8; y++) rows.push('#' + '.'.repeat(13) + '#' + '.'.repeat(14) + '#');
  rows.push('#'.repeat(14) + '..' + '#'.repeat(14));
  for (let y = 0; y < 8; y++) rows.push('#' + '.'.repeat(28) + '#');
  rows.push('#'.repeat(30));
  const p = parse(rows);
  const S = pointMask(p.w, p.h, [[5, 4], [20, 4]]);
  const parts = FC.splitRegion({ ...p, seed: S, allow: null, gap: 2, objMode: false, pct: 0, minGroup: 1 });
  const objs = FC.splitRegion({ ...p, seed: S, allow: null, gap: 2, objMode: true, pct: 0, minGroup: 1 });
  assert.ok(objs.G <= parts.G);
});
