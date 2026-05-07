import{u as G}from"./uplot-XSTvrsZP.js";(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const a of document.querySelectorAll('link[rel="modulepreload"]'))s(a);new MutationObserver(a=>{for(const n of a)if(n.type==="childList")for(const r of n.addedNodes)r.tagName==="LINK"&&r.rel==="modulepreload"&&s(r)}).observe(document,{childList:!0,subtree:!0});function e(a){const n={};return a.integrity&&(n.integrity=a.integrity),a.referrerPolicy&&(n.referrerPolicy=a.referrerPolicy),a.crossOrigin==="use-credentials"?n.credentials="include":a.crossOrigin==="anonymous"?n.credentials="omit":n.credentials="same-origin",n}function s(a){if(a.ep)return;a.ep=!0;const n=e(a);fetch(a.href,n)}})();const y=[{id:"hanta-andes",label:"Andes Hantavirus",blurb:"Rare person-to-person transmission via prolonged close contact. Long incubation (9–40 days). High fatality.",genes:{attackRate:.45,incubation:18,infectious:3,ifr:.32,range:2,immunityDays:3650,mutationRate:.005}},{id:"sars2-wild",label:"SARS-2: Wild-Type",blurb:"The original lineage. Reinfection within months.",genes:{attackRate:.12,incubation:6,infectious:4,ifr:.01,range:1,immunityDays:180,mutationRate:.01}},{id:"sars2-delta",label:"SARS-2: Delta",blurb:"Higher transmission, longer range. ~6-month immunity.",genes:{attackRate:.1,incubation:2,infectious:4,ifr:.03,range:2,immunityDays:180,mutationRate:.01}},{id:"sars2-delta-plus",label:"SARS-2: Delta+",blurb:"Higher attack rate. Reinfection within 3 months.",genes:{attackRate:.17,incubation:2,infectious:4,ifr:.03,range:2,immunityDays:90,mutationRate:.01}},{id:"sars1",label:"SARS-1",blurb:"2003 outbreak. Higher IFR, ~2-year immunity.",genes:{attackRate:.18,incubation:7,infectious:4,ifr:.11,range:1,immunityDays:700,mutationRate:.005}},{id:"measles",label:"Measles",blurb:"Airborne, extreme range. Lifelong immunity.",genes:{attackRate:.13,incubation:14,infectious:5,ifr:.001,range:4,immunityDays:36500,mutationRate:.002}},{id:"tb",label:"Tuberculosis",blurb:"Slow burn. Latent reactivation. ~10-year immunity.",genes:{attackRate:.47,incubation:60,infectious:14,ifr:.08,range:2,immunityDays:3650,mutationRate:.003}},{id:"syphilis",label:"Syphilis",blurb:"Contact-bound. Reinfection possible after treatment.",genes:{attackRate:.16,incubation:20,infectious:13,ifr:.08,range:1,immunityDays:365,mutationRate:.002}},{id:"nipah",label:"Nipah",blurb:"Rare zoonotic. High IFR, ~5-year immunity.",genes:{attackRate:.02,incubation:11,infectious:6,ifr:.75,range:1,immunityDays:1825,mutationRate:.005}},{id:"omega",label:"Omega Virus",blurb:"Hypothetical worst-case. Endless reinfection (~30 day immunity).",genes:{attackRate:.9,incubation:14,infectious:21,ifr:.8,range:5,immunityDays:30,mutationRate:.05}}],A="hanta-andes";function N(i){return y.find(t=>t.id===i)??y.find(t=>t.id===A)}var h=(i=>(i[i.Susceptible=0]="Susceptible",i[i.Exposed=1]="Exposed",i[i.Infectious=2]="Infectious",i[i.Recovered=3]="Recovered",i[i.Dead=4]="Dead",i))(h||{});const k="./assets/CellSprites",J={[h.Susceptible]:`${k}/person.svg`,[h.Exposed]:`${k}/personExposed.svg`,[h.Infectious]:`${k}/personInfectious.svg`,[h.Recovered]:`${k}/zombie.svg`,[h.Dead]:`${k}/headstone.svg`},Y=`${k}/defenses/maskSurgical.svg`,X=`${k}/defenses/syringe.svg`,L=5,E=4;class Q{canvas;ctx;tile=0;ready;images=null;constructor(){this.canvas=Z()?new OffscreenCanvas(1,1):Object.assign(document.createElement("canvas"),{width:1,height:1}),this.ctx=this.canvas.getContext("2d"),this.ready=this.preload()}whenReady(){return this.ready}setTile(t){t!==this.tile&&(this.tile=t,this.canvas.width=t*E,this.canvas.height=t*L,this.rasterize())}draw(t,e,s,a,n,r,l){if(!this.tile)return;const o=Math.min(e,L-1),c=Math.min(s&3,E-1),d=1.7,u=r*d,B=l*d,j=a-(u-r)*.5,K=n-(B-l)*.65;t.drawImage(this.canvas,c*this.tile,o*this.tile,this.tile,this.tile,j,K,u,B)}async preload(){const t=await Promise.all([h.Susceptible,h.Exposed,h.Infectious,h.Recovered,h.Dead].map(a=>M(J[a]))),e=await M(Y),s=await M(X);this.images={state:t,mask:e,vax:s},this.tile>0&&this.rasterize()}rasterize(){if(!this.images||!this.tile)return;const t=this.ctx,e=this.tile;t.clearRect(0,0,this.canvas.width,this.canvas.height),t.imageSmoothingEnabled=!0,t.imageSmoothingQuality="high";for(let s=0;s<L;s++)for(let a=0;a<E;a++){const n=a*e,r=s*e;t.drawImage(this.images.state[s],n,r,e,e),s<=2&&(a&1&&t.drawImage(this.images.mask,n,r,e,e),a&2&&t.drawImage(this.images.vax,n+e*.55,r+e*.5,e*.45,e*.45))}}}function M(i){return new Promise((t,e)=>{const s=new Image;s.crossOrigin="anonymous",s.onload=()=>t(s),s.onerror=()=>e(new Error(`Failed to load ${i}`)),s.src=i})}function Z(){return typeof OffscreenCanvas<"u"}const tt=60;class et{canvas;ctx;overlay;legend;size=0;mode="pixel";imageData=null;palette=V();atlas=null;spriteReady=!1;constructor(t){t.classList.add("petri-host"),t.innerHTML=`
      <div class="petri-frame">
        <div class="petri-ring" aria-hidden="true"></div>
        <canvas class="petri-canvas" aria-label="Petri dish — population grid"></canvas>
        <div class="petri-overlay"></div>
      </div>
      <div class="petri-legend" data-petri-legend></div>
    `,this.canvas=t.querySelector("canvas"),this.overlay=t.querySelector(".petri-overlay"),this.legend=t.querySelector(".petri-legend");const e=this.canvas.getContext("2d",{alpha:!1});if(!e)throw new Error("Canvas 2D unavailable");this.ctx=e,this.refreshPalette(),this.renderLegend()}refreshPalette(){const t=getComputedStyle(document.documentElement),e=(a,n)=>{const r=t.getPropertyValue(a).trim();return st(r)??n},s=V();this.palette={s:e("--cell-s",s.s),s_mask:e("--cell-s-mask",s.s_mask),s_vax:e("--cell-s-vax",s.s_vax),s_both:e("--cell-s-both",s.s_both),e:e("--cell-e",s.e),i:e("--cell-i",s.i),r:e("--cell-r",s.r),d:e("--cell-d",s.d),bg:e("--petri-bg",s.bg),ringMask:e("--cell-ring-mask",s.ringMask),ringVax:e("--cell-ring-vax",s.ringVax)},this.renderLegend()}resize(t){if(t===this.size&&this.imageData)return;this.size=t;const e=t<=tt?"sprite":"pixel";if(e==="sprite"){const s=at(Math.round(900/t),24,80);this.atlas??=new Q,this.atlas.setTile(s),this.spriteReady=!1,this.atlas.whenReady().then(()=>{this.spriteReady=!0,this.atlas?.setTile(s)}),this.canvas.width=t*s,this.canvas.height=t*s,this.imageData=null}else{this.canvas.width=t,this.canvas.height=t,this.imageData=this.ctx.createImageData(t,t);const s=this.imageData.data;for(let a=3;a<s.length;a+=4)s[a]=255}this.mode=e,this.canvas.style.imageRendering=e==="pixel"?"pixelated":"auto",this.renderLegend()}paint(t,e,s){s!==this.size&&this.resize(s),this.mode==="sprite"?this.paintSprites(t,e,s):this.paintPixels(t,e,s)}paintPixels(t,e,s){this.imageData||this.resize(s);const a=this.imageData,n=a.data,r=this.palette,l=s*s;for(let o=0;o<l;o++){const c=e[o];let d;switch(t[o]){case h.Susceptible:d=(c&3)===3?r.s_both:c&1?r.s_mask:c&2?r.s_vax:r.s;break;case h.Exposed:d=r.e;break;case h.Infectious:d=r.i;break;case h.Recovered:d=r.r;break;case h.Dead:d=r.d;break;default:d=r.bg;break}const u=o*4;n[u]=d.r,n[u+1]=d.g,n[u+2]=d.b}this.ctx.putImageData(a,0,0)}paintSprites(t,e,s){const a=this.ctx,n=this.canvas.width/s,r=this.palette;if(a.fillStyle=`rgb(${r.bg.r},${r.bg.g},${r.bg.b})`,a.fillRect(0,0,this.canvas.width,this.canvas.height),!this.spriteReady||!this.atlas){for(let l=0;l<s;l++)for(let o=0;o<s;o++){const c=l*s+o,d=e[c];let u;switch(t[c]){case h.Susceptible:u=(d&3)===3?r.s_both:d&1?r.s_mask:d&2?r.s_vax:r.s;break;case h.Exposed:u=r.e;break;case h.Infectious:u=r.i;break;case h.Recovered:u=r.r;break;case h.Dead:u=r.d;break;default:u=r.bg;break}a.fillStyle=`rgb(${u.r},${u.g},${u.b})`,a.fillRect(o*n,l*n,n,n)}return}for(let l=0;l<s;l++)for(let o=0;o<s;o++){const c=l*s+o;this.atlas.draw(a,t[c],e[c],o*n,l*n,n,n)}}setOverlayMessage(t){this.overlay.innerHTML=t??"",this.overlay.style.display=t?"flex":"none"}toDataURL(){return this.canvas.toDataURL("image/png")}renderLegend(){this.legend&&(this.mode==="sprite"?this.renderSpriteLegend():this.renderColorLegend())}renderColorLegend(){const t=(e,s)=>`
      <span class="legend-item"><span class="legend-swatch" style="background: rgb(var(${e}));"></span>${s}</span>
    `;this.legend.innerHTML=[t("--cell-s","Susceptible"),t("--cell-s-mask","Masked"),t("--cell-s-vax","Vaccinated"),t("--cell-s-both","Both"),t("--cell-e","Exposed"),t("--cell-i","Infectious"),t("--cell-r","Recovered"),t("--cell-d","Dead")].join("")}renderSpriteLegend(){const t=(e,s,a)=>`
      <span class="legend-item">
        <span class="legend-sprite">
          <img src="./assets/CellSprites/${e}" alt="" />
          ${s?`<img class="legend-overlay" src="./assets/CellSprites/defenses/${s}" alt="" />`:""}
        </span>${a}
      </span>
    `;this.legend.innerHTML=[t("person.svg",null,"Susceptible"),t("person.svg","maskSurgical.svg","Masked"),t("person.svg","syringe.svg","Vaccinated"),t("personExposed.svg",null,"Exposed"),t("personInfectious.svg",null,"Infectious"),t("zombie.svg",null,"Recovered"),t("headstone.svg",null,"Dead")].join("")}}function V(){return{s:{r:122,g:173,b:35},s_mask:{r:38,g:169,b:198},s_vax:{r:156,g:89,b:209},s_both:{r:33,g:191,b:175},e:{r:230,g:167,b:23},i:{r:218,g:60,b:50},r:{r:70,g:110,b:145},d:{r:40,g:35,b:30},bg:{r:246,g:239,b:225},ringMask:{r:38,g:169,b:198},ringVax:{r:156,g:89,b:209}}}function st(i){if(!i)return null;const t=i.match(/^(\d+)\s+(\d+)\s+(\d+)/)||i.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)/);if(t)return{r:+t[1],g:+t[2],b:+t[3]};const e=i.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);return e?{r:parseInt(e[1],16),g:parseInt(e[2],16),b:parseInt(e[3],16)}:null}function at(i,t,e){const s=i|0;return s<t?t:s>e?e:s}class it{host;plot=null;resizeObs;lastW=0;lastH=0;resizeRaf=0;constructor(t){this.host=t,t.classList.add("chart-host"),this.resizeObs=new ResizeObserver(()=>{this.resizeRaf||(this.resizeRaf=requestAnimationFrame(()=>{this.resizeRaf=0,this.relayout()}))}),this.resizeObs.observe(t)}relayout(){if(!this.plot)return;const t=this.host.clientWidth,e=this.host.clientHeight;t===this.lastW&&e===this.lastH||(this.lastW=t,this.lastH=e,this.plot.setSize({width:t,height:e}))}update(t){if(t.tick.length===0){this.plot&&(this.plot.destroy(),this.plot=null,this.lastW=0,this.lastH=0),this.host.innerHTML='<div class="chart-empty">Waiting for first tick…</div>';return}const e=[Float64Array.from(t.tick),Float64Array.from(t.s),Float64Array.from(t.e),Float64Array.from(t.i),Float64Array.from(t.r),Float64Array.from(t.d)];if(this.plot)this.plot.setData(e);else{this.host.innerHTML="";const s=getComputedStyle(document.documentElement),a=r=>s.getPropertyValue(r).trim()||"#888",n={width:this.host.clientWidth,height:this.host.clientHeight,scales:{x:{time:!1}},axes:[{stroke:a("--text-muted"),grid:{stroke:a("--grid-color")}},{stroke:a("--text-muted"),grid:{stroke:a("--grid-color")}}],legend:{show:!0,live:!0},series:[{label:"Day"},{label:"Susceptible",stroke:C("--cell-s"),width:1.4},{label:"Exposed",stroke:C("--cell-e"),width:1.4},{label:"Infectious",stroke:C("--cell-i"),width:1.8},{label:"Recovered",stroke:C("--cell-r"),width:1.4},{label:"Dead",stroke:C("--cell-d"),width:1.4}]};this.plot=new G(n,e,this.host)}}exportCsv(t){const e=`tick,S,E,I,R,D,Reff
`,s=[];for(let a=0;a<t.tick.length;a++)s.push(`${t.tick[a]},${t.s[a]},${t.e[a]},${t.i[a]},${t.r[a]},${t.d[a]},${t.reff[a]?.toFixed(3)??""}`);return e+s.join(`
`)}destroy(){this.resizeObs.disconnect(),this.plot?.destroy(),this.plot=null}}function C(i){const t=getComputedStyle(document.documentElement).getPropertyValue(i).trim();return t?t.startsWith("#")||t.startsWith("rgb")?t:`rgb(${t})`:"#888"}class nt{el;items={};rNaughtVal;constructor(t){t.classList.add("stats-host"),t.innerHTML=`
      <div class="stat" data-key="day"><span class="stat-label">Day</span><span class="stat-value">0</span></div>
      <div class="stat" data-key="i"><span class="stat-label">Infectious</span><span class="stat-value">0%</span></div>
      <div class="stat" data-key="r"><span class="stat-label">Recovered</span><span class="stat-value">0%</span></div>
      <div class="stat" data-key="d"><span class="stat-label">Dead</span><span class="stat-value">0%</span></div>
      <div class="stat" data-key="reff"><span class="stat-label">R<sub>eff</sub></span><span class="stat-value">—</span></div>
      <div class="stat" data-key="r0"><span class="stat-label">R<sub>0</sub></span><span class="stat-value">—</span></div>
    `,this.el=t,t.querySelectorAll(".stat").forEach(e=>{const s=e.dataset.key;this.items[s]=e.querySelector(".stat-value")}),this.rNaughtVal=this.items.r0}setRNaught(t){this.rNaughtVal.textContent=t===null?"—":t.toFixed(1)}update(t,e){this.items.day.textContent=t.tick.toString(),this.items.i.textContent=I(t.i,e),this.items.r.textContent=I(t.r,e),this.items.d.textContent=I(t.d,e),this.items.reff.textContent=t.reff>0?t.reff.toFixed(2):"—"}hostElement(){return this.el}}function I(i,t){if(t<=0)return"0%";const e=i/t*100;return e<.1&&e>0?"<0.1%":e.toFixed(e<10?1:0)+"%"}class p{el;input;valueEl;opts;constructor(t){this.opts=t;const e=document.createElement("label");e.className="slider",e.htmlFor=`slider-${t.id}`,e.innerHTML=`
      <div class="slider-row">
        <span class="slider-label">${t.hint?`${t.label}<span class="slider-info" tabindex="0" data-tip="${$(t.hint)}" aria-label="More info: ${$(t.hint)}">i</span>`:t.label}</span>
        <span class="slider-value" data-value></span>
      </div>
      <input id="slider-${t.id}" type="range"
        min="${t.min}" max="${t.max}" step="${t.step??1}" value="${t.value}"
        aria-label="${t.label}" ${t.hint?`aria-description="${$(t.hint)}"`:""} />
    `,this.el=e,this.input=e.querySelector("input"),this.valueEl=e.querySelector("[data-value]"),this.refreshDisplay();let s=0,a=0;this.input.addEventListener("input",()=>{a=parseFloat(this.input.value),this.refreshDisplay(),!s&&(s=requestAnimationFrame(()=>{s=0,this.opts.onChange(a)}))}),this.input.addEventListener("change",()=>{this.opts.onChange(parseFloat(this.input.value))})}setValue(t,e=!1){this.input.value=String(t),this.refreshDisplay(),e||this.opts.onChange(t)}value(){return parseFloat(this.input.value)}refreshDisplay(){const t=parseFloat(this.input.value);this.valueEl.textContent=this.format(t)}onValueChange(t){const e=this.opts.onChange;this.opts.onChange=s=>{e(s),t(s)}}format(t){if(this.opts.format)return this.opts.format(t);switch(this.opts.unit){case"%":return`${Math.round(t)}%`;case"days":return`${t} days`;case"cells":return`${t}×${t} (${t*t})`;case"tiles":return`${t} tiles`;default:return String(t)}}}function $(i){return i.replace(/&/g,"&amp;").replace(/"/g,"&quot;")}class rt{el;button;menu;renameBtn;currentId;custom=!1;customName=null;onPick;onRename=()=>{};constructor(t,e,s){this.currentId=e,this.onPick=s,t.classList.add("preset-picker-host"),t.innerHTML=`
      <div class="preset-row">
        <button type="button" class="preset-button" aria-haspopup="listbox" aria-expanded="false">
          <span class="preset-label" data-preset-label></span>
          <span class="preset-blurb"></span>
          <span class="preset-chevron" aria-hidden="true">▾</span>
        </button>
        <button type="button" class="preset-rename" aria-label="Rename pathogen" data-tip="Give this strain a custom name">✎</button>
      </div>
      <div class="preset-menu" role="listbox" hidden>
        <input type="search" class="preset-search" placeholder="Search diseases…" aria-label="Search diseases" />
        <ul class="preset-options"></ul>
      </div>
    `,this.el=t,this.button=t.querySelector(".preset-button"),this.renameBtn=t.querySelector(".preset-rename"),this.menu=t.querySelector(".preset-menu"),this.renameBtn.addEventListener("click",n=>{n.stopPropagation(),this.startRename()}),this.refreshButton(),this.renderOptions(y),this.button.addEventListener("click",()=>this.toggle()),document.addEventListener("click",n=>{t.contains(n.target)||this.close()});const a=t.querySelector(".preset-search");a.addEventListener("input",()=>{const n=a.value.trim().toLowerCase(),r=n?y.filter(l=>l.label.toLowerCase().includes(n)||l.blurb.toLowerCase().includes(n)):y;this.renderOptions(r)})}setCurrent(t){this.currentId=t,this.custom=!1,this.customName=null,this.refreshButton()}markCustom(t){this.custom!==t&&(this.custom=t,this.refreshButton())}setCustomName(t){this.customName=t&&t.trim()?t.trim().slice(0,64):null,this.refreshButton()}getCustomName(){return this.customName}onRenameChange(t){this.onRename=t}startRename(){const t=this.button.querySelector("[data-preset-label]"),e=t.textContent??"";t.contentEditable="plaintext-only",t.classList.add("renaming"),t.focus();const s=document.createRange();s.selectNodeContents(t);const a=window.getSelection();a?.removeAllRanges(),a?.addRange(s);const n=o=>{if(t.contentEditable="false",t.classList.remove("renaming"),t.removeEventListener("blur",r),t.removeEventListener("keydown",l),!o){t.textContent=e;return}const c=(t.textContent??"").trim(),d=(y.find(u=>u.id===this.currentId)??y[0]).label;!c||c===d?this.customName=null:this.customName=c.slice(0,64),this.refreshButton(),this.onRename(this.customName)},r=()=>n(!0),l=o=>{o.key==="Enter"?(o.preventDefault(),t.blur()):o.key==="Escape"&&(o.preventDefault(),n(!1))};t.addEventListener("blur",r),t.addEventListener("keydown",l)}refreshButton(){const t=y.find(a=>a.id===this.currentId)??y[0],e=this.button.querySelector(".preset-label"),s=this.button.querySelector(".preset-blurb");this.customName?(e.textContent=this.customName,s.textContent=`Custom name · based on ${t.label}`):this.custom?(e.textContent=`Custom · ${t.label}`,s.textContent="Modified from preset. Pick another to reset."):(e.textContent=t.label,s.textContent=t.blurb)}renderOptions(t){const e=this.menu.querySelector(".preset-options");e.innerHTML=t.map(s=>`
      <li role="option" data-id="${s.id}" tabindex="0" ${s.id===this.currentId?'aria-selected="true"':""}>
        <div class="opt-label">${s.label}</div>
        <div class="opt-blurb">${s.blurb}</div>
      </li>
    `).join(""),e.querySelectorAll("li").forEach(s=>{const a=()=>{const n=s.dataset.id,r=y.find(l=>l.id===n);r&&(this.setCurrent(n),this.close(),this.onPick(r))};s.addEventListener("click",a),s.addEventListener("keydown",n=>{(n.key==="Enter"||n.key===" ")&&(n.preventDefault(),a())})})}toggle(){this.menu.hidden?this.open():this.close()}open(){this.menu.hidden=!1,this.button.setAttribute("aria-expanded","true"),this.menu.querySelector(".preset-search").focus()}close(){this.menu.hidden=!0,this.button.setAttribute("aria-expanded","false")}}class ot{cfg;presetId;events;popSlider;seedInfSlider;birthSlider;maskSliders;vaxSliders;strainSliders;picker;constructor(t,e,s){this.cfg=t,this.presetId=e,this.events=s}buildLeft(t){t.innerHTML=`
      <section class="panel" aria-label="Population">
        <header class="panel-head">
          <h3>Population <span class="rate-badge" data-badge="popsize">—</span></h3>
          <span class="panel-icon" aria-hidden="true">👥</span>
        </header>
        <div class="panel-body" data-section="population"></div>
      </section>
      <section class="panel collapsible" aria-label="Mask defense" data-collapsed="true">
        <button type="button" class="panel-head" aria-expanded="false" data-toggle="mask">
          <h3>Mask <span class="rate-badge" data-badge="mask">50%</span></h3>
          <span class="panel-summary" data-summary="mask"></span>
          <span class="panel-icon" aria-hidden="true">😷</span>
          <span class="panel-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="panel-body" data-section="mask"></div>
      </section>
      <section class="panel collapsible" aria-label="Vaccine defense" data-collapsed="true">
        <button type="button" class="panel-head" aria-expanded="false" data-toggle="vaccine">
          <h3>Vaccine <span class="rate-badge" data-badge="vaccine">12%</span></h3>
          <span class="panel-summary" data-summary="vaccine"></span>
          <span class="panel-icon" aria-hidden="true">💉</span>
          <span class="panel-chevron" aria-hidden="true">▾</span>
        </button>
        <div class="panel-body" data-section="vaccine"></div>
      </section>
    `;const e=t.querySelector('[data-section="population"]'),s=t.querySelector('[data-section="mask"]'),a=t.querySelector('[data-section="vaccine"]');this.popSlider=new p({id:"pop-size",label:"Grid size",min:8,max:320,step:8,value:this.cfg.size,format:n=>`${n}×${n}`,onChange:n=>{this.cfg.size=n|0,this.refreshPopBadge(this.cfg.size),this.dirty(!0)}}),this.refreshPopBadge(this.cfg.size),this.seedInfSlider=new p({id:"seed-inf",label:"Seed infections",min:0,max:100,step:1,unit:"%",value:Math.round(this.cfg.seedInfections*100),onChange:n=>{this.cfg.seedInfections=n/100,this.dirty(!0)}}),this.birthSlider=new p({id:"birth-rate",label:"Birth rate",min:0,max:5,step:1,unit:"%",value:Math.round(this.cfg.birthRate*100),onChange:n=>{this.cfg.birthRate=n/100,this.dirty(!1)}}),e.appendChild(this.popSlider.el),e.appendChild(this.seedInfSlider.el),e.appendChild(this.birthSlider.el),this.maskSliders=this.buildDefenseSliders(s,"mask",this.cfg.defenses[0]),this.maskSliders.uptake.onValueChange(n=>{this.refreshBadge("mask",n),this.refreshSummary("mask")}),this.maskSliders.protection.onValueChange(()=>this.refreshSummary("mask")),this.maskSliders.sourceControl.onValueChange(()=>this.refreshSummary("mask")),this.maskSliders.mortalityReduction.onValueChange(()=>this.refreshSummary("mask")),this.refreshBadge("mask",Math.round(this.cfg.defenses[0].uptake*100)),this.refreshSummary("mask"),this.vaxSliders=this.buildDefenseSliders(a,"vax",this.cfg.defenses[1]),this.vaxSliders.uptake.onValueChange(n=>{this.refreshBadge("vaccine",n),this.refreshSummary("vaccine")}),this.vaxSliders.protection.onValueChange(()=>this.refreshSummary("vaccine")),this.vaxSliders.sourceControl.onValueChange(()=>this.refreshSummary("vaccine")),this.vaxSliders.mortalityReduction.onValueChange(()=>this.refreshSummary("vaccine")),this.refreshBadge("vaccine",Math.round(this.cfg.defenses[1].uptake*100)),this.refreshSummary("vaccine"),t.querySelectorAll(".panel-head[data-toggle]").forEach(n=>{n.addEventListener("click",()=>{const r=n.closest(".panel"),l=r.dataset.collapsed==="true";r.dataset.collapsed=l?"false":"true",n.setAttribute("aria-expanded",l?"true":"false")})})}refreshSummary(t){const e=document.querySelector(`[data-summary="${t}"]`);if(!e)return;const s=t==="mask"?this.cfg.defenses[0]:this.cfg.defenses[1],a=[];a.push(`${Math.round(s.protection*100)}% prot`),a.push(`${Math.round(s.sourceControl*100)}% src`),a.push(`${Math.round(s.mortalityReduction*100)}% mort`),e.textContent=a.join(" · ")}refreshBadge(t,e){const s=document.querySelector(`[data-badge="${t}"]`);s&&(s.textContent=`${Math.round(e)}%`)}refreshPopBadge(t){const e=document.querySelector('[data-badge="popsize"]');e&&(e.textContent=`${(t*t).toLocaleString()} cells`)}buildRight(t){t.innerHTML=`
      <section class="panel" aria-label="Disease">
        <header class="panel-head">
          <h3>Disease</h3>
          <span class="panel-icon" aria-hidden="true">🦠</span>
        </header>
        <div class="panel-body">
          <div class="preset-host"></div>
          <div class="strain-sliders" data-section="strain"></div>
        </div>
      </section>
    `;const e=t.querySelector(".preset-host"),s=t.querySelector('[data-section="strain"]');this.picker=new rt(e,this.presetId,n=>{this.presetId=n.id,this.applyStrain(n.genes),this.events.onPresetChange(n),this.events.onCustomNameChange?.(null)}),this.picker.onRenameChange(n=>this.events.onCustomNameChange?.(n));const a=this.cfg.strain;this.strainSliders={attackRate:new p({id:"attack-rate",label:"Attack rate",min:0,max:100,step:1,unit:"%",value:Math.round(a.attackRate*100),hint:"Per-contact transmission probability.",onChange:n=>{this.cfg.strain.attackRate=n/100,this.dirty(!1)}}),incubation:new p({id:"incubation",label:"Incubation",min:1,max:60,step:1,unit:"days",value:a.incubation,hint:"Days from exposure to becoming infectious.",onChange:n=>{this.cfg.strain.incubation=n|0,this.dirty(!1)}}),infectious:new p({id:"infectious",label:"Infectious period",min:1,max:60,step:1,unit:"days",value:a.infectious,hint:"Days the host can transmit.",onChange:n=>{this.cfg.strain.infectious=n|0,this.dirty(!1)}}),ifr:new p({id:"ifr",label:"Kill rate (IFR)",min:0,max:100,step:1,unit:"%",value:Math.round(a.ifr*100),hint:"Infection-fatality rate at recovery roll.",onChange:n=>{this.cfg.strain.ifr=n/100,this.dirty(!1)}}),range:new p({id:"range",label:"Transmission range",min:1,max:6,step:1,unit:"tiles",value:a.range,hint:"Manhattan radius. 1 = nearest neighbors.",onChange:n=>{this.cfg.strain.range=n|0,this.dirty(!0)}}),immunityDays:new p({id:"imm",label:"Immunity duration",min:90,max:36500,step:5,value:Math.max(90,a.immunityDays),hint:"Mean days a recovered cell stays immune before becoming susceptible again. With a finite window plus a large enough population, infections persist endemically — the classic CDA insight.",format:n=>lt(n),onChange:n=>{this.cfg.strain.immunityDays=Math.max(90,n|0),this.dirty(!1)}}),mutationRate:new p({id:"mut",label:"Mutation rate",min:0,max:50,step:1,unit:"%",value:Math.round(a.mutationRate*100),hint:"Per-replication chance per gene to drift (when natural selection is on).",onChange:n=>{this.cfg.strain.mutationRate=n/100,this.dirty(!1)}})};for(const n of Object.keys(this.strainSliders))s.appendChild(this.strainSliders[n].el),this.strainSliders[n].onValueChange(()=>this.recheckCustom())}recheckCustom(){const t=N(this.presetId),e=this.cfg.strain,s=Math.abs(e.attackRate-t.genes.attackRate)<1e-6&&e.incubation===t.genes.incubation&&e.infectious===t.genes.infectious&&Math.abs(e.ifr-t.genes.ifr)<1e-6&&e.range===t.genes.range&&e.immunityDays===t.genes.immunityDays&&Math.abs(e.mutationRate-t.genes.mutationRate)<1e-6;this.picker.markCustom(!s)}buildDefenseSliders(t,e,s){const a=new p({id:`${e}-rate`,label:"Rate",min:0,max:100,step:1,unit:"%",value:Math.round(s.uptake*100),hint:"Fraction of the population that has this defense at start.",onChange:o=>{s.uptake=o/100,this.dirty(!0)}}),n=new p({id:`${e}-prot`,label:"Protection",min:0,max:100,step:1,unit:"%",value:Math.round(s.protection*100),hint:"Reduces incoming infection chance against the wearer.",onChange:o=>{s.protection=o/100,this.dirty(!1)}}),r=new p({id:`${e}-src`,label:"Source control",min:0,max:100,step:1,unit:"%",value:Math.round(s.sourceControl*100),hint:"Reduces outgoing infection from a sick wearer.",onChange:o=>{s.sourceControl=o/100,this.dirty(!1)}}),l=new p({id:`${e}-mort`,label:"Mortality reduction",min:0,max:100,step:1,unit:"%",value:Math.round(s.mortalityReduction*100),hint:"Reduces fatality if a wearer is infected.",onChange:o=>{s.mortalityReduction=o/100,this.dirty(!1)}});return[a,n,r,l].forEach(o=>t.appendChild(o.el)),{protection:n,sourceControl:r,mortalityReduction:l,uptake:a}}applyStrain(t){this.cfg.strain={...t},this.strainSliders.attackRate.setValue(Math.round(t.attackRate*100),!0),this.strainSliders.incubation.setValue(t.incubation,!0),this.strainSliders.infectious.setValue(t.infectious,!0),this.strainSliders.ifr.setValue(Math.round(t.ifr*100),!0),this.strainSliders.range.setValue(t.range,!0),this.strainSliders.immunityDays.setValue(t.immunityDays,!0),this.strainSliders.mutationRate.setValue(Math.round(t.mutationRate*100),!0)}hydrate(t,e){this.cfg=t,this.presetId=e,this.popSlider.setValue(t.size,!0),this.refreshPopBadge(t.size),this.seedInfSlider.setValue(Math.round(t.seedInfections*100),!0),this.birthSlider.setValue(Math.round(t.birthRate*100),!0);const s=t.defenses[0];this.maskSliders.protection.setValue(Math.round(s.protection*100),!0),this.maskSliders.sourceControl.setValue(Math.round(s.sourceControl*100),!0),this.maskSliders.mortalityReduction.setValue(Math.round(s.mortalityReduction*100),!0),this.maskSliders.uptake.setValue(Math.round(s.uptake*100),!0),this.refreshBadge("mask",Math.round(s.uptake*100));const a=t.defenses[1];this.vaxSliders.protection.setValue(Math.round(a.protection*100),!0),this.vaxSliders.sourceControl.setValue(Math.round(a.sourceControl*100),!0),this.vaxSliders.mortalityReduction.setValue(Math.round(a.mortalityReduction*100),!0),this.vaxSliders.uptake.setValue(Math.round(a.uptake*100),!0),this.refreshBadge("vaccine",Math.round(a.uptake*100)),this.applyStrain(t.strain),this.picker.setCurrent(e),this.recheckCustom()}dirty(t){this.events.onConfigChange(this.cfg)}config(){return this.cfg}currentPresetId(){return this.presetId}setCustomName(t){this.picker.setCustomName(t)}getCustomName(){return this.picker.getCustomName()}}function lt(i){if(i>=365*25)return"lifelong";if(i>=365*2){const t=i/365;return`${t%1===0?t.toFixed(0):t.toFixed(1)} years`}if(i>=60){const t=i/30;return`${t%1===0?t.toFixed(0):t.toFixed(1)} months`}return`${i} day${i===1?"":"s"}`}class ct{el;onAccept;constructor(t,e){this.onAccept=e;const s=document.createElement("div");s.className="onboard-card",s.setAttribute("role","dialog"),s.setAttribute("aria-labelledby","onboard-title"),s.innerHTML=`
      <button class="onboard-close" type="button" aria-label="Close">×</button>
      <div class="onboard-icon" aria-hidden="true">
        <svg viewBox="0 0 80 80" width="64" height="64">
          <circle cx="40" cy="40" r="34" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.55"/>
          <circle cx="40" cy="40" r="22" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
          <g transform="translate(40 40)">
            <circle r="6" fill="currentColor"/>
            <g stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none">
              <line x1="0" y1="-6" x2="0" y2="-14"/>
              <line x1="0" y1="6" x2="0" y2="14"/>
              <line x1="-6" y1="0" x2="-14" y2="0"/>
              <line x1="6" y1="0" x2="14" y2="0"/>
              <line x1="-4.2" y1="-4.2" x2="-10" y2="-10"/>
              <line x1="4.2" y1="4.2" x2="10" y2="10"/>
              <line x1="-4.2" y1="4.2" x2="-10" y2="10"/>
              <line x1="4.2" y1="-4.2" x2="10" y2="-10"/>
            </g>
          </g>
        </svg>
      </div>
      <h2 id="onboard-title">Welcome to MemeLab — CDA v3</h2>
      <p class="onboard-tag">Simulate outbreaks. Evolve strains. Master defenses.</p>
      <ol class="onboard-steps">
        <li><strong>Pick a disease</strong> — top-right panel. Click the disease name to browse presets.</li>
        <li><strong>Tune defenses</strong> — left panel. Adjust mask + vaccine uptake and effectiveness.</li>
        <li><strong>Press <kbd>Space</kbd></strong> to play, <kbd>→</kbd> to step a day, <kbd>R</kbd> to reset.</li>
        <li><strong>Share</strong> — Permalink button copies a deterministic URL anyone can replay.</li>
      </ol>
      <div class="onboard-actions">
        <button class="btn btn-primary" data-cta="sars2">Run a SARS-2 outbreak →</button>
        <button class="btn" data-cta="dismiss">Explore on my own</button>
      </div>
      <p class="onboard-foot">Institute of Armchair Epidemiology · clean-room V3 rebuild</p>
    `,this.el=s,s.querySelector(".onboard-close").addEventListener("click",()=>this.dismiss()),s.querySelector('[data-cta="sars2"]')?.addEventListener("click",()=>{this.onAccept(),this.dismiss()}),s.querySelector('[data-cta="dismiss"]')?.addEventListener("click",()=>this.dismiss()),t.appendChild(s)}dismiss(){this.el.classList.add("onboard-out"),setTimeout(()=>this.el.remove(),240)}}const dt=`
  <header class="about-head">
    <div class="about-mark" aria-hidden="true">
      <svg viewBox="0 0 64 64" width="56" height="56">
        <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" stroke-width="2.4" opacity="0.55"/>
        <circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" stroke-width="1" opacity="0.4"/>
        <path d="M32 12 C 27.5 17, 27.5 22, 32 27 C 36.5 32, 36.5 37, 32 42 C 27.5 47, 27.5 52, 32 52" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="46" cy="22" r="4.6" fill="currentColor"/>
      </svg>
    </div>
    <div class="about-titles">
      <h2>What is MemeLab?</h2>
      <p class="about-tag">Simulate outbreaks. Evolve strains. Master defenses.</p>
    </div>
  </header>

  <section>
    <h3>The model</h3>
    <p>
      MemeLab is a <strong>cellular-automaton SEIRS model</strong> of contagion dynamics.
      Each cell on the grid represents a person, host, or node and lives in one of five states:
      <em>Susceptible → Exposed → Infectious → Recovered → (Dead)</em>.
    </p>
    <ul>
      <li><strong>Transmission</strong> happens between Manhattan-distance neighbors. The probability per contact is <code>attackRate × (1 − wearer source-control) × (1 − target protection)</code>.</li>
      <li><strong>Defenses</strong> (mask, vaccine) stack multiplicatively and have separate protection / source-control / mortality-reduction effects.</li>
      <li><strong>Immunity wanes</strong> over a configurable mean duration. With finite immunity plus a sufficient population the disease becomes <strong>endemic</strong> rather than dying out — the central insight of the original CDA.</li>
      <li><strong>Mutation</strong> (optional) applies Gaussian drift to each gene on transmission, so strains evolve under selection pressure rather than teleport to random genotypes.</li>
    </ul>
  </section>

  <section>
    <h3>Why CDA exists</h3>
    <p>
      Cellular Defense Automata started as a Python research toy in 2021, motivated by a question: how much does <em>source control</em> (e.g., a mask on the infectious person) actually move the needle compared to <em>protection</em> (a mask on the susceptible)?
      The answer the model showed — and that real-world studies later corroborated — is that source control is dramatically more effective than personal protection alone.
    </p>
    <p>
      v3 is a clean-room TypeScript rewrite. It moved the simulation into a Web Worker, swapped per-cell DOM nodes for direct canvas rendering, made every run reproducible from a permalink, and ships at roughly an order of magnitude better performance than v2.
    </p>
  </section>

  <section>
    <h3>Backing research</h3>
    <ul class="about-links">
      <li><a href="https://en.wikipedia.org/wiki/Compartmental_models_in_epidemiology#The_SEIR_model" target="_blank" rel="noopener">SEIR / SEIRS compartmental models</a> — the textbook framework MemeLab implements spatially.</li>
      <li><a href="https://en.wikipedia.org/wiki/Cellular_automaton" target="_blank" rel="noopener">Cellular automata</a> — discrete-space, discrete-time substrate.</li>
      <li><a href="https://www.ucsf.edu/news/2020/06/417906/still-confused-about-masks-heres-science-behind-how-face-masks-prevent" target="_blank" rel="noopener">UCSF — how masks reduce transmission</a> — empirical basis for the source-control vs protection asymmetry.</li>
      <li><a href="https://www.cdc.gov/coronavirus/2019-ncov/php/contact-tracing/contact-tracing-plan/appendix.html" target="_blank" rel="noopener">CDC contact-tracing exposure definition</a> — the 15-minute cumulative exposure heuristic that informs neighbor interactions.</li>
      <li><a href="https://en.wikipedia.org/wiki/Serial_passage" target="_blank" rel="noopener">Serial passage</a> — the principle behind the mutation/natural-selection mode.</li>
      <li><a href="https://www.who.int/news-room/q-a-detail/coronavirus-disease-covid-19-how-is-it-transmitted" target="_blank" rel="noopener">WHO — SARS-CoV-2 transmission</a> — incubation and infectious-period defaults.</li>
      <li><a href="https://www.the-scientist.com/news-opinion/cold-causing-coronaviruses-dont-seem-to-confer-lasting-immunity-67832" target="_blank" rel="noopener">Coronaviruses and waning immunity</a> — basis for the SARS-2 reinfection defaults.</li>
      <li><a href="https://www.nature.com/articles/s41591-022-01913-0" target="_blank" rel="noopener">Reinfection rates with SARS-CoV-2 variants (Nature Medicine)</a></li>
    </ul>
  </section>

  <section>
    <h3>How to read the dish</h3>
    <p>The legend below the petri dish maps each state to a color (or sprite, in emoji mode). Watch for:</p>
    <ul>
      <li><strong>R<sub>0</sub></strong>: expected secondary infections from one infectious cell on a fully-susceptible grid. Above 1 → outbreak grows; below 1 → it fizzles.</li>
      <li><strong>R<sub>eff</sub></strong>: live ratio of new infections per new infectious cell, over a 14-day window. The <em>actual</em> growth factor of the running outbreak.</li>
      <li><strong>Strains</strong>: how many distinct genotypes are circulating (relevant when natural selection is on).</li>
    </ul>
  </section>

  <section>
    <h3>Reproducibility</h3>
    <p>
      Every run is fully deterministic from its <code>seed</code>. The <strong>Permalink</strong> button copies a URL that encodes the seed, grid size, disease genes, defenses, theme, and speed in plain query-string form — share it and the recipient sees byte-identical state. Edit any value in the URL directly to fork a scenario.
    </p>
  </section>

  <footer class="about-foot">
    <span>Institute of Armchair Epidemiology · clean-room V3 rebuild</span>
    <span class="about-foot-version">v3 · 10× faster · fully deterministic</span>
  </footer>
`;class ht{el=null;open(){if(this.el)return;const t=document.createElement("div");t.className="about-overlay",t.setAttribute("role","dialog"),t.setAttribute("aria-modal","true"),t.setAttribute("aria-labelledby","about-title"),t.innerHTML=`
      <div class="about-card">
        <button class="about-close" type="button" aria-label="Close">×</button>
        <div class="about-body">${dt}</div>
      </div>
    `,document.body.appendChild(t),this.el=t;const e=()=>this.close();t.querySelector(".about-close")?.addEventListener("click",e),t.addEventListener("click",s=>{s.target===t&&e()}),document.addEventListener("keydown",this.onKey)}close(){if(!this.el)return;document.removeEventListener("keydown",this.onKey);const t=this.el;this.el=null,t.classList.add("about-out"),setTimeout(()=>t.remove(),200)}onKey=t=>{t.key==="Escape"&&this.close()}}let b=null,x=null,w=0;function ut(){return b||(b=document.createElement("div"),b.className="tip",b.role="tooltip",b.hidden=!0,document.body.appendChild(b),b)}function q(i,t){const e=ut();e.textContent=t,e.hidden=!1,x=i;const s=i.getBoundingClientRect(),a=e.offsetWidth,n=e.offsetHeight;let r=s.left+s.width/2-a/2,l=s.top-n-10;l<8&&(l=s.bottom+10);const o=window.innerWidth-a-8;r<8&&(r=8),r>o&&(r=o),e.style.left=`${r}px`,e.style.top=`${l}px`,e.classList.add("tip-in")}function R(){w||(w=window.setTimeout(()=>{w=0,b&&(b.classList.remove("tip-in"),b.hidden=!0,x=null)},80))}function pt(){w&&(clearTimeout(w),w=0)}function mt(){document.addEventListener("mouseover",i=>{const t=i.target;if(!t)return;const e=t.closest("[data-tip]");if(!e){x&&R();return}if(pt(),e===x)return;const s=e.dataset.tip??"";s&&q(e,s)},{passive:!0}),document.addEventListener("mouseout",i=>{const t=i.target;t&&t.closest("[data-tip]")===x&&R()},{passive:!0}),document.addEventListener("focusin",i=>{const t=i.target?.closest("[data-tip]");if(!t)return;const e=t.dataset.tip??"";e&&q(t,e)}),document.addEventListener("focusout",i=>{i.target?.closest("[data-tip]")===x&&R()}),document.addEventListener("keydown",i=>{i.key==="Escape"&&b&&R()})}const W="cda_v3:",z=1;function H(i,t){try{const e=localStorage.getItem(W+i);if(!e)return t;const s=JSON.parse(e);return s.v!==z?t:s.data??t}catch{return t}}function D(i,t){try{localStorage.setItem(W+i,JSON.stringify({v:z,data:t}))}catch{}}function ft(i){const t=i.config,e=t.defenses.find(n=>n.id==="mask"),s=t.defenses.find(n=>n.id==="vaccine"),a=new URLSearchParams;return a.set("preset",i.presetId),a.set("seed",(t.seed>>>0).toString()),a.set("size",String(t.size)),a.set("seedInf",f(t.seedInfections).toString()),a.set("birth",f(t.birthRate).toString()),a.set("mutate",t.mutate?"1":"0"),a.set("attack",f(t.strain.attackRate).toString()),a.set("inc",String(t.strain.incubation)),a.set("inf",String(t.strain.infectious)),a.set("ifr",f(t.strain.ifr).toString()),a.set("range",String(t.strain.range)),a.set("immDays",String(t.strain.immunityDays)),a.set("mutRate",f(t.strain.mutationRate).toString()),e&&(a.set("maskRate",f(e.uptake).toString()),a.set("maskProt",f(e.protection).toString()),a.set("maskSrc",f(e.sourceControl).toString()),a.set("maskMort",f(e.mortalityReduction).toString())),s&&(a.set("vaxRate",f(s.uptake).toString()),a.set("vaxProt",f(s.protection).toString()),a.set("vaxSrc",f(s.sourceControl).toString()),a.set("vaxMort",f(s.mortalityReduction).toString())),a.set("theme",i.theme),a.set("speed",String(i.speed)),i.customName&&a.set("name",i.customName),"#/sim?"+a.toString()}function F(i){if(!i)return null;const t=i.indexOf("?");if(t<0)return null;try{return new URLSearchParams(i.slice(t+1))}catch{return null}}function _(i,t){const e=t.defenses.find(n=>n.id==="mask")??{id:"mask",label:"Mask",protection:.2,sourceControl:.81,mortalityReduction:0,uptake:.5},s=t.defenses.find(n=>n.id==="vaccine")??{id:"vaccine",label:"Vaccine",protection:.8,sourceControl:0,mortalityReduction:.8,uptake:.12};return{config:{seed:v(i,"seed",t.seed)>>>0,size:P(v(i,"size",t.size),8,1024),seedInfections:g(m(i,"seedInf",t.seedInfections)),birthRate:g(m(i,"birth",t.birthRate)),mutate:gt(i,"mutate",t.mutate),strain:{attackRate:g(m(i,"attack",t.strain.attackRate)),incubation:Math.max(1,v(i,"inc",t.strain.incubation)),infectious:Math.max(1,v(i,"inf",t.strain.infectious)),ifr:g(m(i,"ifr",t.strain.ifr)),range:P(v(i,"range",t.strain.range),1,8),immunityDays:P(v(i,"immDays",t.strain.immunityDays),1,36500),mutationRate:g(m(i,"mutRate",t.strain.mutationRate))},defenses:[{...e,uptake:g(m(i,"maskRate",e.uptake)),protection:g(m(i,"maskProt",e.protection)),sourceControl:g(m(i,"maskSrc",e.sourceControl)),mortalityReduction:g(m(i,"maskMort",e.mortalityReduction))},{...s,uptake:g(m(i,"vaxRate",s.uptake)),protection:g(m(i,"vaxProt",s.protection)),sourceControl:g(m(i,"vaxSrc",s.sourceControl)),mortalityReduction:g(m(i,"vaxMort",s.mortalityReduction))}]},theme:i.get("theme")??void 0,speed:i.has("speed")?v(i,"speed",2):void 0,presetId:i.get("preset")??void 0}}function m(i,t,e){const s=i.get(t);if(s==null)return e;const a=parseFloat(s);return Number.isFinite(a)?a:e}function v(i,t,e){const s=i.get(t);if(s==null)return e;const a=parseInt(s,10);return Number.isFinite(a)?a:e}function gt(i,t,e){const s=i.get(t);return s==null?e:s==="1"||s==="true"}function f(i){return Math.round(i*1e3)/1e3}function g(i){return i<0?0:i>1?1:i}function P(i,t,e){const s=i|0;return s<t?t:s>e?e:s}function O(i,t,e="text/plain"){const s=new Blob([t],{type:e});yt(i,s)}function bt(i,t){const e=document.createElement("a");e.href=t,e.download=i,e.click()}function yt(i,t){const e=URL.createObjectURL(t),s=document.createElement("a");s.href=e,s.download=i,document.body.appendChild(s),s.click(),setTimeout(()=>{document.body.removeChild(s),URL.revokeObjectURL(e)},0)}function vt(){const i=new Date,t=e=>e.toString().padStart(2,"0");return`${i.getFullYear()}${t(i.getMonth()+1)}${t(i.getDate())}-${t(i.getHours())}${t(i.getMinutes())}${t(i.getSeconds())}`}const S=[.25,.5,1,2,4,8,16,32],kt=8;class St{root;worker;petri;chart;stats;controls;speedIdx=2;playing=!1;theme="petri";toolbarBtns={};speedBtn;mutateBtn;themeBtn;permalinkBtn;exportBtn;aboutBtn;about=new ht;toastEl;lastFrame=null;constructor(t){this.root=t}start(){this.layout(),mt();const t=this.defaultConfig(),e=location.hash?F(location.hash):null,s=H("lastConfig",null);let a=t.config,n=t.presetId,r=null;if(e){const o=_(e,t.config);a=o.config,o.presetId&&(n=o.presetId),o.speed!=null&&(this.speedIdx=T(o.speed,0,S.length-1)),(o.theme==="lab"||o.theme==="petri")&&(this.theme=o.theme);const c=e.get("name");c&&(r=decodeURIComponent(c))}else s&&(a=s.config,n=s.presetId,this.speedIdx=T(s.speed??2,0,S.length-1),(s.theme==="lab"||s.theme==="petri")&&(this.theme=s.theme),r=s.customName??null);this.applyTheme(),this.controls.hydrate(a,n),this.controls.setCustomName(r),this.refreshSpeedLabel(),this.refreshMutateLabel(),this.refreshThemeLabel(),this.worker=new Worker(new URL("/assets/sim.worker-BEZwJGy6.js",import.meta.url),{type:"module"}),this.worker.onmessage=o=>this.onFrame(o.data),this.send({cmd:"init",config:a});const l=H("onboarded",!1);if((l||e)&&queueMicrotask(()=>{this.playing||this.handlePlay()}),!l){const o=document.createElement("div");o.className="onboard-overlay",this.root.appendChild(o),new ct(o,()=>{D("onboarded",!0);const d=N("sars2-delta");this.controls.applyStrain(d.genes),this.controls.hydrate(this.controls.config(),d.id),this.handlePlay(),setTimeout(()=>o.remove(),260)});const c=new MutationObserver(()=>{o.querySelector(".onboard-card")||(o.remove(),c.disconnect(),D("onboarded",!0),this.playing||this.handlePlay())});c.observe(o,{childList:!0})}document.addEventListener("keydown",o=>this.onKey(o)),window.addEventListener("hashchange",()=>this.onHashChange())}layout(){this.root.innerHTML=`
      <header class="topbar">
        <div class="brand">
          <a class="brand-link" href="./" aria-label="MemeLab home">
            <svg class="brand-mark" viewBox="0 0 64 64" width="40" height="40" aria-hidden="true">
              <defs>
                <linearGradient id="bg-gloss" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="currentColor" stop-opacity="0.25"/>
                  <stop offset="1" stop-color="currentColor" stop-opacity="0.05"/>
                </linearGradient>
              </defs>
              <circle cx="32" cy="32" r="28" fill="url(#bg-gloss)" stroke="currentColor" stroke-width="2"/>
              <circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.45"/>
              <path d="M32 14 C 28 18, 28 22, 32 26 C 36 30, 36 34, 32 38 C 28 42, 28 46, 32 50"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <path d="M28 17 L36 17 M28 23 L36 23 M28 35 L36 35 M28 41 L36 41 M28 47 L36 47"
                    stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
              <circle cx="46" cy="22" r="4.5" fill="currentColor"/>
              <circle cx="46" cy="22" r="2" fill="var(--bg-elevated, #fff)"/>
              <g stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
                <line x1="46" y1="14.5" x2="46" y2="11"/>
                <line x1="46" y1="29.5" x2="46" y2="33"/>
                <line x1="40" y1="22" x2="36.5" y2="22"/>
                <line x1="55.5" y1="22" x2="52" y2="22"/>
              </g>
            </svg>
            <span class="brand-text">
              <span class="brand-name">MemeLab</span>
              <span class="brand-sub">CDA <span class="brand-version">v3</span></span>
            </span>
          </a>
          <span class="brand-tagline">Simulate outbreaks. Evolve strains. Master defenses.</span>
        </div>
        <div class="topbar-actions">
          <button class="btn ghost" data-act="about" data-tip="What is this? Model overview, history, backing research.">
            <span class="btn-icon">?</span>What is this?
          </button>
          <button class="btn" data-act="permalink" data-tip="Copy permalink — encodes the full state in the URL so anyone can replay this exact run.">
            <span class="btn-icon">🔗</span>Permalink
          </button>
          <button class="btn" data-act="export" data-tip="Download PNG snapshot, CSV stats, and JSON config.">
            <span class="btn-icon">⤓</span>Export
          </button>
          <button class="btn icon-only" data-act="theme" aria-label="Toggle theme" data-tip="Switch theme"></button>
        </div>
      </header>

      <div class="toolbar" role="toolbar" aria-label="Simulation controls">
        <button class="tb-btn" data-act="play" aria-label="Play (Space)" title="Play / Pause (Space)">▶</button>
        <button class="tb-btn" data-act="step" aria-label="Step one day (→)" title="Step (→)">▎▶</button>
        <button class="tb-btn" data-act="reset" aria-label="Reset (R)" title="Reset (R)">↺</button>
        <span class="tb-divider"></span>
        <button class="tb-btn" data-act="speed" aria-label="Cycle speed" title="Speed">1×</button>
        <button class="tb-btn" data-act="mutate" aria-label="Toggle natural selection" title="Natural selection">🧬 off</button>
        <span class="tb-spacer"></span>
        <span class="tb-meta" data-meta="rN">R<sub>0</sub> = —</span>
        <span class="tb-meta" data-meta="strains">Strains: 1</span>
      </div>

      <main class="app-main">
        <aside class="left-panel" aria-label="Population and defenses"></aside>
        <section class="center-panel">
          <div class="stats-row" data-section="stats"></div>
          <div class="petri-area" data-section="petri"></div>
          <div class="chart-area" data-section="chart"></div>
        </section>
        <aside class="right-panel" aria-label="Disease"></aside>
      </main>

      <footer class="footer">
        <span class="footer-left">Institute of Armchair Epidemiology · clean-room V3 rebuild</span>
        <span class="footer-right">v3 · 10× faster · fully deterministic</span>
      </footer>

      <div class="toast" role="status" aria-live="polite" hidden></div>
    `;const t=this.root.querySelector(".left-panel"),e=this.root.querySelector(".right-panel"),s=this.root.querySelector('[data-section="stats"]'),a=this.root.querySelector('[data-section="petri"]'),n=this.root.querySelector('[data-section="chart"]');this.toastEl=this.root.querySelector(".toast"),this.stats=new nt(s),this.petri=new et(a),this.chart=new it(n),this.controls=new ot(this.defaultConfig().config,A,{onConfigChange:()=>this.onConfigChange(),onPresetChange:()=>this.onConfigChange(),onCustomNameChange:()=>this.persist()}),this.controls.buildLeft(t),this.controls.buildRight(e),this.toolbarBtns={},this.root.querySelectorAll(".tb-btn").forEach(r=>{const l=r.dataset.act;this.toolbarBtns[l]=r,r.addEventListener("click",()=>this.toolbarAction(l))}),this.speedBtn=this.toolbarBtns.speed,this.mutateBtn=this.toolbarBtns.mutate,this.permalinkBtn=this.root.querySelector('[data-act="permalink"]'),this.exportBtn=this.root.querySelector('[data-act="export"]'),this.themeBtn=this.root.querySelector('[data-act="theme"]'),this.aboutBtn=this.root.querySelector('[data-act="about"]'),this.permalinkBtn.addEventListener("click",()=>this.copyPermalink()),this.exportBtn.addEventListener("click",()=>this.exportRun()),this.themeBtn.addEventListener("click",()=>this.toggleTheme()),this.aboutBtn.addEventListener("click",()=>this.about.open()),this.refreshPlayLabel()}defaultConfig(){const t=N(A);return{config:{seed:12648430,size:8,seedInfections:.001,birthRate:0,mutate:!1,strain:{...t.genes},defenses:[{id:"mask",label:"Mask",protection:.2,sourceControl:.81,mortalityReduction:0,uptake:.5},{id:"vaccine",label:"Vaccine",protection:.8,sourceControl:0,mortalityReduction:.8,uptake:.12}]},presetId:t.id}}send(t){this.worker.postMessage(t)}onFrame(t){this.lastFrame=t,this.petri.paint(t.state,t.defenses,t.size),this.chart.update(t.longStats),this.stats.update(t.stats,t.size*t.size),this.stats.setRNaught(t.rNaught);const e=t.rNaught==null?"—":t.rNaught.toFixed(1);this.metaSet("rN",`R₀ = ${e}`),this.metaSet("strains",`Strains: ${t.stats.strains}`),this.persist()}onConfigChange(){const t=this.controls.config();this.send({cmd:"updateConfig",config:t}),this.playing&&this.send({cmd:"play",tps:this.tps()}),this.persist()}toolbarAction(t){switch(t){case"play":this.handlePlay();break;case"step":this.handleStep();break;case"reset":this.handleReset();break;case"speed":this.cycleSpeed();break;case"mutate":this.toggleMutate();break}}handlePlay(){this.playing=!this.playing,this.playing?this.send({cmd:"play",tps:this.tps()}):this.send({cmd:"pause"}),this.refreshPlayLabel()}handleStep(){this.playing&&(this.playing=!1,this.send({cmd:"pause"}),this.refreshPlayLabel()),this.send({cmd:"step",n:1})}handleReset(){this.playing=!1,this.refreshPlayLabel();const t=this.controls.config();this.send({cmd:"reset",config:t})}cycleSpeed(){this.speedIdx=(this.speedIdx+1)%S.length,this.refreshSpeedLabel(),this.playing&&this.send({cmd:"play",tps:this.tps()}),this.persist()}toggleMutate(){const t=this.controls.config();t.mutate=!t.mutate,this.refreshMutateLabel(),this.onConfigChange()}toggleTheme(){this.theme=this.theme==="petri"?"lab":"petri",this.applyTheme(),this.refreshThemeLabel(),this.petri.refreshPalette(),this.lastFrame&&this.petri.paint(this.lastFrame.state,this.lastFrame.defenses,this.lastFrame.size),this.persist()}applyTheme(){document.documentElement.dataset.theme=this.theme}refreshThemeLabel(){this.themeBtn.innerHTML=this.theme==="petri"?"🌙":"☀️",this.themeBtn.title=`Switch to ${this.theme==="petri"?"Lab (dark)":"Petri (light)"} theme`}refreshPlayLabel(){const t=this.toolbarBtns.play;t.textContent=this.playing?"⏸":"▶",t.setAttribute("aria-pressed",this.playing?"true":"false")}refreshSpeedLabel(){this.speedBtn.textContent=`${S[this.speedIdx]}×`}refreshMutateLabel(){const t=this.controls.config().mutate;this.mutateBtn.innerHTML=`🧬 ${t?"on":"off"}`,this.mutateBtn.classList.toggle("active",t),this.mutateBtn.setAttribute("aria-pressed",t?"true":"false")}metaSet(t,e){const s=this.root.querySelector(`[data-meta="${t}"]`);s&&(s.textContent=e)}tps(){return kt*S[this.speedIdx]}onKey(t){t.target instanceof HTMLInputElement||t.target instanceof HTMLTextAreaElement||(t.key===" "||t.code==="Space"?(t.preventDefault(),this.handlePlay()):t.key==="ArrowRight"?this.handleStep():t.key==="r"||t.key==="R"?this.handleReset():t.key==="m"||t.key==="M"?this.toggleMutate():t.key==="t"||t.key==="T"?this.toggleTheme():t.key==="?"&&this.about.open())}onHashChange(){if(!location.hash)return;const t=F(location.hash);if(!t)return;const e=_(t,this.controls.config());this.controls.hydrate(e.config,e.presetId??this.controls.currentPresetId());const s=t.get("name");this.controls.setCustomName(s?decodeURIComponent(s):null),(e.theme==="lab"||e.theme==="petri")&&(this.theme=e.theme,this.applyTheme()),e.speed!=null&&(this.speedIdx=T(e.speed,0,S.length-1)),this.refreshSpeedLabel(),this.refreshMutateLabel(),this.refreshThemeLabel(),this.send({cmd:"reset",config:e.config})}copyPermalink(){const t=location.origin+location.pathname+ft({config:this.controls.config(),theme:this.theme,speed:this.speedIdx,presetId:this.controls.currentPresetId(),customName:this.controls.getCustomName()});navigator.clipboard.writeText(t).then(()=>this.toast("Permalink copied. State encoded in URL."),()=>{history.replaceState(null,"",t),this.toast("Permalink set in address bar.")}),history.replaceState(null,"",t)}exportRun(){if(!this.lastFrame)return;const t=vt(),e=this.chart.exportCsv(this.lastFrame.longStats);O(`memelab-${t}.csv`,e,"text/csv");const s=JSON.stringify({config:this.controls.config(),presetId:this.controls.currentPresetId(),tick:this.lastFrame.tick,rNaught:this.lastFrame.rNaught,stats:this.lastFrame.stats,longStats:this.lastFrame.longStats},null,2);O(`memelab-${t}.json`,s,"application/json"),bt(`memelab-${t}.png`,this.petri.toDataURL()),this.toast("Exported PNG, CSV, and JSON.")}toast(t){this.toastEl.textContent=t,this.toastEl.hidden=!1,this.toastEl.classList.add("toast-in"),clearTimeout(this.toastEl._t),this.toastEl._t=window.setTimeout(()=>{this.toastEl.classList.remove("toast-in"),this.toastEl.hidden=!0},2400)}persist(){D("lastConfig",{config:this.controls.config(),presetId:this.controls.currentPresetId(),speed:this.speedIdx,theme:this.theme,customName:this.controls.getCustomName()})}}function T(i,t,e){const s=i|0;return s<t?t:s>e?e:s}const U=document.getElementById("app");if(!U)throw new Error("#app missing");const xt=new St(U);xt.start();
