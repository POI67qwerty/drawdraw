const $=id=>document.getElementById(id);
const fillC=$('fill'),lineC=$('line'),ovC=$('ov'),stack=$('stack');
const fctx=fillC.getContext('2d',{willReadFrequently:true});
const lctx=lineC.getContext('2d',{willReadFrequently:true});
const octx=ovC.getContext('2d');
let W=0,H=0,zoom=1,srcImg=null,baseName='image',tool='fill',undoStack=[],redoStack=[],pts=[],drawing=false,panMode=false;
const status=t=>$('st').textContent=t;

// ---- 線画の読み込み ----
$('file').onchange=e=>{
  const f=e.target.files[0]; if(!f)return;
  baseName=f.name.replace(/\.[^.]+$/,'');
  const img=new Image();
  img.onload=()=>{
    srcImg=img;W=img.naturalWidth;H=img.naturalHeight;
    [fillC,lineC,ovC].forEach(c=>{c.width=W;c.height=H});
    undoStack=[];redoStack=[];stack.hidden=false;$('hint').hidden=true;
    buildLine();fit();status(W+'×'+H);
  };
  img.src=URL.createObjectURL(f);e.target.value='';
};
// 不透明な画像なら「明るさ→透明度」に変換して線だけにする
function buildLine(){
  if(!srcImg)return;cellCache=null;
  lctx.clearRect(0,0,W,H);lctx.drawImage(srcImg,0,0);
  const d=lctx.getImageData(0,0,W,H),p=d.data;let opaque=true;
  for(let i=3;i<p.length;i+=4){if(p[i]<255){opaque=false;break}}
  if($('conv').checked&&opaque){
    for(let i=0;i<p.length;i+=4){
      const l=.299*p[i]+.587*p[i+1]+.114*p[i+2];
      p[i]=p[i+1]=p[i+2]=0;p[i+3]=255-l;
    }
    lctx.putImageData(d,0,0);
  }
}
$('conv').onchange=buildLine;

// ---- 表示まわり ----
function setZoom(z){
  zoom=Math.max(.05,Math.min(16,z));
  stack.style.width=W*zoom+'px';stack.style.height=H*zoom+'px';
  $('zl').textContent=Math.round(zoom*100)+'%';
}
function fit(){if(!W)return;const w=$('wrap');setZoom(Math.min((w.clientWidth-24)/W,(w.clientHeight-24)/H))}
$('zi').onclick=()=>setZoom(zoom*1.25);
$('zo').onclick=()=>setZoom(zoom/1.25);
$('fit').onclick=fit;
$('showL').onchange=e=>lineC.style.display=e.target.checked?'':'none';
$('showF').onchange=e=>fillC.style.display=e.target.checked?'':'none';
$('chk').onchange=e=>stack.classList.toggle('chk',e.target.checked);
$('pan').onclick=()=>{panMode=!panMode;$('pan').classList.toggle('on',panMode);ovC.style.pointerEvents=panMode?'none':'auto'};
$('gap').oninput=e=>$('gapv').textContent=e.target.value;
$('ext').oninput=e=>$('extv').textContent=e.target.value;
$('minA').oninput=e=>$('minav').textContent=e.target.value;
$('esz').oninput=e=>$('eszv').textContent=e.target.value;
function setTool(t){tool=t;octx.clearRect(0,0,W,H);$('bFill').classList.toggle('on',t==='fill');$('bErase').classList.toggle('on',t==='erase');$('bSplit').classList.toggle('on',t==='split')}
$('bFill').onclick=()=>setTool('fill');
$('bErase').onclick=()=>setTool('erase');
$('bSplit').onclick=()=>setTool('split');

