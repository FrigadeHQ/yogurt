import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {ribbonGeometry,ribbonPath} from '../public/marketing/ribbon-geometry.mjs'

const html=readFileSync(new URL('../content/home.html',import.meta.url),'utf8')
const originals=[...html.matchAll(/d="(M0 [\d.]+ 800 325(?: 0 [\d.]+Z)?)"/g)].map(match=>match[1])
assert(originals.length>50,'exercise the real fills, seams and fine stripes')
const numbers=path=>path.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/g).map(Number)
const near=(a,b)=>assert(Math.abs(a-b)<1e-8,`${a} differs from ${b}`)
const cubic=(points,t)=>[0,1].map(axis=>(1-t)**3*points[0][axis]+3*(1-t)**2*t*points[1][axis]+3*(1-t)*t*t*points[2][axis]+t**3*points[3][axis])
const curve=values=>Array.from({length:4},(_,i)=>values.slice(i*2,i*2+2))

for(const width of [375,760,1280,1728,1729,2560,3840]){
  const appWidth=width<=760?width-40:Math.min(width*.76,1200)
  const g=ribbonGeometry(width,appWidth)
  for(const original of originals){
    const full=ribbonPath(original,g),fullPoints=numbers(full)
    if(width<=1728)assert.equal(full,original,'preserve the approved laptop SVG exactly')
    let lastX=Infinity
    for(let step=0;step<=40;step++){
      const progress=g.covered+(1-g.covered)*step/40
      const path=ribbonPath(original,g,progress),points=numbers(path)
      assert.equal(path.endsWith('Z'),original.endsWith('Z'))
      assert(points.every(Number.isFinite))
      assert(points[0]<=lastX+1e-8,'end cap moves outward without reversing')
      lastX=points[0]
      if(g.curved){
        near(points[6],fullPoints[6]);near(points[7],fullPoints[7])
        const t=(1-progress)/(1-g.covered)
        for(const u of [0,.25,.5,.75,1]){
          const actual=cubic(curve(points),u),expected=cubic(curve(fullPoints),t+(1-t)*u)
          actual.forEach((value,i)=>near(value,expected[i]))
        }
      }
    }
  }
  if(width>=1000){
    const artHeight=Math.min(width,1728)*.4256,appHeight=appWidth*.608
    near(artHeight*appWidth/Math.min(width,1728),appHeight*.7)
    assert((artHeight-appHeight)/2+6<38,'top tip and sway stay below the platform line')
    assert((artHeight-appHeight)/2+6<92,'bottom tip and sway fit before the next section')
  }
}
// Approved C control points at 2560px, copied from the reviewed comparison geometry.
const approved=[0,0,374,0,548,56.1792,680,112.3584,1280,367.7184]
numbers(ribbonPath('M0 0 800 325',ribbonGeometry(2560,1200))).forEach((value,i)=>near(value,approved[i]))
console.log('Approved C geometry, all band edges, monotonic entry and exact cubic trimming passed at phone, laptop and wide widths.')
