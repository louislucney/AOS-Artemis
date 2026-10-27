import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { parsePenText } from '../../dist/pen/read.js';
import { renderPenScreens } from '../../dist/pen/render.js';

const FILE='/Users/louis/.pencil/documents/7789acea-67d5-42ed-bbda-8c0764c606b9/untitled.pen';
const OUT='.scratch/design-interaction-poc';
const doc=parsePenText(fs.readFileSync(FILE,'utf-8'));

const boardChildren=[];
for(const b of doc.children||[]) for(const c of b.children||[]) if(c&&c.type==='frame'&&c.id) boardChildren.push({node:c,board:b.id,parent:b.id});
const containers=[...boardChildren];
for(const bc of boardChildren) for(const c of bc.node.children||[]) if(c&&c.type==='frame'&&c.id) containers.push({node:c,board:bc.board,parent:bc.node.id});

const parentOf=new Map(),boardOf=new Map();
function walkTree(n,parent=null,board=null){if(n&&n.type==='frame'&&n.id){parentOf.set(n.id,parent);boardOf.set(n.id,board??n.id);}for(const c of n.children||[])walkTree(c,n,board??n.id);}
for(const b of doc.children||[]) walkTree(b,null,null);
function findNode(n,id){if(n.id===id)return n;for(const c of n.children||[]){const r=findNode(c,id);if(r)return r;}return null;}
for(const id of ['OFftq','pEfey','j6XA0','RVg6w','n6dGB','Z4OR6X','w8OHy','CSMVD','uorYu']){
  if(containers.some(c=>c.node.id===id)) continue;
  const n=findNode(doc,id);
  if(n) containers.push({node:n,board:boardOf.get(id),parent:parentOf.get(id)});
}
const byId=new Map(containers.map(c=>[c.node.id,c]));
const ids=[...byId.keys()];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aos-poc4-'));
const t0=Date.now();
const rendered=await renderPenScreens({target:FILE,screenIds:ids,outDir:tmp,env:process.env});
const renderMs=Date.now()-t0;

const dims=new Map(),gray=new Map();
for(const id of ids){
  const f=rendered.files.get(id); if(!f) continue;
  const png=PNG.sync.read(fs.readFileSync(f));
  dims.set(id,{w:png.width,h:png.height});
  const g=new Float64Array(png.width*png.height);
  for(let i=0;i<g.length;i++){const j=i*4;g[i]=.299*png.data[j]+.587*png.data[j+1]+.114*png.data[j+2];}
  gray.set(id,{w:png.width,h:png.height,g});
}
const viewport={w:375,h:855};
const vAspect=viewport.w/viewport.h;
function frameClass(id){
  const d=dims.get(id); if(!d) return 'component';
  const wd=Math.abs(d.w-viewport.w)/viewport.w;
  const aspect=d.w/d.h;
  if(d.w>viewport.w*1.1) return 'overlay';
  if(wd<=0.05 && d.h>=viewport.h*0.9 && d.h<=viewport.h*1.05) return 'viewport-state';
  if(d.h>viewport.h*1.05 || aspect>vAspect*1.05) return 'full-content';
  if(d.w<viewport.w*0.9 && d.h<viewport.h*0.9) return 'overlay';
  return 'component';
}
const cls=new Map(ids.map(id=>[id,frameClass(id)]));
const classCounts={}; for(const c of cls.values()) classCounts[c]=(classCounts[c]??0)+1;