// ---- 囲う操作 ----
const pos=e=>{const r=ovC.getBoundingClientRect();return[(e.clientX-r.left)*W/r.width,(e.clientY-r.top)*H/r.height]};
function drawLasso(){
  octx.clearRect(0,0,W,H);if(pts.length<2)return;
  octx.lineWidth=2/zoom;octx.setLineDash([6/zoom,4/zoom]);
  octx.strokeStyle=tool==='erase'?'#e0443e':tool==='split'?'#1aa36b':'#2a6bff';
  octx.beginPath();pts.forEach(([x,y],i)=>i?octx.lineTo(x,y):octx.moveTo(x,y));octx.stroke();
  octx.globalAlpha=.4;octx.beginPath();octx.moveTo(...pts[pts.length-1]);octx.lineTo(...pts[0]);octx.stroke();octx.globalAlpha=1;
}
ovC.addEventListener('pointerdown',e=>{
  if(!W||panMode)return;
  ovC.setPointerCapture(e.pointerId);drawing=true;
  if(tool==='erase'){penStart(pos(e));return}
  pts=[pos(e)];
});
ovC.addEventListener('pointermove',e=>{
  if(tool==='erase'){if(!W||panMode)return;const p=pos(e);if(drawing)penMove(p);brushCircle(p);return}
  if(!drawing)return;
  const p=pos(e),q=pts[pts.length-1];
  if(Math.hypot(p[0]-q[0],p[1]-q[1])>=1){pts.push(p);drawLasso()}
});
ovC.addEventListener('pointerup',()=>{
  if(!drawing)return;drawing=false;
  if(tool==='erase'){penEnd();return}
  const P=pts.slice();octx.clearRect(0,0,W,H);
  if(P.length>2){status('処理中…');setTimeout(()=>{apply(P);status('完了')},20)}
});
ovC.addEventListener('pointercancel',()=>{drawing=false;penEnd();octx.clearRect(0,0,W,H)});
ovC.addEventListener('pointerleave',()=>{if(!drawing)octx.clearRect(0,0,W,H)});

// ---- 膨張処理（四角形の範囲でr px広げる。累積和で高速化）----
function dilate(src,w,h,r){
  if(r<=0)return src.slice();
  const tmp=new Uint8Array(w*h),out=new Uint8Array(w*h),pre=new Int32Array(Math.max(w,h)+1);
  for(let y=0;y<h;y++){
    const b=y*w;pre[0]=0;
    for(let x=0;x<w;x++)pre[x+1]=pre[x]+src[b+x];
    for(let x=0;x<w;x++){const a=Math.max(0,x-r),c=Math.min(w-1,x+r);tmp[b+x]=pre[c+1]-pre[a]>0?1:0}
  }
  for(let x=0;x<w;x++){
    pre[0]=0;
    for(let y=0;y<h;y++)pre[y+1]=pre[y]+tmp[y*w+x];
    for(let y=0;y<h;y++){const a=Math.max(0,y-r),c=Math.min(h-1,y+r);out[y*w+x]=pre[c+1]-pre[a]>0?1:0}
  }
  return out;
}

// 塗り済みの部分も「壁」として判定に含める（塗るたびに最新の塗りを読み直すので自動で更新される）
// 壁の外側にも隙間閉じ分だけ広げ、塗りの縁にぴったり接するようにする
function addFillBarrier(sealed,bx,by,bw,bh,rad){
  if(!$('useFill').checked)return null;
  const fd=fctx.getImageData(bx,by,bw,bh).data,n=bw*bh,fm=new Uint8Array(n);
  for(let i=0;i<n;i++)fm[i]=fd[i*4+3]>=128?1:0;
  const fs=dilate(fm,bw,bh,rad);
  for(let i=0;i<n;i++)if(fs[i])sealed[i]=1;
  return fm; // 塗り済みの場所（ここは上書きしない）
}

