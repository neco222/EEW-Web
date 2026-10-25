import {communityLogLayout} from './community-log-layout.js';

/** The bounded history stays available while its optional automatic view is off. */
export function startCommunityLogView({detailsBody,active=false}) {
  let state={entries:[],connection:'connecting',message:'接続しています'};
  let rendered='';
  let layoutKey='';
  let reservationKey='';
  let stopped=false;
  let follow=true;
  let unseen=0;
  let cameraCard=null;
  const nodes=new Map();
  const dock=document.createElement('aside');
  dock.className='eew-report-log';
  dock.hidden=true;
  dock.setAttribute('aria-label','コミュニティ投稿ログ');
  dock.innerHTML=`<div class="eew-report-log-heading"><h2>コミュニティ投稿ログ</h2><span class="eew-report-log-status"></span><button type="button" class="eew-report-log-follow" hidden>最新へ</button></div>
    <div class="eew-report-log-summary"><span>直近10分・新しい順</span><span class="eew-report-log-map"></span></div>
    <ol class="eew-report-log-rows" aria-label="1投稿ずつの地域と時刻" tabindex="0"></ol><p class="eew-report-log-empty">新しい投稿を待っています</p>`;
  const rows=dock.querySelector('ol');
  const status=dock.querySelector('.eew-report-log-status');
  const empty=dock.querySelector('.eew-report-log-empty');
  const latest=dock.querySelector('button');
  const mapStatus=dock.querySelector('.eew-report-log-map');
  mapStatus.textContent=document.querySelector('.eew-community-follow-state')?.textContent||'新着の個別投稿を待っています';
  document.body.append(dock);

  function updateFollow(){
    latest.hidden=follow;
    latest.textContent=unseen?`新着${unseen}件・最新へ`:'最新へ';
  }
  function render(){
    if(stopped||document.hidden||dock.hidden)return;
    const key=JSON.stringify(state);
    if(key===rendered)return;
    rendered=key;
    const anchor=[...rows.children].find(node=>node.offsetTop+node.offsetHeight>rows.scrollTop);
    const offset=anchor?anchor.offsetTop-rows.scrollTop:0;
    const retained=new Set();
    for(const [index,entry] of state.entries.entries()){
      retained.add(entry.key);
      let row=nodes.get(entry.key);
      if(!row){
        row=document.createElement('li');row.className='eew-report-log-row';
        row.innerHTML='<time></time><span></span><small></small>';
        nodes.set(entry.key,row);
        if(!entry.history&&!follow)unseen++;
        if(!dock.hidden&&!entry.history&&Date.now()-entry.receivedAt<2000)row.classList.add('is-new');
      }
      row.querySelector('time').textContent=entry.timeLabel;
      row.querySelector('time').dateTime=new Date(entry.at).toISOString();
      row.querySelector('span').textContent=entry.areaName;
      row.querySelector('small').textContent=entry.history?'履歴':'揺れた';
      row.dataset.history=String(entry.history);
      row.title=`${entry.timeLabel} ${entry.areaName} · ${entry.history?'履歴の投稿':'揺れた報告'}`;
      if(rows.children[index]!==row)rows.insertBefore(row,rows.children[index]??null);
    }
    for(const [key,row] of nodes)if(!retained.has(key)){row.remove();nodes.delete(key);}
    if(follow){rows.scrollTop=0;unseen=0;}
    else if(anchor?.parentNode===rows)rows.scrollTop=anchor.offsetTop-offset;
    const texts={live:'受信中',shared:'受信中',polling:'履歴で補完中',history:'履歴取得中',connecting:'接続中',reconnecting:'再接続中',offline:'オフライン',error:'接続を確認中',stopped:'一時停止',demo:'デモ'};
    const connection=state.connection==='shared'&&state.upstreamState&&state.upstreamState!=='live'?state.upstreamState:state.connection;
    status.textContent=texts[connection]||'接続中';status.title=state.message||'';
    dock.dataset.connection=state.connection;dock.dataset.reportCount=String(state.entries.length);
    empty.hidden=state.entries.length>0;
    empty.textContent=state.demo?'デモ表示・実際の投稿ではありません':'直近10分の個別投稿はありません';
    updateFollow();
  }
  const sizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(syncLayout):null;
  function syncLayout(event){
    if(stopped)return;
    const details=document.body.classList.contains('eew-community-details');
    const card=active||details?document.querySelector('.eew-camera-card'):null;
    if(card!==cameraCard){if(cameraCard)sizeObserver?.unobserve(cameraCard);cameraCard=card;if(card)sizeObserver?.observe(card);}
    const panel=card?.parentElement;
    const side=document.body.classList.contains('eew-camera-side')&&panel&&!panel.hidden;
    const cameraBottom=panel&&!panel.hidden&&!side?Number.parseFloat(document.body.style.getPropertyValue('--eew-camera-bottom'))||0:0;
    const layout=communityLogLayout({width:innerWidth,height:innerHeight,cameraBottom,
      cameraTop:side?Math.ceil(card.getBoundingClientRect().bottom):0,
      details,active});
    const key=JSON.stringify(layout);
    if(key===layoutKey)return;
    layoutKey=key;
    const parent=layout.mode==='inline'?detailsBody:document.body;
    if(dock.parentNode!==parent){if(layout.mode==='inline')parent.prepend(dock);else parent.append(dock);}
    dock.hidden=layout.mode==='off';dock.dataset.layout=layout.mode;
    if(dock.hidden)for(const row of nodes.values())row.classList.remove('is-new');
    dock.classList.toggle('is-compact',layout.mode==='bottom'&&layout.logHeight<90);
    document.body.classList.toggle('eew-log-side',Boolean(layout.side));
    document.body.classList.toggle('eew-log-bottom',layout.mode==='bottom');
    document.body.classList.toggle('eew-log-inline',layout.mode==='inline');
    for(const [name,value] of [['top',layout.top],['height',layout.logHeight],['bottom',layout.bottom]])document.body.style.setProperty(`--eew-log-${name}`,`${value}px`);
    // Only reservation changes resize the map. Automatic camera/log changes
    // let a fresh report wait for geometry; a manual drawer remains a priority.
    const reservation=JSON.stringify([layout.side,layout.bottom]);
    if(reservation!==reservationKey){
      reservationKey=reservation;
      globalThis.scaffolding?.relayout?.();
      document.dispatchEvent(new CustomEvent('eew-layout-change',{detail:{
        source:['eew-camera-layout','eew-community-log-activity'].includes(event?.type)?'camera-reservation':'community-layout',
      }}));
    }
    // Hidden updates retain only state. Reveal the current bounded history once
    // for both automatic activation and a manually opened details drawer.
    if(!dock.hidden)render();
  }
  const receive=event=>{if(Array.isArray(event.detail?.entries)){state=event.detail;render();}};
  const receiveMap=event=>{if(typeof event.detail?.message==='string'){
    mapStatus.textContent=event.detail.message;dock.dataset.mapState=event.detail.state;dock.dataset.mapReason=event.detail.reason??'';
  }};
  const visibility=()=>{if(!document.hidden){render();syncLayout();}};
  const mutation=new MutationObserver(syncLayout);
  mutation.observe(document.body,{attributes:true,attributeFilter:['class']});
  rows.addEventListener('scroll',()=>{follow=rows.scrollTop<=4;if(follow)unseen=0;updateFollow();},{passive:true});
  rows.addEventListener('animationend',event=>event.target.classList?.remove('is-new'));
  latest.addEventListener('click',()=>{follow=true;unseen=0;rows.scrollTop=0;updateFollow();});
  document.addEventListener('eew-community-log',receive);
  document.addEventListener('eew-community-map-state',receiveMap);
  document.addEventListener('eew-camera-layout',syncLayout);
  document.addEventListener('visibilitychange',visibility);
  addEventListener('resize',syncLayout);
  syncLayout();render();document.dispatchEvent(new Event('eew-community-log-request'));
  return {setActive(value){
    if(stopped||active===Boolean(value))return;
    active=Boolean(value);syncLayout({type:'eew-community-log-activity'});
  },stop(){
    if(stopped)return;stopped=true;mutation.disconnect();sizeObserver?.disconnect();
    document.removeEventListener('eew-community-log',receive);document.removeEventListener('eew-camera-layout',syncLayout);
    document.removeEventListener('eew-community-map-state',receiveMap);
    document.removeEventListener('visibilitychange',visibility);removeEventListener('resize',syncLayout);
    dock.remove();nodes.clear();
    document.body.classList.remove('eew-log-side','eew-log-bottom','eew-log-inline');
    for(const name of ['top','height','bottom'])document.body.style.removeProperty(`--eew-log-${name}`);
    globalThis.scaffolding?.relayout?.();document.dispatchEvent(new Event('eew-layout-change'));
  }};
}
