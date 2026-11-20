const root=document.documentElement;
const toggle=document.querySelector('.theme-toggle');
const systemTheme=matchMedia('(prefers-color-scheme: dark)');
let preference;
try{const saved=localStorage.getItem('yogurt-theme');if(saved==='light'||saved==='dark')preference=saved}catch{}

export function syncFrameTheme(frame){
  const frameRoot=frame.contentDocument?.documentElement;
  if(!frameRoot)return;
  const theme=root.dataset.theme;
  frameRoot.dataset.marketingTheme=theme;
  frameRoot.style.colorScheme=theme;
  if(frame.classList.contains('hero-renderer')){
    for(const node of frame.contentDocument.querySelectorAll('body, #root'))node.style.colorScheme=theme;
  }
}

function render(){
  const dark=root.dataset.theme==='dark';
  toggle.setAttribute('aria-label',dark?'Switch to light mode':'Switch to dark mode');
  toggle.setAttribute('aria-pressed',String(dark));
  document.querySelector('meta[name="theme-color"]').content=dark?'#1B1B1D':'#ffffff';
  document.querySelectorAll('.hero-renderer,.tour-frame iframe').forEach(syncFrameTheme);
}

toggle.addEventListener('click',()=>{
  root.classList.add('theme-switching');
  root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';
  preference=root.dataset.theme;
  try{localStorage.setItem('yogurt-theme',preference)}catch{}
  render();
  requestAnimationFrame(()=>requestAnimationFrame(()=>root.classList.remove('theme-switching')));
});
function followSystem(){
  if(preference)return;
  root.dataset.theme=systemTheme.matches?'dark':'light';
  render();
}
systemTheme.addEventListener('change',followSystem);
followSystem();
render();
toggle.hidden=false;