// ---- 塗る/消す本体 ----
function apply(P){
  const rad=+$('gap').value,ext=+$('ext').value,mode=$('mode').value;
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for(const[x,y]of P){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y)}
  const pad=2,bx=Math.max(0,Math.floor(x0)-pad),by=Math.max(0,Math.floor(y0)-pad);
  const bw=Math.min(W,Math.ceil(x1)+pad)-bx,bh=Math.min(H,Math.ceil(y1)+pad)-by;
  if(bw<=0||bh<=0)return;
  const n=bw*bh;
  // 囲った範囲をマスク化
  const t=document.createElement('canvas');t.width=bw;t.height=bh;
  const tc=t.getContext('2d',{willReadFrequently:true});
  tc.fillStyle='#000';tc.beginPath();
  P.forEach(([x,y],i)=>i?tc.lineTo(x-bx,y-by):tc.moveTo(x-bx,y-by));tc.closePath();tc.fill();
  const td=tc.getImageData(0,0,bw,bh).data,inL=new Uint8Array(n);
  for(let i=0;i<n;i++)inL[i]=td[i*4+3]>127?1:0;
  if(tool==='split'){doSplit(bx,by,bw,bh,inL,false);return}
  let mask=inL;
  if(mode==='trace'){
    // 線画のマスク → 隙間を閉じるため太らせる
    const ld=lctx.getImageData(bx,by,bw,bh).data,ln=new Uint8Array(n);
    for(let i=0;i<n;i++)ln[i]=ld[i*4+3]>=50?1:0;
    const sealed=dilate(ln,bw,bh,rad+ext);
    const fm=addFillBarrier(sealed,bx,by,bw,bh,rad);
    // 囲みの外側から広がる「外の領域」を求める（太らせた線は越えられない）
    const vis=new Uint8Array(n),q=new Int32Array(n);let qh=0,qt=0;
    for(let i=0;i<n;i++)if(!inL[i]){vis[i]=1;q[qt++]=i}
    while(qh<qt){
      const p=q[qh++],x=p%bw,y=(p/bw)|0;
      if(x>0&&!vis[p-1]&&!sealed[p-1]){vis[p-1]=1;q[qt++]=p-1}
      if(x<bw-1&&!vis[p+1]&&!sealed[p+1]){vis[p+1]=1;q[qt++]=p+1}
      if(y>0&&!vis[p-bw]&&!sealed[p-bw]){vis[p-bw]=1;q[qt++]=p-bw}
      if(y<bh-1&&!vis[p+bw]&&!sealed[p+bw]){vis[p+bw]=1;q[qt++]=p+bw}
    }
    const outs=new Uint8Array(n);
    for(let i=0;i<n;i++)outs[i]=vis[i]&&inL[i]?1:0;
    // 外の領域を戻して、線の外側ぎりぎり（＋はみ出し分）で止める → 線の下も塗れる
    const grow=dilate(outs,bw,bh,rad);
    mask=new Uint8Array(n);
    for(let i=0;i<n;i++)mask[i]=inL[i]&&!grow[i]&&!(fm&&fm[i])?1:0;
  }
  // 元に戻す用に保存
  snap(bx,by,bw,bh);
  // 塗り（または消し）を反映
  const c=$('color').value,cr=parseInt(c.slice(1,3),16),cg=parseInt(c.slice(3,5),16),cb=parseInt(c.slice(5,7),16);
  const id=new ImageData(bw,bh),d=id.data;
  for(let i=0;i<n;i++)if(mask[i]){d[i*4]=cr;d[i*4+1]=cg;d[i*4+2]=cb;d[i*4+3]=255}
  tc.clearRect(0,0,bw,bh);tc.putImageData(id,0,0);
  fctx.globalCompositeOperation=tool==='erase'?'destination-out':'source-over';
  fctx.drawImage(t,bx,by);
  fctx.globalCompositeOperation='source-over';
}

// ---- 元に戻す ----
// 変更した範囲だけ保存（メモリ節約のため合計約250MBまで）
const bytes=e=>e.multi?e.multi.reduce((a,t)=>a+t.img.data.length,0):e.img.data.length;
function trim(){
  let t=0;
  for(let i=undoStack.length-1;i>=0;i--){
    t+=bytes(undoStack[i]);
    if(t>2.5e8||undoStack.length-i>50){undoStack.splice(0,i);break}
  }
}
function snap(bx,by,bw,bh){
  undoStack.push({x:bx,y:by,img:fctx.getImageData(bx,by,bw,bh)});redoStack.length=0;trim();
}
// from の最後を取り出して復元し、復元前の状態を to に積む
function swap(from,to){
  const s=from.pop();if(!s)return;
  const cur=[];
  for(const t of(s.multi||[s])){
    cur.push({x:t.x,y:t.y,img:fctx.getImageData(t.x,t.y,t.img.width,t.img.height)});
    fctx.putImageData(t.img,t.x,t.y);
  }
  to.push({multi:cur});
}
const undo=()=>swap(undoStack,redoStack);
const redo=()=>swap(redoStack,undoStack);
$('undo').onclick=undo;$('redo').onclick=redo;
// Cmd/Ctrl+Z = 元に戻す、Cmd/Ctrl+Shift+Z（または Ctrl+Y）= やり直し
addEventListener('keydown',e=>{
  if(!(e.ctrlKey||e.metaKey))return;
  const k=e.key.toLowerCase();
  if(k==='z'){e.preventDefault();e.shiftKey?redo():undo()}
  else if(k==='y'){e.preventDefault();redo()}
});

