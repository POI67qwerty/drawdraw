/*
 * 計算ワーカー（裏側で重い計算をするための別スレッド）
 *
 * なぜこれがあるの？
 *   塗り／消しの計算は画像ぜんぶの画素を見るので、大きな画像では数百ms〜秒単位になります。
 *   メインスレッド（画面を描いたりタッチに反応する側）でやると画面が固まった感じになるため、
 *   ブラウザの Worker という仕組みで「別のスレッド」に計算を任せます。
 *
 * 受け取るもの（postMessage）：fillcore.js の fillRegion / splitRegion に渡すオプション一式
 *   （w,h,B0,FB,seed,allow,gap,bleed,ink,keep,clipPad,erase,bandSeed,…＋ id）
 * 返すもの：塗る画素のマスク M、または塗り分けの grp と G
 */
'use strict';
importScripts('fillcore.js');

self.onmessage = function (e) {
  const o = e.data;
  try {
    if (o.act === 'split') {
      const { grp, G } = FillCore.splitRegion(o);
      self.postMessage({ id: o.id, grp, G }, [grp.buffer]);
    } else {
      const M = FillCore.fillRegion(o);
      self.postMessage({ id: o.id, M }, [M.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: o.id, err: String((err && err.message) || err) });
  }
};
