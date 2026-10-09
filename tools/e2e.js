'use strict';
// script.js を Node で動かすエンドツーエンド検証
const fs = require('fs');
const vm = require('vm');
const { makeDom, Canvas } = require('./domstub.js');
const { makeScene } = require('./scene.js');
const { encodePNG } = require('./png.js');
const { composite, writePNG, scale } = require('./render.js');

const W = 300, H = 300;
const lineAlpha = makeScene(W, H);

const ids = ['fill', 'line', 'ov', 'stack', 'wrap', 'fname', 'size', 'empty', 'st', 'hint', 'panel', 'togglePanel',
  'menu', 'file', 'undo', 'redo', 'zi', 'zo', 'zl', 'fit', 'showL', 'showF', 'chk', 'pan', 'bAll', 'clr', 'copyFill',
  'thr', 'conv', 'gap', 'bleed', 'protect', 'color', 'brush', 'pct'];
const radioDef = {
  action: ['fill', 'erase', 'split'], shape: ['brush', 'lasso'],
  trace: ['trace', 'raw'], range: ['clip', 'whole'], smode: ['parts', 'obj'],
};
const { els, document, state } = makeDom(ids, radioDef, { action: 'fill', shape: 'brush', trace: 'trace', range: 'clip', smode: 'parts' });

// 線画イメージ（Image スタブ）
class Img {
  constructor() { this.naturalWidth = W; this.naturalHeight = H; this._pixels = new Uint8ClampedArray(W * H * 4); this.width = W; this.height = H; }
  set src(v) { setTimeout(() => this.onload && this.onload(), 0); }
}
const img = new Img();
for (let i = 0; i < W * H; i++) { img._pixels[i * 4 + 3] = lineAlpha[i]; }  // 黒線・透明度=線の濃さ

const listeners = {};
const sandbox = {
  console, setTimeout, clearTimeout, Math, JSON, Blob: class { }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() { } },
  navigator: { userAgent: 'node', platform: 'Linux', maxTouchPoints: 0 },
  localStorage: { getItem: () => null, setItem() { } },
  performance: { now: () => Date.now() },
  requestAnimationFrame: f => setTimeout(f, 0),
  addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
  Image: function () { return img; },
  document,
  ClipboardItem: undefined,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('fillcore.js', 'utf8'), sandbox);
sandbox.window.FillCore = sandbox.FillCore;
{
  const FC = sandbox.FillCore;
  const origFR = FC.fillRegion;
  FC.fillRegion = function (o) {
    if (global.LOGLR) {
      let sc = 0, ac = 0;
      for (let i = 0; i < o.seed.length; i++) if (o.seed[i]) sc++;
      if (o.allow) for (let i = 0; i < o.allow.length; i++) if (o.allow[i]) ac++;
      console.log('fillRegion: seed =', sc, 'allow =', ac, 'keep =', o.keep, 'gap =', o.gap, 'bleed =', o.bleed, 'clipPad =', o.clipPad, 'ink =', !!o.ink, 'w =', o.w, 'h =', o.h);
    }
    const M = origFR(o);
    global.LASTM = M; global.LASTO = { w: o.w, h: o.h };
    if (global.LOGLR) {
      let c = 0;
      for (let i = 0; i < M.length; i++) c += M[i];
      console.log('  -> M px =', c);
    }
    return M;
  };
}
vm.runInContext(fs.readFileSync('script.js', 'utf8'), sandbox);

// 画像を開く（file change を模倣）
els.file._ls.change({ target: { files: [{ name: 'test.png', type: 'image/png' }], value: '' } });

