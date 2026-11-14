import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'

const script=readFileSync(new URL('../public/marketing/ribbons.mjs',import.meta.url),'utf8')
for(const mode of ['normal','reduced','static','unsupported']){
  const animations=[],listeners={},media={matches:mode==='reduced',addEventListener:(_type,fn)=>listeners.motion=fn}
  let tick
  const node=name=>({name,dataset:{},animate(frames,options){
    const animation={name,frames,options,currentTime:0,pause(){this.paused=true},play(){this.paused=false}}
    animations.push(animation);return animation
  }})
  const headline=node('headline'),button=node('download'),svg={...node('svg'),parentElement:node('sway'),querySelector:node}
  const document={documentElement:{dataset:{heroEntry:'complete',heroStatic:mode==='static'?'true':undefined}},hidden:false,
    querySelector:selector=>selector==='.signal-wings'?svg:headline,querySelectorAll:()=>[button],addEventListener:(_type,fn)=>listeners.visibility=fn}
  vm.runInNewContext(script,{
    document,window:{addEventListener(){}},matchMedia:()=>media,CSS:{supports:()=>mode!=='unsupported'},
    IntersectionObserver:class{constructor(callback){this.callback=callback}observe(){this.callback([{isIntersecting:true}])}},
    setInterval:fn=>{tick=fn;return 1},clearInterval:()=>{tick=undefined},
  })
  if(mode==='static'||mode==='reduced'){assert.equal(animations.length,0);continue}
  const text=animations.find(animation=>animation.name==='headline'),download=animations.find(animation=>animation.name==='download'),sway=animations.at(-1)
  if(mode==='unsupported')assert.equal(text,undefined)
  for(const animation of [download,text].filter(Boolean)){
    assert.equal(animation.options.duration,24000)
    assert.equal(animation.options.iterations,Infinity)
    assert.deepEqual(Array.from(animation.frames,frame=>frame.backgroundPosition),['0% 50%','50% 50%','100% 50%','50% 50%','0% 50%'])
  }
  const stops=animations.slice(0,3)
  assert(stops.every(animation=>animation.frames.every(frame=>['var(--ai-base)','var(--ai-highlight)'].includes(frame.stopColor))))
  assert.deepEqual([0,1,2,3,4].map(phase=>stops.findIndex(animation=>animation.frames[phase].stopColor==='var(--ai-highlight)')),[2,1,0,1,2])
  sway.currentTime=6000;tick();assert(animations.every(animation=>animation.currentTime===6000))
  document.hidden=true;listeners.visibility();assert(sway.paused);assert.equal(tick,undefined)
  document.hidden=false;listeners.visibility();assert(!sway.paused)
  media.matches=true;listeners.motion();assert(animations.every(animation=>animation.currentTime===0));assert(sway.paused)
}

const css=readFileSync(new URL('../public/marketing/headline.css',import.meta.url),'utf8')
const html=readFileSync(new URL('../content/home.html',import.meta.url),'utf8')
assert(html.includes('href="/marketing/headline.css"'))
assert(css.includes('--ai-base:#6F00FF'))
assert(css.includes('--ai-highlight:#8B5CF6'))
assert.equal((css.match(/--ai-highlight:/g)||[]).length,1,'both themes share the saturated highlight')
assert(css.includes('--download-gradient-strength:1'))
assert(css.includes('calc(100% - 80% * var(--download-gradient-strength))'))
assert(css.includes('--ai-action-highlight:color-mix(in srgb,var(--ai-base) 20%,var(--ai-highlight))'))
assert(css.includes('--ai-text-base:color-mix(in srgb,var(--ai-base) 40%,var(--ai-highlight))'))
assert.equal((css.match(/linear-gradient\(110deg in srgb/g)||[]).length,2)
assert(css.includes('.hero-actions .button.primary:hover{background:var(--purple-dark)}'))
const rgb=hex=>hex.match(/[\da-f]{2}/gi).map(value=>parseInt(value,16))
const mix=(a,b,p)=>a.map((value,i)=>value*p+b[i]*(1-p))
const luminance=channels=>channels.map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,i)=>sum+value*[.2126,.7152,.0722][i],0)
const base=rgb('6F00FF'),white=rgb('FFFFFF')
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05)
for(const theme of ['light','dark']){
  const highlight=rgb('8B5CF6')
  const textBase=theme==='light'?base:mix(base,highlight,.4),bg=theme==='light'?white:rgb('1B1B1D')
  let buttonMinimum=Infinity,textMinimum=Infinity
  for(let strength=0;strength<=100;strength++)for(let position=0;position<=100;position++){
    const peak=mix(base,highlight,1-.8*strength/100)
    if(strength===0)assert.deepEqual(peak,base)
    buttonMinimum=Math.min(buttonMinimum,contrast(white,mix(base,peak,position/100)))
    textMinimum=Math.min(textMinimum,contrast(bg,mix(textBase,mix(base,highlight,.2),position/100)))
  }
  assert(buttonMinimum>=4.5,'white button text meets contrast across the full sweep and strength range')
  assert(textMinimum>=3,'headline meets large-text contrast across the full sweep')
  console.log(`${theme}: button minimum ${buttonMinimum.toFixed(2)}:1; headline minimum ${textMinimum.toFixed(2)}:1`)
}
assert(contrast(white,rgb('6200E0'))>=4.5,'unchanged hover remains readable')
console.log('Headline and download share the ribbon clock and palette; strength, static/reduced motion and hidden-page pause passed.')
