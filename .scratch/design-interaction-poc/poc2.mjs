import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { parsePenText } from '../../dist/pen/read.js';
import { renderPenScreens } from '../../dist/pen/render.js';

const FILE='/Users/louis/.pencil/documents/7789acea-67d5-42ed-bbda-8c0764c606b9/untitled.pen';
const doc=parsePenText(fs.readFileSync(FILE,'utf-8'));
const boardChildren=[];
for(const b of doc.children||[])for(const c of b.children||[])if(c&&c.type==='frame'&&c.id)boardChildren.push({node:c,board:b.id,parent:b.id});
const containers=[...boardChildren];
for(const bc of boardChildren)for(const c of bc.node.children||[])if(c&&c.type==='frame'&&c.id)containers.push({node:c,board:bc.board,parent:bc.node.id});
const targetIds=['OFftq','pEfey','j6XA0','RVg6w','n6dGB','Z4OR6X','w8OHy','CSMVD','uorYu'];
const byId=new Map(containers.map(c=>[c.node.id,c]));
// add targets by walking doc
function find(n,id){if(n.id===id)return n;for(const c of n.children||[]){const r=find(c,id);if(r)return r;}return null;}
for(const id of targetIds){const n=find(doc,id);if(n&&!byId.has(id)){byId.set(id,{node:n,board:null,parent:null});containers.push({node:n,board:null,parent:null});}}
const ids=[...byId.keys()];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aos-poc2-'));
const t0=Date.now();
const rendered=await renderPenScreens({target:FILE,screenIds:ids,outDir:tmp,env:process.env});
const renderMs=Date.now()-t0;
const dims=new Map(),gray=new Map();
for(const id of ids){const f=rendered.files.get(id);if(!f)continue;const png=PNG.sync.read(fs.readFileSync(f));dims.set(id,{w:png.width,h:png.height});const g=new Float64Array(png.width*png.height);for(let i=0;i<g.length;i++){const j=i*4;g[i]=0.299*png.data[j]+0.587*png.data[j+1]+0.114*png.data[j+2];}gray.set(id,{w:png.width,h:png.height,g});}
const viewport={w:375,h:855};const va=viewport.w/viewport.h;
function frameClass(id){const d=dims.get(id);if(!d)return 'component';const wd=Math.abs(d.w-viewport.w)/viewport.w,hd=Math.abs(d.h-viewport.h)/viewport.h,asp=d.w/d.h,ad=Math.abs(asp-va)/va;if(d.w>viewport.w*1.1||d.h>viewport.h*1.2)return 'overlay';if(asp>va*1.05||d.h>viewport.h*1.1)return 'full-content';if(wd<=0.05&&(hd<=0.06||ad<=0.06))return 'viewport-state';if(d.w<viewport.w*0.9&&d.h<viewport.h*0.9)return 'overlay';return 'component';}
const cls=new Map(ids.map(id=>[id,frameClass(id)]));
const counts={};for(const c of cls.values())counts[c]=(counts[c]??0)+1;
function texts(node){const out=[];const walk=(n,acc=0)=>{const y=typeof n.y==='number'?acc+n.y:acc;if(typeof n.content==='string'&&n.content.trim()!=='')out.push({text:n.content.trim(),y});for(const c of n.children||[])walk(c,y)};walk(node,0);return out;}
const norm=s=>s.normalize('NFKC').replace(/[\u3000\s]+/g,'').replace(/[，。！？、；：""''（）【】《》]/g,'').toLowerCase();
function tmap(node){const m=new Map();for(const t of texts(node)){const k=norm(t.text);if(!m.has(k))m.set(k,[]);m.get(k).push(t.y)}return m;}
function compare(a,b){const A=tmap(a),B=tmap(b);const matched=[];for(const[k,ys]of A){const bs=B.get(k);if(bs&&bs.length)matched.push({k,ya:ys[0],yb:bs[0]})}const hist=new Map();for(const m of matched){const d=Math.round(m.ya-m.yb);hist.set(d,(hist.get(d)??0)+1)}const [mode,count]=[...hist.entries()].sort((x,y)=>y[1]-x[1])[0]??[null,0];const support=matched.length?count/matched.length:0;const inter=[...A.keys()].filter(k=>B.has(k)).length;const union=new Set([...A.keys(),...B.keys()]).size;const contentDiff=union?1-inter/union:0;return{matched:matched.length,mode,support,contentDiff};}
function ncc(aId,bId,d){const a=gray.get(aId),b=gray.get(bId);if(!a||!b||d===null)return null;let shift=d,first=a,second=b;if(shift<0){first=b;second=a;shift=-shift;}const h=Math.min(second.h,first.h-shift);if(h<=100)return null;let sa=0,sb=0,saa=0,sbb=0,sab=0,n=0;for(let y=0;y<h;y+=2)for(let x=0;x<Math.min(first.w,second.w);x+=2){const va1=first.g[(y+shift)*first.w+x],vb1=second.g[y*second.w+x];sa+=va1;sb+=vb1;saa+=va1*va1;sbb+=vb1*vb1;sab+=va1*vb1;n++;}const cov=sab/n-(sa/n)*(sb/n);const v1=saa/n-(sa/n)**2,v2=sbb/n-(sb/n)**2;return v1<=0||v2<=0?null:cov/Math.sqrt(v1*v2);}
const candidates=[];const stats={pairs:0,textOverlap:0,scrollRaw:0,scrollKept:0,stateChange:0,duplicate:0,gray:0,blocked:0};
for(const a of containers){for(const b of containers){if(a.node.id===b.node.id)continue;stats.pairs++;const ca=cls.get(a.node.id),cb=cls.get(b.node.id);if(ca==='overlay'||ca==='component'||cb==='overlay'||cb==='component'){stats.blocked++;continue;}const c=compare(a.node,b.node);if(c.matched<8)continue;stats.textOverlap++;if(ca==='full-content'&&cb==='full-content'){if(Math.abs(c.mode)<=8&&c.contentDiff>=0.2)stats.stateChange++;else stats.blocked++;continue;}if(Math.abs(c.mode)<=8&&c.support>=0.8){if(c.contentDiff>=0.2)stats.stateChange++;else stats.duplicate++;continue;}if(Math.abs(c.mode)>=50&&c.support>=0.8){stats.scrollRaw++;const n=ncc(a.node.id,b.node.id,c.mode);if(n!==null&&n>=0.65){stats.scrollKept++;candidates.push({A:a.node.id,B:b.node.id,Acls:ca,Bcls:cb,...c,ncc:n});}}else stats.gray++;}}
candidates.sort((a,b)=>b.matched-a.matched);
const report={generatedAt:new Date().toISOString(),render:{frames:ids.length,ok:rendered.ok,missing:rendered.missing.length,ms:renderMs},viewport,classCounts:counts,stats,candidates:candidates.slice(0,30),
 targets:{mop:compare(byId.get('OFftq').node,byId.get('pEfey').node),search:compare(byId.get('j6XA0').node,byId.get('RVg6w').node),state1:compare(byId.get('w8OHy').node,byId.get('CSMVD').node),state2:compare(byId.get('w8OHy').node,byId.get('uorYu').node)}};
fs.writeFileSync(path.resolve('.scratch/design-interaction-poc/poc2-result.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