// ---- 自動塗り分け ----
function hsl(h,s,l){const a=s*Math.min(l,1-l),f=n=>{const k=(n+h/30)%12;return(l-a*Math.max(-1,Math.min(k-3,9-k,1)))*255};return[f(0),f(8),f(4)]}
function doSplit(bx,by,bw,bh,inL,edge){
  const rad=+$('gap').value,ext=+$('ext').value,pct=+$('minA').value,objMode=$('smode').value==='obj',n=bw*bh,R=rad+ext;
  const ld=lctx.getImageData(bx,by,bw,bh).data,ln=new Uint8Array(n);
  for(let i=0;i<n;i++)ln[i]=ld[i*4+3]>=50?1:0;
  const sealed=dilate(ln,bw,bh,R); // 隙間を閉じた線
  const fm=addFillBarrier(sealed,bx,by,bw,bh,rad);
  const q=new Int32Array(n);let qh=0,qt=0;
  const nb=(p,f)=>{const x=p%bw,y=(p/bw)|0;if(x>0)f(p-1);if(x<bw-1)f(p+1);if(y>0)f(p-bw);if(y<bh-1)f(p+bw)};
  // 1) 背景＝囲み（または画像）の外側とつながる領域
  const bg=new Uint8Array(n);
  for(let i=0;i<n;i++){const x=i%bw,y=(i/bw)|0;if(!inL[i]||(edge&&(x===0||y===0||x===bw-1||y===bh-1))){bg[i]=1;q[qt++]=i}}
  while(qh<qt){nb(q[qh++],s=>{if(!bg[s]&&!sealed[s]){bg[s]=1;q[qt++]=s}})}
  // 2) 背景以外の閉じた領域に番号を付ける
  const lab=new Int32Array(n),areas=[0];let nl=0;
  for(let i=0;i<n;i++){
    if(bg[i]||sealed[i]||lab[i])continue;
    nl++;lab[i]=nl;qh=0;qt=0;q[qt++]=i;
    while(qh<qt){nb(q[qh++],s=>{if(!bg[s]&&!sealed[s]&&!lab[s]){lab[s]=nl;q[qt++]=s}})}
    areas.push(qt);
  }
  if(!nl)return;
  // 3) 背景側は線の外側ぎりぎりまで確保し、各領域を線の下へ広げる
  const bgIn=new Uint8Array(n);
  for(let i=0;i<n;i++)bgIn[i]=bg[i]&&inL[i]?1:0;
  const claim=dilate(bgIn,bw,bh,rad);
  const dist=new Uint8Array(n),cap=3*R+10;qh=0;qt=0;
  for(let i=0;i<n;i++)if(lab[i])q[qt++]=i;
  while(qh<qt){
    const p=q[qh++];if(dist[p]>=cap)continue;
    nb(p,s=>{if(inL[s]&&!lab[s]&&!claim[s]&&!bg[s]){lab[s]=lab[p];dist[s]=dist[p]+1;q[qt++]=s}});
  }
  // 4) 隣り合う領域どうしの境界の長さを数える
  const nbr=[];for(let l=0;l<=nl;l++)nbr.push(new Map());
  const link=(a,b)=>{if(a&&b&&a!==b){nbr[a].set(b,(nbr[a].get(b)||0)+1);nbr[b].set(a,(nbr[b].get(a)||0)+1)}};
  for(let y=0;y<bh;y++)for(let x=0;x<bw;x++){
    const i=y*bw+x,l=lab[i];if(!l)continue;
    if(x<bw-1)link(l,lab[i+1]);
    if(y<bh-1)link(l,lab[i+bw]);
  }
  // 5) 領域をまとめる（a を b に吸収）
  const par=new Int32Array(nl+1);for(let l=0;l<=nl;l++)par[l]=l;
  const find=a=>{while(par[a]!==a){par[a]=par[par[a]];a=par[a]}return a};
  const size=areas.slice();
  const merge=(a,b)=>{
    for(const[c,cnt]of nbr[a]){
      nbr[c].delete(a);
      if(c===b)continue;
      nbr[c].set(b,(nbr[c].get(b)||0)+cnt);
      nbr[b].set(c,(nbr[b].get(c)||0)+cnt);
    }
    nbr[b].delete(a);nbr[a]=new Map();size[b]+=size[a];par[a]=b;
  };
  if(objMode){
    // オブジェクト単位：つながっている領域は全部ひとまとめ（1体＝1色）
    for(let a=1;a<=nl;a++){
      for(const[b,cnt]of[...nbr[a]]){
        if(cnt<3)continue;
        const ra=find(a),rb=find(b);if(ra!==rb)merge(ra,rb);
      }
    }
  }else{
    // パーツ単位：全体の○%より小さい領域は、一番長く接している隣へまとめる
    let total=0;for(let l=1;l<=nl;l++)total+=areas[l];
    const T=Math.max(30,total*pct/100);
    const order=[];for(let l=1;l<=nl;l++)order.push(l);
    order.sort((a,b)=>areas[a]-areas[b]);
    for(let pass=0;pass<3;pass++){
      let changed=false;
      for(const l of order){
        if(par[l]!==l||size[l]>=T)continue;
        let best=0,bc=0;
        for(const[c,cnt]of nbr[l])if(cnt>bc){bc=cnt;best=c}
        if(best){merge(l,best);changed=true}
      }
      if(!changed)break;
    }
  }
  // 6) まとまりごとに違う色で塗る（ごく小さい孤立したゴミは塗らない）
  const seed=Math.random()*360,lv=[.58,.5,.66],colOf=new Map();let ci=0;
  snap(bx,by,bw,bh);
  const id=new ImageData(bw,bh),d=id.data;
  for(let i=0;i<n;i++){
    const l=lab[i];if(!l||(fm&&fm[i]))continue;
    const r=find(l);if(size[r]<30)continue;
    let c=colOf.get(r);
    if(!c){c=hsl((seed+ci*137.508)%360,.62,lv[ci%3]);ci++;colOf.set(r,c)}
    d[i*4]=c[0];d[i*4+1]=c[1];d[i*4+2]=c[2];d[i*4+3]=255;
  }
  const t=document.createElement('canvas');t.width=bw;t.height=bh;t.getContext('2d').putImageData(id,0,0);
  fctx.globalCompositeOperation='source-over';fctx.drawImage(t,bx,by);
}

