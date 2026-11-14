import {ribbonGeometry,ribbonPath} from './ribbon-geometry.mjs';
const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)');
const state=document.documentElement.dataset;
if(new URLSearchParams(location.search).get('static')==='1')state.heroStatic='true';
const animations=[],restore=[];
let completed=false,frame;
const svg=document.querySelector('.signal-wings'),product=document.querySelector('.product-window');
const geometry=[...svg.querySelectorAll('defs path')].map(path=>({path,d:path.getAttribute('d'),progress:1}));
const mirrors=[...svg.querySelectorAll('use[transform]')],materials=[];
let shape,coveredLength;
function paintRibbons(){
  geometry.forEach(({path,d,progress})=>path.setAttribute('d',ribbonPath(d,shape,progress)));
}
function layoutRibbons(){
  const windowBounds=product.getBoundingClientRect(),ribbonBounds=svg.getBoundingClientRect();
  shape=ribbonGeometry(ribbonBounds.width,windowBounds.width);
  svg.setAttribute('viewBox',`0 0 ${shape.width} ${shape.height}`);
  mirrors.forEach(use=>use.setAttribute('transform',`translate(${shape.width} 0) scale(-1 1)`));
  const gradient=svg.querySelector('#ribbon-purple');
  gradient.setAttribute('x2',shape.width/2);gradient.setAttribute('y2',shape.height/2);
  svg.querySelector('.signal-reflection').setAttribute('height',shape.height);
  materials.forEach(({material,ys})=>{
    material.setAttribute('y1',Math.min(...ys)*shape.height/650);
    material.setAttribute('y2',Math.max(...ys)*shape.height/650);
  });
  // Start inside the opaque window, including when a resize changes the curve during entry.
  coveredLength=Math.max(0,Math.min(1,(windowBounds.width-4)/ribbonBounds.width,(windowBounds.height-4)/ribbonBounds.height));
  paintRibbons();
}
const resize=new ResizeObserver(layoutRibbons);
resize.observe(svg);resize.observe(product);layoutRibbons();
function complete(){
  if(completed) return;
  completed=true;
  cancelAnimationFrame(frame);
  restore.forEach(reset=>reset());
  geometry.forEach(part=>part.progress=1);materials.length=0;paintRibbons();
  state.ribbonPaint='ready';
  state.heroEntry='complete';
  window.dispatchEvent(new Event('hero-entry-complete'));
}
if(reduceMotion.matches||state.heroStatic==='true') complete();
else{
  state.heroEntry='running';
  const copyEase='cubic-bezier(.23,1,.32,1)';
  for(const [selector,delay] of [['.yc-pill',0],['.hero-copy h1',70],['.hero-copy p',140],['.hero-actions',210]]){
    animations.push(document.querySelector(selector).animate([
      {opacity:0,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'},
    ],{duration:500,delay,easing:copyEase,fill:'backwards'}));
  }
  const desktop=matchMedia('(min-width:761px)');
  if(desktop.matches && product.dataset.live!=='true') {
    await new Promise(resolve=>{
      window.addEventListener('hero-renderer-ready',resolve,{once:true});
      reduceMotion.addEventListener('change',event=>{if(event.matches){animations.forEach(animation=>animation.cancel());resolve()}},{once:true});
      desktop.addEventListener('change',event=>{if(!event.matches)resolve()},{once:true});
    });
  }
  if(reduceMotion.matches) complete();
  else {
  const windowDelay=Math.max(0,270-Number(animations[0].currentTime||0)),fadeDuration=300;
  // The window becomes opaque before it settles, hiding the wings' starting points.
  animations.push(product.animate([{opacity:0},{opacity:1}],
    {duration:fadeDuration,delay:windowDelay,easing:'cubic-bezier(.16,1,.3,1)',fill:'backwards'}));
  animations.push(product.animate([{transform:'translateY(20px)'},{transform:'translateY(0)'}],
    {duration:600,delay:windowDelay,easing:'cubic-bezier(.16,1,.3,1)',fill:'backwards'}));
  const background='ribbon';
  if(background==='ribbon'){
    const surface=svg.querySelector('#ribbon-surface');
    const ribbonStart=windowDelay+fadeDuration,bandDuration=350,bandStagger=55;
    const bands=[...svg.querySelectorAll('[data-ribbon-band]')].map((band,index)=>{
      const paths=[...band.querySelectorAll('path')];
      const seam=svg.querySelector(`#ribbon-seam-${index+1}`);
      if(seam) paths.push(seam);
      const bandGeometry=geometry.filter(part=>paths.includes(part.path));
      // Keep the original material in fixed SVG coordinates as the path grows.
      // Object-bounding-box gradients would otherwise travel with the end cap.
      const material=surface.cloneNode(true),paint=paths[1];
      const ys=[index*130,(index+1)*130,325];
      material.id=`ribbon-entry-surface-${index}`;
      material.setAttribute('gradientUnits','userSpaceOnUse');
      material.setAttribute('y1',Math.min(...ys)*shape.height/650);
      material.setAttribute('y2',Math.max(...ys)*shape.height/650);
      materials.push({material,ys});
      surface.after(material);
      paint.setAttribute('fill',`url(#${material.id})`);
      restore.push(()=>{paint.setAttribute('fill','url(#ribbon-surface)');material.remove()});
      bandGeometry.forEach(part=>part.progress=coveredLength);
      return bandGeometry;
    });
    paintRibbons();
    // A seekable clock drives d attributes, not a transform or clipping wipe.
    // It starts only after the live window has painted.
    const clock=svg.animate([],{duration:ribbonStart+4*bandStagger+bandDuration,fill:'backwards'});
    animations.push(clock);
    function draw(){
      const time=Number(clock.currentTime)||0;
      state.ribbonPaint=time>=ribbonStart?'ready':'waiting';
      bands.forEach((geometry,index)=>{
        const progress=Math.max(0,Math.min(1,(time-ribbonStart-index*bandStagger)/bandDuration));
        // A short ease-out carries the visible end cap to the page edge.
        const length=coveredLength+(1-coveredLength)*(1-(1-progress)**3);
        geometry.forEach(part=>part.progress=length);
      });
      paintRibbons();
      if(!completed) frame=requestAnimationFrame(draw);
    }
    frame=requestAnimationFrame(draw);
  }
  Promise.all(animations.map(animation=>animation.finished)).then(complete).catch(()=>{});
  reduceMotion.addEventListener('change',event=>{
    if(!event.matches) return;
    animations.forEach(animation=>animation.cancel());
    complete();
  });
  }
}
