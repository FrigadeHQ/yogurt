import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../content/home.html',import.meta.url),'utf8');
const bootstrap=html.match(/<script>\s*(\(function\(\)[\s\S]*?)<\/script>/)[1];
const script=readFileSync(new URL('../public/marketing/theme.mjs',import.meta.url),'utf8').replace('export function','function');
assert.ok(html.indexOf(bootstrap)<html.indexOf('href="/marketing/site.css"'));

// Keep the scalable icon last so browsers can prefer it to the bitmap.
const iconLinks=[...html.matchAll(/<link\b[^>]*\brel="(?:apple-touch-)?icon"[^>]*>/g)].map(([link])=>
  Object.fromEntries([...link.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,value]))
);
assert.deepEqual(iconLinks.map(({rel,type,sizes,href})=>[rel,type,sizes,href]),[
  ['icon','image/png','32x32','/marketing/assets/favicon-32.png'],
  ['icon','image/svg+xml','any','/marketing/assets/favicon.svg'],
  ['apple-touch-icon',undefined,'180x180','/marketing/assets/apple-touch-icon.png'],
]);
const [bitmap,vector,touch]=iconLinks.map(({href})=>readFileSync(new URL('../public'+href,import.meta.url)));
assert.match(vector.toString(), /<path\s+fill="#6F00FF"/i);
assert.match(vector.toString(), /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*path\s*\{\s*fill:\s*#C39AFF\b/i);
for(const [png,size] of [[bitmap,32],[touch,180]]){
  assert.equal(png.toString('ascii',1,4),'PNG');
  assert.equal(png.readUInt32BE(16),size);
  assert.equal(png.readUInt32BE(20),size);
}

function page(saved,{blocked=false,search='',systemDark=false}={}){
  const classes=new Set(),listeners=[];
  const media={matches:systemDark,addEventListener:(_name,fn)=>listeners.push(fn)};
  const root={dataset:{theme:'light'},classList:{add:v=>classes.add(v),remove:v=>classes.delete(v)}};
  const toggle={hidden:true,setAttribute(k,v){this[k]=v},addEventListener(k,fn){this[k]=fn}};
  const meta={content:'#ffffff'};
  const frames=[false,true].map(hero=>({classList:{contains:()=>hero},contentDocument:{documentElement:{dataset:{},style:{}}}}));
  const storage=new Map(saved===undefined?[]:[['yogurt-theme',saved]]);
  const context=vm.createContext({
    URLSearchParams,location:{search},matchMedia:()=>media,
    document:{documentElement:root,querySelector:s=>s==='.theme-toggle'?toggle:meta,
      querySelectorAll:()=>frames},
    localStorage:{getItem(k){if(blocked)throw Error('denied');return storage.get(k)},setItem(k,v){if(blocked)throw Error('denied');storage.set(k,v)}},
    requestAnimationFrame:fn=>fn(),
  });
  vm.runInContext(bootstrap,context);
  const initial=root.dataset.theme;
  assert.equal(meta.content,initial==='dark'?'#1B1B1D':'#ffffff');
  vm.runInContext(script,context);
  return {root,toggle,meta,frames,storage,context,initial,system(dark){media.matches=dark;listeners.forEach(fn=>fn({matches:dark}))}};
}

for(const systemDark of [false,true])for(const saved of [undefined,'light','dark','invalid']){
  const p=page(saved,{systemDark});
  assert.equal(p.initial,saved==='light'||saved==='dark'?saved:systemDark?'dark':'light');
  assert.equal(p.toggle.hidden,false);
  for(let i=0;i<2;i++){
    const next=p.root.dataset.theme==='dark'?'light':'dark';
    p.toggle.click();
    assert.equal(p.root.dataset.theme,next);
    assert.equal(p.storage.get('yogurt-theme'),next);
    assert.equal(p.toggle['aria-label'],`Switch to ${next==='dark'?'light':'dark'} mode`);
    assert.equal(p.toggle['aria-pressed'],String(next==='dark'));
    assert.equal(p.meta.content,next==='dark'?'#1B1B1D':'#ffffff');
    assert.equal(p.frames[0].contentDocument.documentElement.dataset.marketingTheme,next);
    assert.equal(p.frames[1].contentDocument.documentElement.dataset.marketingTheme,'dark');
    assert.equal(page(p.storage.get('yogurt-theme')).initial,next);
  }
  // Lazy frames inherit the current choice before their ready handler reveals them.
  p.context.lateFrame={classList:{contains:()=>false},contentDocument:{documentElement:{dataset:{},style:{}}}};
  vm.runInContext('syncFrameTheme(lateFrame)',p.context);
  assert.equal(p.context.lateFrame.contentDocument.documentElement.dataset.marketingTheme,p.root.dataset.theme);
  vm.runInContext('syncFrameTheme({contentDocument:null})',p.context);
}
const blocked=page('dark',{blocked:true});
assert.equal(blocked.initial,'light');
assert.doesNotThrow(()=>blocked.toggle.click());
assert.equal(blocked.root.dataset.theme,'dark');
assert.equal(blocked.toggle['aria-pressed'],'true');

for(const saved of ['light','dark']){
  const p=page(saved,{search:'?edge=light&static=1'});
  assert.equal(p.root.dataset.heroStatic,'true','static previews skip the copy entrance before first paint');
  assert.equal(p.root.dataset.heroEdge,undefined,'the hero edge has no URL switch');
}


for(const saved of [undefined,'invalid']){
  const p=page(saved,{systemDark:true});
  assert.equal(p.initial,'dark','system dark applies before styles load');
  for(const dark of [false,true,false]){
    p.system(dark);
    assert.equal(p.root.dataset.theme,dark?'dark':'light');
    assert.equal(p.toggle['aria-pressed'],String(dark));
    assert.equal(p.frames[0].contentDocument.documentElement.dataset.marketingTheme,dark?'dark':'light');
  }
  p.toggle.click();p.system(false);
  assert.equal(p.root.dataset.theme,'dark','manual choice wins after system changes');
}
for(const saved of ['light','dark']){
  const p=page(saved,{systemDark:saved==='light'});
  p.system(false);p.system(true);
  assert.equal(p.root.dataset.theme,saved,'stored preference wins');
}
const denied=page(undefined,{blocked:true,systemDark:true});
assert.equal(denied.initial,'dark');
denied.toggle.click();denied.system(true);
assert.equal(denied.root.dataset.theme,'light','manual preference wins in memory when storage is denied');

function luminance(hex){
  const channels=hex.match(/[\da-f]{2}/gi).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return channels.reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
}
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
const css=readFileSync(new URL('../public/marketing/site.css',import.meta.url),'utf8');
assert(!/data-hero-edge/.test(css),'no hero edge comparison rules remain');
assert(css.includes(':root[data-theme=light] .product-stage>.product-window.demo-window{border:1px solid #5A5A5E}'),'light mode gives the demo window a mid-grey border');
assert(css.includes(':root[data-theme=dark] .product-stage>.product-window.demo-window::after{'),'dark inner highlight remains the default');
assert.match(css,/\.marker-track\s*\{\s*stroke:\s*var\(--hairline\)/);
assert.ok(html.includes('class="nav-stars"') && html.includes('nav-download'));
const dark=css.match(/:root\[data-theme=dark\]\{color-scheme:dark;([^}]+)\}/)[1];
const tokens=Object.fromEntries([...dark.matchAll(/--([\w-]+):(#[\da-f]+)/gi)].map(([,key,value])=>[key,value]));
const pairs=[
  ['Body',tokens.ink,tokens.bg],['Muted',tokens.muted,tokens.bg],
  ['Card body',tokens.ink,tokens.float],['Card muted',tokens.muted,tokens.float],
  ['Accent',tokens.accent,tokens.bg],['Primary button','#ffffff','#6F00FF'],
  ['Primary hover','#ffffff','#6200E0'],['Secondary hover',tokens.ink,'#333335'],
  ['Flat footer','#ffffff','#6F00FF'],['Footer button','#26242b','#ffffff'],
  ['Dark walkthrough body','#A7A4AD','#1B1B1D'],['Selected step','#ffffff','#6F00FF'],
];
for(const [label,fg,bg] of pairs){
  const ratio=contrast(fg,bg);
  assert.ok(ratio>=4.5,`${label}: ${ratio.toFixed(2)}:1`);
  console.log(`${label}: ${ratio.toFixed(2)}:1`);
}
console.log('Theme bootstrap, persistence, denied storage, toggle, frames and contrast passed.');