// ---- 全部クリア（塗りだけ全消し。「元に戻す」で復活できる）----
$('clr').onclick=()=>{if(!W)return;snap(0,0,W,H);fctx.clearRect(0,0,W,H)};

// ---- ペン消しゴム（線画のエッジに沿って消す）----
let cellCache=null,pen=null;
// 線で区切られた領域の番号表（線の下は近い領域に所属）。線画やスライダーが変わるまで使い回す
function getCells(){
  const key=$('gap').value+','+$('ext').value;
  if(cellCache&&cellCache.key===key)return cellCache.lab;
  const R=(+$('gap').value)+(+$('ext').value),n=W*H;
  const ld=lctx.getImageData(0,0,W,H).data,ln=new Uint8Array(n);
  for(let i=0;i<n;i++)ln[i]=ld[i*4+3]>=50?1:0;
  const sealed=dilate(ln,W,H,R);
  const nb=(p,f)=>{const x=p%W,y=(p/W)|0;if(x>0)f(p-1);if(x<W-1)f(p+1);if(y>0)f(p-W);if(y<H-1)f(p+W)};
  const lab=new Int32Array(n),q=new Int32Array(n);let nl=0,qh,qt;
  for(let i=0;i<n;i++){
    if(sealed[i]||lab[i])continue;
    nl++;lab[i]=nl;qh=0;qt=0;q[qt++]=i;
    while(qh<qt){nb(q[qh++],s=>{if(!sealed[s]&&!lab[s]){lab[s]=nl;q[qt++]=s}})}
  }
  const dist=new Uint8Array(n),cap=3*R+10;qh=0;qt=0;
  for(let i=0;i<n;i++)if(lab[i])q[qt++]=i;
  while(qh<qt){
    const p=q[qh++];if(dist[p]>=cap)continue;
    nb(p,s=>{if(!lab[s]){lab[s]=lab[p];dist[s]=dist[p]+1;q[qt++]=s}});
  }
  cellCache={key,lab};return lab;
}
function brushCircle(p){
  octx.clearRect(0,0,W,H);octx.setLineDash([]);octx.lineWidth=1.5/zoom;octx.strokeStyle='#e0443e';
  octx.beginPath();octx.arc(p[0],p[1],(+$('esz').value)/2,0,Math.PI*2);octx.stroke();
}
function penStart(p){
  const me=pen={last:p,L:0,lab:null,ready:false,tiles:new Map()};
  const trace=$('mode').value==='trace';
  const go=()=>{if(pen!==me)return;me.lab=trace?getCells():null;me.ready=true;penErase(p,p)};
  if(trace&&!(cellCache&&cellCache.key===$('gap').value+','+$('ext').value)){
    status('線画を解析中…');setTimeout(()=>{go();status('')},20);
  }else go();
}
function penMove(p){
  if(!pen||!pen.ready)return;
  if(Math.hypot(p[0]-pen.last[0],p[1]-pen.last[1])<1)return;
  penErase(pen.last,p);pen.last=p;
}
function penEnd(){
  if(pen&&pen.tiles.size){undoStack.push({multi:[...pen.tiles.values()]});redoStack.length=0;trim()}
  pen=null;
}
// 触れる前の絵を128px四角のタイルごとに保存（元に戻す用）
function saveTiles(x0,y0,w,h){
  for(let ty=y0>>7;ty<=(y0+h-1)>>7;ty++)for(let tx=x0>>7;tx<=(x0+w-1)>>7;tx++){
    const k=ty*10000+tx;if(pen.tiles.has(k))continue;
    const X=tx<<7,Y=ty<<7;
    pen.tiles.set(k,{x:X,y:Y,img:fctx.getImageData(X,Y,Math.min(128,W-X),Math.min(128,H-Y))});
  }
}
// a→b をなぞった丸いブラシで消す。最初に触れた領域の外（線の向こう側）は消さない
function penErase(a,b){
  const r=(+$('esz').value)/2;
  const x0=Math.max(0,Math.floor(Math.min(a[0],b[0])-r-1)),y0=Math.max(0,Math.floor(Math.min(a[1],b[1])-r-1));
  const x1=Math.min(W,Math.ceil(Math.max(a[0],b[0])+r+1)),y1=Math.min(H,Math.ceil(Math.max(a[1],b[1])+r+1));
  const w=x1-x0,h=y1-y0;if(w<=0||h<=0)return;
  const lab=pen.lab;
  if(lab&&!pen.L){
    const cx=Math.min(W-1,Math.max(0,a[0]|0)),cy=Math.min(H-1,Math.max(0,a[1]|0));
    pen.L=lab[cy*W+cx];
    if(!pen.L)return;
  }
  saveTiles(x0,y0,w,h);
  const img=fctx.getImageData(x0,y0,w,h),d=img.data;
  const dx=b[0]-a[0],dy=b[1]-a[1],len2=dx*dx+dy*dy,lim=(r+.5)*(r+.5);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const px=x0+x+.5,py=y0+y+.5;
    let t=len2?((px-a[0])*dx+(py-a[1])*dy)/len2:0;t=t<0?0:t>1?1:t;
    const ex=a[0]+t*dx-px,ey=a[1]+t*dy-py,d2=ex*ex+ey*ey;
    if(d2>lim)continue;
    if(lab&&lab[(y0+y)*W+x0+x]!==pen.L)continue;
    const cov=Math.min(1,r+.5-Math.sqrt(d2)),k=(y*w+x)*4+3;
    d[k]=d[k]*(1-cov);
  }
  fctx.putImageData(img,x0,y0);
}