function texts(node){
  const out=[];
  const walk=(n,acc)=>{const y=typeof n.y==='number'?acc+n.y:acc;if(typeof n.content==='string'&&n.content.trim())out.push({text:n.content.trim(),y});for(const c of n.children||[])walk(c,y);};
  for(const c of node.children||[]) walk(c,0);
  return out;
}
const norm=s=>s.normalize('NFKC').replace(/[\u3000\s]+/g,'').replace(/[，。！？、；：""''（）【】《》]/g,'').toLowerCase();
function tmap(node){const m=new Map();for(const t of texts(node)){const k=norm(t.text);if(!m.has(k))m.set(k,[]);m.get(k).push(t.y);}return m;}
function compare(a,b){
  const A=tmap(a),B=tmap(b); const matched=[];
  for(const [k,ys] of A){const bs=B.get(k); if(bs&&bs.length) matched.push({k,ya:ys[0],yb:bs[0]});}
  const hist=new Map(); for(const m of matched){const d=Math.round(m.ya-m.yb);hist.set(d,(hist.get(d)??0)+1);}
  const [mode,count]=[...hist.entries()].sort((x,y)=>y[1]-x[1])[0]??[null,0];
  const support=matched.length?count/matched.length:0;
  const inter=[...A.keys()].filter(k=>B.has(k)).length;
  const union=new Set([...A.keys(),...B.keys()]).size;
  return {matched:matched.length,mode,support,contentDiff:union?1-inter/union:1};
}
function ncc(aId,bId,d){
  const a=gray.get(aId),b=gray.get(bId); if(!a||!b||d===null) return null;
  let shift=d,first=a,second=b; if(shift<0){first=b;second=a;shift=-shift;}
  const h=Math.min(second.h,first.h-shift); if(h<=100) return null;
  let sa=0,sb=0,saa=0,sbb=0,sab=0,n=0;
  for(let y=0;y<h;y+=2)for(let x=0;x<Math.min(first.w,second.w);x+=2){const va=first.g[(y+shift)*first.w+x],vb=second.g[y*second.w+x];sa+=va;sb+=vb;saa+=va*va;sbb+=vb*vb;sab+=va*vb;n++;}
  const cov=sab/n-(sa/n)*(sb/n),v1=saa/n-(sa/n)**2,v2=sbb/n-(sb/n)**2;
  return v1<=0||v2<=0?null:cov/Math.sqrt(v1*v2);
}
function ancestor(aId,bId){let p=parentOf.get(bId);while(p){if(p===aId)return true;p=parentOf.get(p);}return false;}
function dedupePairs(list){
  const out=[],seen=new Set();
  for(const x of list){const key=[x.A,x.B].sort().join('|');if(seen.has(key))continue;seen.add(key);
    const dup=out.find(y=>Math.abs((y.mode??0)-(x.mode??0))<=8&&((ancestor(y.A,x.A)&&ancestor(y.B,x.B))||(ancestor(x.A,y.A)&&ancestor(x.B,y.B))));
    if(!dup)out.push(x);
  }
  return out;
}

function sameFamily(aId,bId,c){
  const ba=boardOf.get(aId),bb=boardOf.get(bId);
  if(ba&&bb&&ba===bb)return true;
  if(c.matched>=8){const n=ncc(aId,bId,0);if(n!==null&&n>=0.9)return true;}
  return false;
}
function familyKey(aId,bId){const ba=boardOf.get(aId)??aId,bb=boardOf.get(bId)??bId;return [ba,bb].sort().join('|');}

const scrollRaw=[],stateRaw=[],grayRaw=[];
const stats={pairs:0,textOverlap:0,crossFamily:0,scrollRaw:0,scrollKept:0,stateRaw:0,stateKept:0,grayRaw:0,grayKept:0,duplicate:0,blocked:0};
for(const a of containers)for(const b of containers){
  if(a.node.id===b.node.id)continue;
  stats.pairs++;
  const ca=cls.get(a.node.id),cb=cls.get(b.node.id);
  if(ca==='overlay'||ca==='component'||cb==='overlay'||cb==='component'){stats.blocked++;continue;}
  const c=compare(a.node,b.node); if(c.matched<8)continue;
  stats.textOverlap++;
  if(!sameFamily(a.node.id,b.node.id,c)){stats.crossFamily++;continue;}
  if(ca==='full-content'&&cb==='full-content'){
    const n0=ncc(a.node.id,b.node.id,0);
    if(Math.abs(c.mode)<=8&&c.contentDiff>=0.1&&c.contentDiff<=0.3&&n0!==null&&n0>=0.45){stateRaw.push({A:a.node.id,B:b.node.id,...c,ncc0:n0});stats.stateRaw++;}
    else stats.blocked++;
    continue;
  }
  if(Math.abs(c.mode)<=8&&c.support>=0.8){
    if(c.contentDiff>=0.1&&c.contentDiff<=0.3){
      const n=ncc(a.node.id,b.node.id,0);
      if(n!==null&&n>=0.45){stateRaw.push({A:a.node.id,B:b.node.id,...c,ncc0:n});stats.stateRaw++;}
    } else if(c.contentDiff<0.05) stats.duplicate++;
    else stats.blocked++;
    continue;
  }
  if(Math.abs(c.mode)>=50&&c.support>=0.8){
    stats.scrollRaw++;
    const n=ncc(a.node.id,b.node.id,c.mode);
    if(n!==null&&n>=0.65){stats.scrollKept++;scrollRaw.push({A:a.node.id,B:b.node.id,...c,ncc:n});}
    continue;
  }
  if(c.contentDiff>=0.05&&c.contentDiff<=0.1){
    const n=ncc(a.node.id,b.node.id,0);
    if(n!==null&&n>=0.45){grayRaw.push({A:a.node.id,B:b.node.id,...c,ncc0:n});stats.grayRaw++;}
  }
}

