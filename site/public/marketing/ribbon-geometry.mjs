export function ribbonGeometry(width,appWidth){
  const curved=width>1728
  return {curved,width:curved?width:1600,height:curved?1728*.4256:650,
    gap:(width-appWidth)/2,baselineGap:(1728-appWidth)/2,
    attachment:appWidth/Math.min(width,1728),covered:appWidth/width}
}

const mix=(a,b,t)=>a.map((value,i)=>value+(b[i]-value)*t)

export function ribbonPath(original,g,progress=1){
  if(!g.curved&&progress>=1)return original
  const points=original.match(/-?\d*\.?\d+/g).map(Number)
  if(!g.curved){
    const outer=y=>`${800*(1-progress)} ${325+(y-325)*progress}`
    return original.endsWith('Z')?`M${outer(points[1])} 800 325 ${outer(points[5])}Z`:`M${outer(points[1])} 800 325`
  }
  // Keep the remaining part of the exact cubic, so the edge grows without changing shape.
  const t=Math.max(0,Math.min(1,(1-progress)/(1-g.covered)))
  const edge=value=>{
    const y=value/650*g.height,anchor=g.height/2+(y-g.height/2)*g.attachment
    const p0=[0,y],p1=[g.gap*.55,y],p2=[g.gap-g.baselineGap*.5,anchor-(anchor-y)*.5],p3=[g.gap,anchor]
    const a=mix(p0,p1,t),b=mix(p1,p2,t),c=mix(p2,p3,t)
    const d=mix(a,b,t),e=mix(b,c,t)
    return [mix(d,e,t),e,c,p3]
  }
  const top=edge(points[1]),point=p=>p.join(' ')
  let path=`M${point(top[0])} C${top.slice(1).map(point).join(' ')} L${g.width/2} ${g.height/2}`
  if(original.endsWith('Z')){
    const bottom=edge(points[5])
    path+=` L${point(bottom[3])} C${bottom.slice(0,3).reverse().map(point).join(' ')}Z`
  }
  return path
}
