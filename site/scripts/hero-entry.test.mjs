import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {ribbonGeometry,ribbonPath} from '../public/marketing/ribbon-geometry.mjs'

const entry=readFileSync(new URL('../public/marketing/hero-entry.mjs',import.meta.url),'utf8').replace(/^import .*\n/,'')
const ribbons=readFileSync(new URL('../public/marketing/ribbons.mjs',import.meta.url),'utf8')
for(const width of [1280,1728,2560])for(const [search,reduced] of [['?static=1',false],['?static=1',true],['?static=0',true],['',true]]){
  const dataset={heroEntry:'pending'},events=[]
  let viewport=width,onResize
  const node=attributes=>({attributes,getAttribute(name){return this.attributes[name]},setAttribute(name,value){this.attributes[name]=value}})
  const path=node({d:'M0 0 800 325 0 130Z'}),mirror=node({}),gradient=node({}),reflection=node({})
  const product={getBoundingClientRect:()=>({width:Math.min(viewport*.76,1200),height:Math.min(viewport*.76,1200)*.608})}
  const svg={...node({}),getBoundingClientRect:()=>({width:viewport,height:Math.min(viewport,1728)*.4256}),
    querySelectorAll:selector=>selector==='defs path'?[path]:[mirror],querySelector:selector=>selector==='#ribbon-purple'?gradient:reflection}
  const context=vm.createContext({
    URLSearchParams,Event,location:{search},ribbonGeometry,ribbonPath,
    matchMedia:()=>({matches:reduced,addEventListener(){}}),
    document:{documentElement:{dataset},querySelector:selector=>selector==='.signal-wings'?svg:product},
    window:{dispatchEvent:event=>events.push(event.type)},cancelAnimationFrame(){},
    ResizeObserver:class{constructor(callback){onResize=callback}observe(){}},
  })
  await vm.runInContext(`(async()=>{${entry}})()`,context)
  assert.equal(dataset.heroEntry,'complete')
  assert.equal(dataset.ribbonPaint,'ready')
  assert.equal(dataset.heroStatic,search==='?static=1'?'true':undefined)
  assert.deepEqual(events,['hero-entry-complete'])
  for(viewport of [2560,1728,1280]){
    onResize()
    const g=ribbonGeometry(viewport,Math.min(viewport*.76,1200))
    assert.equal(path.attributes.d,ribbonPath('M0 0 800 325 0 130Z',g))
    assert.equal(svg.attributes.viewBox,`0 0 ${g.width} ${g.height}`)
    assert.equal(mirror.attributes.transform,`translate(${g.width} 0) scale(-1 1)`)
  }
}

// Static captures must not restart the decorative motion after entry completes.
vm.runInNewContext(ribbons,{
  document:{documentElement:{dataset:{heroEntry:'complete',heroStatic:'true'}},querySelector:()=>({}),addEventListener(){}},
  matchMedia:()=>({matches:false,addEventListener(){}}),
  window:{addEventListener(){}},
  IntersectionObserver:class{constructor(callback){callback([{isIntersecting:true}])}observe(){}},
})
console.log('Static preview and reduced motion settle entry without starting ribbon animations.')