const scrollAll=dedupePairs(scrollRaw);
const scrollByFamily=new Map();
for(const x of [...scrollAll].sort((a,b)=>b.matched-a.matched||b.support-a.support||b.ncc-a.ncc)){const f=familyKey(x.A,x.B);if(!scrollByFamily.has(f))scrollByFamily.set(f,x);}
const scroll=[...scrollByFamily.values()];
const stateDeduped=dedupePairs(stateRaw);
const grayDeduped=dedupePairs(grayRaw);

// state-change: keep top 2 nearest per node within its family (avoid C(n,2) explosion)
const stateSorted=[...stateDeduped].sort((a,b)=>a.contentDiff-b.contentDiff);
const byNode=new Map();
for(const x of stateSorted){for(const id of [x.A,x.B]){if(!byNode.has(id))byNode.set(id,[]);byNode.get(id).push(x);}}
const stateKeep=new Set();
for(const [id,list] of byNode){for(const x of list.slice(0,2))stateKeep.add(x);}
const stateAll=[...stateKeep].sort((a,b)=>a.contentDiff-b.contentDiff||b.ncc0-a.ncc0);
const stateByFamily=new Map();
for(const x of stateAll){const f=familyKey(x.A,x.B);if(!stateByFamily.has(f))stateByFamily.set(f,[]);stateByFamily.get(f).push(x);}
const state=[];for(const list of stateByFamily.values())state.push(...list.slice(0,3));
const stateCapped=state.slice(0,20);

// gray: top 1 per family + cap 20
const grayByFamily=new Map();
for(const x of grayDeduped.sort((a,b)=>a.contentDiff-b.contentDiff)){const f=familyKey(x.A,x.B);if(!grayByFamily.has(f))grayByFamily.set(f,[]);grayByFamily.get(f).push(x);}
const grayList=[];for(const list of grayByFamily.values()){for(const x of list.slice(0,1))grayList.push(x);}
const grayCapped=grayList.slice(0,20);

const target=(id)=>byId.get(id)?.node;
const fmt=(a,b)=>({...compare(target(a),target(b)),ncc0:ncc(a,b,0),nccMode:ncc(a,b,compare(target(a),target(b)).mode)});
const report={
  generatedAt:new Date().toISOString(),
  render:{frames:ids.length,ok:rendered.ok,missing:rendered.missing.length,ms:renderMs},
  viewport,classCounts,
  stats:{...stats,stateKept:stateCapped.length,stateAll:stateAll.length,grayKept:grayCapped.length,scrollKept:scroll.length,scrollAll:scrollAll.length},
  scroll:scroll.slice(0,10).map(x=>({...x,takeover:x.A==='OFftq'||x.B==='OFftq'||x.A==='pEfey'||x.B==='pEfey'?{bar:'到店自取',region:'header'}:undefined})),
  stateChange:stateCapped,
  questions:grayCapped,
  targets:{mop:fmt('OFftq','pEfey'),search:fmt('j6XA0','RVg6w'),state1:fmt('w8OHy','CSMVD'),state2:fmt('w8OHy','uorYu')}
};
fs.writeFileSync(path.join(OUT,'poc4-result.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({render:report.render,classCounts,stats:report.stats,scroll:report.scroll,targets:report.targets,stateTop:report.stateChange.slice(0,10),questions:report.questions.slice(0,10)},null,2));