// 画像全体を自動塗り分け（画像の外周につながる部分＝背景は塗らない）
$('bAll').onclick=()=>{
  if(!W)return;status('処理中…');
  setTimeout(()=>{doSplit(0,0,W,H,new Uint8Array(W*H).fill(1),true);status('完了')},20);
};

// ---- 保存（塗りのみ/線画あり × 透過/白背景）----
document.querySelectorAll('[data-s]').forEach(b=>b.onclick=()=>{
  if(!W)return;
  const [withLine,white,suffix]=b.dataset.s.split(',');
  const c=document.createElement('canvas');c.width=W;c.height=H;
  const x=c.getContext('2d');
  if(white==='1'){x.fillStyle='#fff';x.fillRect(0,0,W,H)}
  x.drawImage(fillC,0,0);
  if(withLine==='1')x.drawImage(lineC,0,0);
  c.toBlob(bl=>{
    const a=document.createElement('a');a.href=URL.createObjectURL(bl);a.download=baseName+suffix+'.png';
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  },'image/png');
});
// ---- 塗りだけをクリップボードにコピー（透過PNG）----
$('copyFill').onclick=()=>{
  if(!W)return;
  if(!navigator.clipboard||!window.ClipboardItem){status('このブラウザはコピーに未対応です。保存を使ってください');return}
  // クリック操作の直後に書き込みを始める（Safari対策でBlobはPromiseで渡す）
  const item=new ClipboardItem({'image/png':new Promise(r=>fillC.toBlob(r,'image/png'))});
  navigator.clipboard.write([item]).then(
    ()=>status('塗りをコピーしました'),
    ()=>status('コピーできませんでした。保存を使ってください')
  );
};
addEventListener('resize',()=>{if(W&&zoom<=0.05)fit()});