// Exercise the real entry clock and cleanup without a browser or native app.
for(const width of [390,1280,1728,2560]){
  const dataset={heroEntry:'pending'},animations=[],listeners=[],events=[],materials=[],created=[],windowListeners=new Map()
  let draw,onResize,viewport=width
  const node=attributes=>({attributes,getAttribute(name){return this.attributes[name]},setAttribute(name,value){this.attributes[name]=value},
    removeAttribute(name){delete this.attributes[name]},append(...children){this.children=children},after(){},remove(){this.removed=true},cloneNode(){const copy=node({...this.attributes});materials.push(copy);return copy},
    animate(frames,options){let finish;const animation={frames,currentTime:0,options,finished:new Promise(resolve=>finish=resolve),finish:()=>finish(),cancel(){}};animations.push(animation);return animation}})
  const bands=Array.from({length:5},(_,i)=>{
    const d=`M0 ${i*130} 800 325 0 ${(i+1)*130}Z`
    const paths=[node({d}),node({d,fill:'url(#ribbon-surface)'})]
    return {paths,querySelectorAll:()=>paths}
  })
  const seams=Array.from({length:4},(_,i)=>node({d:`M0 ${(i+1)*130} 800 325`}))
  const paths=[...bands.flatMap(band=>band.paths),...seams],originals=paths.map(path=>path.attributes.d)
  const appWidth=()=>viewport<=760?viewport-40:Math.min(viewport*.76,1200)
  const appHeight=()=>viewport<=760?532:appWidth()*.608
  const ribbonHeight=()=>viewport<=760?532:Math.min(viewport,1728)*.4256
  const product={...node({}),dataset:{live:width===1280?'false':'true'},getBoundingClientRect:()=>({left:(viewport-appWidth())/2,top:120,right:(viewport+appWidth())/2,bottom:120+appHeight(),width:appWidth(),height:appHeight()})}
  const defs=node({})
  const svg={...node({}),getBoundingClientRect:()=>({left:0,top:100,width:viewport,height:ribbonHeight()}),
    querySelectorAll:selector=>selector==='defs path'?paths:selector==='[data-ribbon-band]'?bands:[],
    querySelector:selector=>selector==='defs'?defs:selector.startsWith('#ribbon-seam-')?seams[Number(selector.at(-1))-1]:node({})}
  const reduced={matches:false,addEventListener:(_name,callback)=>listeners.push(callback)}
  const execution=vm.runInNewContext(`(async()=>{${entry}})()`,{
    URLSearchParams,Event,location:{search:''},ribbonGeometry,ribbonPath,
    matchMedia:query=>query.includes('reduce')?reduced:{matches:width>760,addEventListener(){}},
    getComputedStyle:()=>({borderTopLeftRadius:'14px'}),
    document:{documentElement:{dataset},createElementNS(_ns,tag){const element=node({});element.tag=tag;created.push(element);return element},querySelector:selector=>selector==='.signal-wings'?svg:selector==='.product-window'?product:node({})},
    window:{dispatchEvent:event=>events.push(event.type),addEventListener:(name,callback)=>windowListeners.set(name,callback)},
    ResizeObserver:class{constructor(callback){onResize=callback}observe(){}},
    requestAnimationFrame:callback=>{draw=callback;return 1},cancelAnimationFrame(){draw=null},
  })
  if(width===1280){
    assert.equal(draw,undefined,'no ribbon drawing before the renderer is ready')
    assert.equal(animations.length,4,'only copy enters while the app loads')
    windowListeners.get('hero-renderer-ready')()
  }
  await execution
  const clock=animations.at(-2),completionClock=animations.at(-1)
  const cover=created.find(element=>element.tag==='path')
  assert.equal(svg.attributes['clip-path'],'url(#ribbon-window-cover)')
  function checkCover(){
    const p=product.getBoundingClientRect()
    assert(cover.attributes.d.startsWith(`M-2 -2H${viewport+2}V${ribbonHeight()+2}`),'root clipping uses viewport pixels on phone and desktop')
    const xs=[],ys=[]
    for(const [,command,values] of ('M'+cover.attributes.d.split('Z M')[1]).matchAll(/([MHVQ])([^MHVQZ]+)/g)){
      const n=values.match(/-?\d*\.?\d+/g).map(Number)
      if(command==='H')xs.push(n[0])
      else if(command==='V')ys.push(n[0])
      else for(let i=0;i<n.length;i+=2){xs.push(n[i]);ys.push(n[i+1])}
    }
    assert.equal(Math.min(...xs),p.left+1,'cutout stays inside the left border')
    assert.equal(Math.max(...xs),p.right-1,'cutout stays inside the right border')
    assert.equal(Math.min(...ys),p.top-100+1,'cutout stays inside the top border')
    assert.equal(Math.max(...ys),p.bottom-100-1,'cutout stays inside the bottom border')
    assert.equal((cover.attributes.d.match(/Q/g)||[]).length,4,'all corners follow the window')
  }
  checkCover()
  const fade=animations.find(animation=>animation.frames[0]?.opacity===0&&!('transform' in animation.frames[0]))
  const movement=animations.find(animation=>animation.frames[0]?.transform==='translateY(20px)')
  assert.equal(fade.options.duration,300)
  assert.equal(movement.options.duration,600,'the window keeps its original settling motion')
  assert.equal(fade.options.delay,270)
  assert.equal(clock.options.duration,270+4*55+350,'ribbons keep their duration and stagger')
  assert.equal(completionClock.options.duration,570+4*55+350,'the app demo starts on its existing schedule')
  clock.currentTime=fade.options.delay-1;draw();assert.equal(dataset.ribbonPaint,'waiting')
  clock.currentTime=fade.options.delay;draw();assert.equal(dataset.ribbonPaint,'ready')
  clock.currentTime=400;draw()
  assert.notEqual(paths[0].attributes.d,ribbonPath(originals[0],ribbonGeometry(viewport,appWidth())))
  viewport=width===2560?1280:2560;onResize();draw();checkCover()
  if(width===2560){
    reduced.matches=true;listeners.forEach(callback=>callback({matches:true}))
  }else{
    clock.currentTime=1140;draw();animations.forEach(animation=>animation.finish())
    await new Promise(resolve=>setImmediate(resolve))
  }
  assert.equal(dataset.heroEntry,'complete')
  assert.deepEqual(events,['hero-entry-complete'])
  paths.forEach((path,i)=>assert.equal(path.attributes.d,ribbonPath(originals[i],ribbonGeometry(viewport,appWidth()))))
  assert.equal(svg.attributes['clip-path'],undefined,'temporary clip is removed')
  assert(created.find(element=>element.tag==='clipPath').removed,'clip definition is removed')
  assert(materials.every(material=>material.removed),'temporary entry gradients are removed')
  bands.forEach(band=>assert.equal(band.paths[1].attributes.fill,'url(#ribbon-surface)'))
}
console.log('Entry clock, live resize, reduced-motion interruption and final curved geometry cleanup passed.')
