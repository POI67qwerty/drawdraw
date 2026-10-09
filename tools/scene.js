'use strict';
// テスト用の「それっぽい線画」。閉じた領域＋AA線＋1箇所の5px隙間
const { drawPolyAA, drawLineAA, arcPts, circlePts } = require('./png.js');

function makeScene(w = 300, h = 300) {
  const a = new Uint8Array(w * h);
  const P = (pts, lw, al) => drawPolyAA(a, w, h, pts, lw, al === undefined ? 255 : al, false);

  // 輪郭: 円 R=100 c=(150,140)。左下に 5px の隙間（角度 0.72π〜0.737π を抜く）
  const g0 = Math.PI * 0.72, g1 = Math.PI * 0.737;
  P(arcPts(150, 140, 100, g1, g0 + Math.PI * 2, 240), 5);   // 隙間→右回り一周→隙間の手前
  P(arcPts(150, 140, 100, g0 - Math.PI * 0.30, g0, 40), 5); // 隙間のもう片側ちょっと（連続させる）
  // 前髪の境（輪郭上の2点を結ぶので閉領域になる）
  P([[52, 120], [90, 105], [150, 100], [210, 105], [248, 120]], 4);
  // 目（閉じたひし形）
  P([[104, 165], [120, 154], [136, 165], [120, 176], [104, 165]], 3);
  P([[164, 165], [180, 154], [196, 165], [180, 176], [164, 165]], 3);
  // 口（閉じた細い形）
  P([[136, 202], [150, 198], [164, 202], [150, 208], [136, 202]], 3);
  // 髪の房（細い線、閉じない）
  drawLineAA(a, w, h, 120, 104, 112, 60, 2);
  drawLineAA(a, w, h, 180, 104, 190, 62, 2);
  return a;
}
module.exports = { makeScene };
