const S = require('./sim.js');
// ケース1: 頬（顔の内部）をブラシでなぞる
let f = S.newFill();
let M = S.currentBrush([[120, 180], [150, 185], [180, 180]], 30, f);
S.dump('cur_brush_cheek', f);
console.log('case1 painted px =', M.reduce((a, v) => a + v, 0));
// 顔の外（背景）まで塗られたか
console.log('  外側(10,10) =', M[10 * S.W + 10], ' (250,250) =', M[250 * S.W + 250]);

// ケース2: 目をブラシでちょんとなぞる（小さな領域）
f = S.newFill();
M = S.currentBrush([[124, 150]], 8, f);
S.dump('cur_brush_eye', f);
console.log('case2 painted px =', M.reduce((a, v) => a + v, 0), ' 目だけ?', M[150 * S.W + 124], M[150 * S.W + 178]);

// ケース3: 投げ縄で顔を囲む
f = S.newFill();
M = S.currentLasso([[150, 40], [250, 120], [230, 250], [70, 250], [50, 120]], f, false);
S.dump('cur_lasso_face', f);
console.log('case3 painted px =', M.reduce((a, v) => a + v, 0));
console.log('  髪の外(20,20)=', M[20 * S.W + 20], ' 顔の中(150,220)=', M[220 * S.W + 150]);
