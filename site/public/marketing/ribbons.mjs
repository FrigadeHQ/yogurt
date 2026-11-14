const svg=document.querySelector('.signal-wings');
const reduce=matchMedia('(prefers-reduced-motion: reduce)');
const animations=[];
let visible=false,timer;
const easing='cubic-bezier(.45,0,.55,1)';
function animate(element,frames,name){
  const animation=element.animate(frames.map(frame=>({...frame,easing})),{duration:24000,iterations:Infinity});
  animation.id='ribbon-life-'+name;animation.pause();animations.push(animation);
}
function start(){
  const base='var(--ai-base)',highlight='var(--ai-highlight)';
  const sweeps=[
    [base,base,highlight,base,base],
    [base,highlight,base,highlight,base],
    [highlight,base,base,base,highlight],
  ];
  sweeps.forEach((colors,index)=>animate(svg.querySelector(`#ribbon-purple stop:nth-child(${index+1})`),colors.map(stopColor=>({stopColor})),'color-'+index));
  const drift=[0,50,100,50,0].map(position=>({backgroundPosition:`${position}% 50%`}));
  const headline=document.querySelector('.headline-word');
  if(headline&&CSS.supports('background-clip','text'))animate(headline,drift,'headline');
  document.querySelectorAll('.hero-actions .button.primary').forEach((button,index)=>animate(button,drift,'download-'+index));
  animate(svg.parentElement,['0px','var(--ribbon-sway)','0px','calc(-1 * var(--ribbon-sway))','0px'].map(y=>({transform:`translateY(${y})`})),'sway');
}
function sync(){
  if(document.documentElement.dataset.heroEntry!=='complete'||document.documentElement.dataset.heroStatic==='true')return;
  if(!animations.length&&!reduce.matches)start();
  const running=visible&&!document.hidden&&!reduce.matches;
  svg.dataset.running=String(running);
  clearInterval(timer);
  const sway=animations.at(-1);
  if(reduce.matches)animations.forEach(animation=>animation.currentTime=0);
  if(running){
    sway.play();
    // Slow colour travel needs ten paints a second; the sway stays compositor-smooth.
    timer=setInterval(()=>animations.slice(0,-1).forEach(animation=>animation.currentTime=sway.currentTime),100);
  }else sway?.pause();
}
new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;sync()}).observe(svg);
window.addEventListener('hero-entry-complete',sync);
document.addEventListener('visibilitychange',sync);
reduce.addEventListener('change',sync);
sync();