function ptr(type, x, y) {
  els.ov.dispatch(type, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, preventDefault() { }, type });
}
function stroke(pts, up = true) {
  ptr('pointerdown', pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ptr('pointermove', pts[i][0], pts[i][1]);
  if (up) ptr('pointerup', pts[pts.length - 1][0], pts[pts.length - 1][1]);
}
function setRadio(name, value) {
  state[name] = value;
  for (const e of document.querySelectorAll(`input[name="${name}"]`)) e.dispatch('change', { target: e });
}
function fillRGBA() { return els.fill._buf; }
function countFilled() { let c = 0; const B = fillRGBA(); for (let i = 3; i < B.length; i += 4) if (B[i]) c++; return c; }
function dump(name, z) {
  const c = composite(W, H, lineAlpha, fillRGBA());
  const s = scale(W, H, c, z || 2);
  writePNG(`tools/out/${name}.png`, s.w, s.h, s.rgba);
}

setTimeout(() => {
  console.log('loaded. status =', els.st.textContent);
  // 1) 目をちょん（新しい塗り）
  els.brush.value = '10';
  stroke([[120, 165]]);
  setTimeout(() => {
    console.log('1 eye tap:', els.st.textContent, 'px =', countFilled());
    dump('e2e_eye');
    els.undo._ls.click();
    setTimeout(() => {
      // 2) ブラシで顔を覆う
      els.brush.value = '60';
      stroke([[100, 150], [150, 190], [200, 150], [150, 120]]);
      setTimeout(() => {
        console.log('2 brush face:', els.st.textContent, 'px =', countFilled());
        dump('e2e_brush_face');
        // 3) 線を越えたなぞり（背景は塗れない）
        els.brush.value = '30';
        stroke([[40, 140], [80, 140]]);
        setTimeout(() => {
          console.log('3 cross-line swipe:', els.st.textContent, 'px =', countFilled());
          // 4) 消す（エッジに沿って）
          setRadio('action', 'erase');
          els.brush.value = '40';
          stroke([[60, 120], [240, 120]]);
          setTimeout(() => {
            console.log('4 erase:', els.st.textContent, 'px =', countFilled());
            dump('e2e_erase');
            {
              const B = els.fill._buf;
              for (let y = 112; y <= 122; y++) {
                let s3 = '';
                for (let x = 100; x <= 140; x++) s3 += B[(y * 300 + x) * 4 + 3] ? 'F' : '.';
                console.log('fill', y, s3);
              }
              const M = global.LASTM, { w, h } = global.LASTO;
              for (let y = 20; y <= 53; y++) {
                let s2 = '';
                for (let x = 74; x <= 114; x++) s2 += M[y * w + x] ? 'X' : '.';
                console.log(y + 86, s2);
              }
            }
            // 5) 投げ縄（頭全体）
            setRadio('action', 'fill'); setRadio('shape', 'lasso');
            stroke([[40, 30], [260, 30], [265, 260], [35, 260], [40, 30]]);
            setTimeout(() => {
              console.log('5 lasso:', els.st.textContent, 'px =', countFilled());
              dump('e2e_lasso');
              // 6) undo / redo
              els.undo._ls.click();
              setTimeout(() => {
                console.log('6 after undo px =', countFilled());
                els.redo._ls.click();
                setTimeout(() => {
                  console.log('7 after redo px =', countFilled());
                  // 8) 塗り分け（ブラシ）
                  setRadio('action', 'split'); setRadio('shape', 'brush');
                  els.brush.value = '80';
                  stroke([[150, 90], [150, 200]]);
                  setTimeout(() => {
                    console.log('8 split:', els.st.textContent, 'px =', countFilled());
                    dump('e2e_split');
                    {
                      const B = els.fill._buf;
                      let row = '';
                      for (let x = 40; x <= 260; x += 10) {
                        const o = (150 * 300 + x) * 4;
                        row += `${x}:${B[o]},${B[o + 1]},${B[o + 2]} `;
                      }
                      console.log('row150', row);
                    }
                    // 9) 線を無視（raw）
                    setRadio('action', 'fill'); setRadio('trace', 'raw');
                    els.brush.value = '20';
                    stroke([[20, 20], [60, 20]]);
                    setTimeout(() => {
                      console.log('9 raw:', els.st.textContent, 'px =', countFilled());
                      dump('e2e_raw');
                      console.log('ALL DONE');
                    }, 150);
                  }, 150);
                }, 60);
              }, 60);
            }, 150);
          }, 150);
        }, 150);
      }, 150);
    }, 60);
  }, 150);
}, 50);
