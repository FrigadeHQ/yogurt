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
for(const width of [1280,1728,2560]){
  const dataset={heroEntry:'pending'},animations=[],listeners=[],events=[],materials=[]
  let draw,onResize,viewport=width
  const node=attributes=>({attributes,getAttribute(name){return this.attributes[name]},setAttribute(name,value){this.attributes[name]=value},
    after(){},remove(){this.removed=true},cloneNode(){const copy=node({...this.attributes});materials.push(copy);return copy},
    animate(frames,options){let finish;const animation={frames,currentTime:0,options,finished:new Promise(resolve=>finish=resolve),finish:()=>finish(),cancel(){}};animations.push(animation);return animation}})
  const bands=Array.from({length:5},(_,i)=>{
    const d=`M0 ${i*130} 800 325 0 ${(i+1)*130}Z`
    const paths=[node({d}),node({d,fill:'url(#ribbon-surface)'})]
    return {paths,querySelectorAll:()=>paths}
  })
  const seams=Array.from({length:4},(_,i)=>node({d:`M0 ${(i+1)*130} 800 325`}))
  const paths=[...bands.flatMap(band=>band.paths),...seams],originals=paths.map(path=>path.attributes.d)
  const product={...node({}),dataset:{live:'true'},getBoundingClientRect:()=>({width:Math.min(viewport*.76,1200),height:Math.min(viewport*.76,1200)*.608})}
  const svg={...node({}),getBoundingClientRect:()=>({width:viewport,height:Math.min(viewport,1728)*.4256}),
    querySelectorAll:selector=>selector==='defs path'?paths:selector==='[data-ribbon-band]'?bands:[],
    querySelector:selector=>selector.startsWith('#ribbon-seam-')?seams[Number(selector.at(-1))-1]:node({})}
  const reduced={matches:false,addEventListener:(_name,callback)=>listeners.push(callback)}
  await vm.runInNewContext(`(async()=>{${entry}})()`,{
    URLSearchParams,Event,location:{search:''},ribbonGeometry,ribbonPath,
    matchMedia:query=>query.includes('reduce')?reduced:{matches:true},
    document:{documentElement:{dataset},querySelector:selector=>selector==='.signal-wings'?svg:selector==='.product-window'?product:node({})},
    window:{dispatchEvent:event=>events.push(event.type)},
    ResizeObserver:class{constructor(callback){onResize=callback}observe(){}},
    requestAnimationFrame:callback=>{draw=callback;return 1},cancelAnimationFrame(){draw=null},
  })
  const clock=animations.at(-1)
  const fade=animations.find(animation=>animation.frames[0]?.opacity===0&&!('transform' in animation.frames[0]))
  const movement=animations.find(animation=>animation.frames[0]?.transform==='translateY(20px)')
  assert.equal(fade.options.duration,300)
  assert.equal(movement.options.duration,600,'the window keeps its original settling motion')
  assert.equal(fade.options.delay,270)
  assert.equal(clock.options.duration,570+4*55+350,'keep the draw duration and band stagger')
  clock.currentTime=569;draw();assert.equal(dataset.ribbonPaint,'waiting')
  clock.currentTime=fade.options.delay+fade.options.duration;draw();assert.equal(dataset.ribbonPaint,'ready')
  clock.currentTime=700;draw()
  assert.notEqual(paths[0].attributes.d,ribbonPath(originals[0],ribbonGeometry(viewport,Math.min(viewport*.76,1200))))
  viewport=width===2560?1280:2560;onResize();draw()
  if(width===2560){
    reduced.matches=true;listeners.forEach(callback=>callback({matches:true}))
  }else{
    clock.currentTime=1140;draw();animations.forEach(animation=>animation.finish())
    await new Promise(resolve=>setImmediate(resolve))
  }
  assert.equal(dataset.heroEntry,'complete')
  assert.deepEqual(events,['hero-entry-complete'])
  paths.forEach((path,i)=>assert.equal(path.attributes.d,ribbonPath(originals[i],ribbonGeometry(viewport,Math.min(viewport*.76,1200)))))
  assert(materials.every(material=>material.removed),'temporary entry gradients are removed')
  bands.forEach(band=>assert.equal(band.paths[1].attributes.fill,'url(#ribbon-surface)'))
}
console.log('Entry clock, live resize, reduced-motion interruption and final curved geometry cleanup passed.')
