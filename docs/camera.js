import {EarthquakeMonitor} from './camera-event.js';
import {LIVE_CAMERAS} from './live-cameras.js';
import {rankCameras, cameraLayout} from './camera-model.js';
import {LiveCameraPlayer} from './camera-player.js';
import {CameraLifetime} from './camera-lifetime.js';

const stored = () => {try{return localStorage.getItem('eew-camera-auto') !== 'false';}catch{return true;}};
const persist = value => {try{localStorage.setItem('eew-camera-auto',String(value));}catch{/* optional storage */}};
const regionName = event => String(event?.name || '震源付近');

export function startCameras() {
  const monitor=new EarthquakeMonitor({showActiveOnStart:true});
  const lifetime=new CameraLifetime();
  let automatic=stored();
  let expanded=false;
  let current=null;
  let latestNative=null;
  let choices=[];
  let selected=null;
  let layout={mode:'off',video:false};
  let layoutKey='';
  let shownVideo=null;
  let stopped=false;
  let suspended=false;
  let timer=null;
  let lastInfoKey='';
  let logState={entries:[],connection:'connecting',message:'接続しています'};
  let logKey='';
  let followLog=true;
  let unseenPosts=0;
  const logRows=new Map();
  const failed=new Set();

  const control=document.createElement('button');
  control.type='button';control.className='eew-camera-control';control.textContent='カメラ';
  control.setAttribute('aria-label','ライブカメラを開く');control.setAttribute('aria-expanded','false');
  const panel=document.createElement('aside');
  panel.className='eew-camera-panel';panel.hidden=true;panel.setAttribute('aria-label','近くのライブカメラ');
  panel.innerHTML=`<div class="eew-camera-card"><div class="eew-camera-heading"><h2>近くのライブカメラ</h2><label><input type="checkbox">自動表示</label><button type="button" class="eew-camera-close" aria-label="カメラを縮小" title="カメラを縮小">×</button></div>
    <p class="eew-camera-event"></p>
    <div class="eew-camera-player" hidden></div>
    <div class="eew-camera-meta" hidden><span class="eew-camera-credit"></span><span class="eew-camera-status" role="status"></span><button type="button" class="eew-camera-play" hidden>再生</button></div>
    <div class="eew-camera-controls" hidden><select aria-label="近くのカメラを選ぶ"></select><button type="button" class="eew-camera-next">次のカメラ</button><a target="_blank" rel="noopener noreferrer">提供元↗</a></div>
    <p class="eew-camera-description"></p><button type="button" class="eew-camera-preview" disabled>最新の地震付近を見る</button></div>
    <section class="eew-camera-log" aria-label="コミュニティ投稿ログ"><div class="eew-camera-log-heading"><h3>コミュニティ投稿ログ</h3><span class="eew-camera-log-status"></span></div>
      <div class="eew-camera-log-summary"><span>直近10分・新しい順</span><button type="button" class="eew-camera-log-follow" hidden>最新へ</button></div>
      <ol class="eew-camera-log-rows" aria-label="1投稿ずつの地域と時刻" tabindex="0"></ol><p class="eew-camera-log-empty">新しい投稿を待っています</p></section>`;
  const auto=panel.querySelector('input');auto.checked=automatic;
  const eventNode=panel.querySelector('.eew-camera-event');
  const playerNode=panel.querySelector('.eew-camera-player');
  const meta=panel.querySelector('.eew-camera-meta');
  const credit=panel.querySelector('.eew-camera-credit');
  const status=panel.querySelector('.eew-camera-status');
  const play=panel.querySelector('.eew-camera-play');
  const controls=panel.querySelector('.eew-camera-controls');
  const select=panel.querySelector('select');
  const next=panel.querySelector('.eew-camera-next');
  const source=panel.querySelector('a');
  const description=panel.querySelector('.eew-camera-description');
  const preview=panel.querySelector('.eew-camera-preview');
  const logNode=panel.querySelector('.eew-camera-log');
  const rows=panel.querySelector('.eew-camera-log-rows');
  const logStatus=panel.querySelector('.eew-camera-log-status');
  const logEmpty=panel.querySelector('.eew-camera-log-empty');
  const logFollow=panel.querySelector('.eew-camera-log-follow');
  document.body.append(panel,control);
  document.body.classList.add('eew-camera-enabled');

  function renderLog(){
    const visible=!panel.hidden&&!document.body.classList.contains('eew-community-details')&&
      (layout.mode==='side'||layout.mode==='bottom'&&layout.bottom>=390);
    if(!visible){for(const row of logRows.values())row.classList.remove('is-new');return;}
    const entries=logState.entries;
    const key=JSON.stringify([entries,logState.connection,logState.message,logState.demo]);
    if(key===logKey)return;
    logKey=key;
    const anchor=[...rows.children].find(node=>node.offsetTop+node.offsetHeight>rows.scrollTop);
    const offset=anchor?anchor.offsetTop-rows.scrollTop:0;
    const previous=new Set(logRows.keys());
    const retained=new Set();
    for(const [index,entry] of entries.entries()){
      retained.add(entry.key);
      let row=logRows.get(entry.key);
      if(!row){
        row=document.createElement('li');row.className='eew-camera-log-row';
        row.innerHTML='<time></time><span></span><small></small>';
        logRows.set(entry.key,row);
        if(!entry.history&&!followLog)unseenPosts++;
        if(!entry.history&&Date.now()-entry.receivedAt<2000)row.classList.add('is-new');
      }
      row.querySelector('time').textContent=entry.timeLabel;
      row.querySelector('time').dateTime=new Date(entry.at).toISOString();
      row.querySelector('span').textContent=entry.areaName;
      row.querySelector('small').textContent=entry.history?'履歴':'揺れた';
      row.title=`${entry.timeLabel} ${entry.areaName} · ${entry.history?'履歴の投稿':'揺れた報告'}`;
      row.dataset.history=String(entry.history);
      if(rows.children[index]!==row)rows.insertBefore(row,rows.children[index]??null);
    }
    for(const key of previous)if(!retained.has(key)){logRows.get(key).remove();logRows.delete(key);}
    if(followLog){rows.scrollTop=0;unseenPosts=0;}
    else if(anchor?.parentNode===rows)rows.scrollTop=anchor.offsetTop-offset;
    const texts={live:'受信中',shared:'受信中',history:'履歴取得中',connecting:'接続中',reconnecting:'再接続中',offline:'オフライン',error:'接続を確認中',stopped:'一時停止',demo:'デモ'};
    logStatus.textContent=texts[logState.connection]||'接続中';
    logStatus.title=logState.message||'';
    logNode.dataset.connection=logState.connection;
    logNode.dataset.reportCount=String(entries.length);
    logEmpty.hidden=entries.length>0;
    logEmpty.textContent=logState.demo?'デモ表示・実際の投稿ではありません':entries.length?'':'直近10分の個別投稿はありません';
    updateFollow();
  }
  function updateFollow(){
    logFollow.hidden=followLog;
    logFollow.textContent=unseenPosts?`新着${unseenPosts}件・最新へ`:'最新へ';
  }
  function receiveLog(event){
    if(!Array.isArray(event.detail?.entries))return;
    logState=event.detail;renderLog();
  }
  rows.addEventListener('scroll',()=>{followLog=rows.scrollTop<=4;if(followLog)unseenPosts=0;updateFollow();},{passive:true});
  rows.addEventListener('animationend',event=>{if(event.target.classList?.contains('eew-camera-log-row'))event.target.classList.remove('is-new');});
  logFollow.addEventListener('click',()=>{followLog=true;unseenPosts=0;rows.scrollTop=0;updateFollow();});
  document.addEventListener('eew-community-log',receiveLog);
  document.dispatchEvent(new Event('eew-community-log-request'));

  function setStatus(text,error=false){
    status.textContent=text;status.dataset.error=String(error);
    panel.dataset.playback=error?'error':text;
  }
  function resetPlayer(){player.destroy();shownVideo=null;playerNode.hidden=true;play.hidden=true;}
  function nextCamera(){
    const start=choices.findIndex(camera=>camera.id===selected?.id);
    for(let offset=1;offset<=choices.length;offset++){
      const candidate=choices[(start+offset+choices.length)%choices.length];
      if(!failed.has(candidate.id)){choose(candidate);return;}
    }
    resetPlayer();setStatus('提供元で確認できます',true);play.textContent='再試行';play.hidden=false;
    description.textContent='この付近の配信を再生できませんでした。提供元で映像を確認できます。';
  }
  const player=new LiveCameraPlayer({
    onStatus(update){
      if(stopped||!shownVideo)return;
      const texts={loading:'接続中',playing:'再生中',paused:'一時停止',blocked:'再生を押してください',ended:'配信終了',error:'再生できません'};
      setStatus(texts[update.state]||'接続中',update.state==='error'||update.state==='ended');
      play.textContent='再生';play.hidden=update.state!=='blocked'&&update.state!=='paused';
      if(update.state==='ended'&&selected){failed.add(selected.id);queueMicrotask(()=>{if(!stopped)nextCamera();});}
    },
    onError(error){
      if(stopped||!shownVideo||!selected)return;
      failed.add(selected.id);
      // Identifier/network failures affect every player; do not churn through
      // unrelated cameras or reload indefinitely in a restricted browser.
      if([100,101,150,2].includes(Number(error.code))){queueMicrotask(()=>{if(!stopped)nextCamera();});}
      else{resetPlayer();setStatus('提供元で確認できます',true);play.textContent='再試行';play.hidden=false;description.textContent='この画面では映像を再生できません。提供元で確認できます。';}
    },
  });

  function renderInfo(){
    const key=JSON.stringify([current?.id,current?.name,current?.kind,current?.manual,selected?.id,
      choices.map(camera=>[camera.id,Math.round(camera.distanceKm)]),layout.mode]);
    if(key===lastInfoKey)return;
    lastInfoKey=key;
    control.dataset.available=String(Boolean(selected));
    control.title=current?`${regionName(current)} · ${selected?.label||'近くに登録カメラがありません'}`:'地震情報に合わせて近くのライブカメラを表示します';
    eventNode.textContent=current?`${current.manual?'地震履歴':current.kind==='eew'?'緊急地震速報':'地震情報'} · ${regionName(current)}`:'地震情報の受信を待っています';
    eventNode.title=eventNode.textContent;
    select.replaceChildren(...choices.map(camera=>{
      const option=document.createElement('option');option.value=camera.id;
      option.textContent=`${camera.label} · 約${Math.round(camera.distanceKm)}km`;return option;
    }));
    if(selected)select.value=selected.id;
    meta.hidden=controls.hidden=!selected;
    preview.hidden=Boolean(current);
    next.disabled=choices.length<2;
    source.href=selected?.sourceURL||'https://www.youtube.com/';
    source.title=selected?`${selected.owner}の配信ページを開く`:'';
    credit.textContent=selected?`${selected.owner} · 震源から約${Math.round(selected.distanceKm)}km`:'';
    credit.title=credit.textContent;
    if(!current)description.textContent='地震を受信すると、震源から近い登録カメラを自動で表示します。映像は音声を消して再生します。';
    else if(!selected)description.textContent='震源から300km以内に、登録されているカメラがありません。';
    else if(layout.mode==='compact')description.textContent='提供元で映像を開けます。';
    else if(!failed.has(selected.id))description.textContent=selected.maySwitchView?'提供元の番組により撮影場所が切り替わる場合があります。':'映像はカメラの提供元から配信されます。';
    panel.dataset.eventId=current?.id||'';panel.dataset.cameraId=selected?.id||'';
  }

  function ensurePlayer(){
    const loading=document.getElementById('loading');
    const error=document.getElementById('error');
    const canPlay=selected&&!failed.has(selected.id)&&layout.video&&!document.hidden&&!suspended&&(!loading||loading.hidden)&&(!error||error.hidden);
    if(!canPlay){if(shownVideo)resetPlayer();return;}
    if(shownVideo===selected.videoId)return;
    player.destroy();shownVideo=selected.videoId;playerNode.hidden=false;
    play.hidden=true;setStatus('接続中');
    player.show(selected,playerNode);
  }
  function syncLayout(){
    if(stopped)return;
    const communityDetails=document.body.classList.contains('eew-community-details');
    layout=cameraLayout({width:innerWidth,height:innerHeight,expanded,communityDetails,hasEvent:Boolean(current&&selected)});
    const key=JSON.stringify([layout.mode,layout.side,layout.bottom,communityDetails]);
    if(key!==layoutKey){
      layoutKey=key;
      for(const mode of ['side','bottom','compact'])document.body.classList.toggle(`eew-camera-${mode}`,layout.mode===mode);
      document.body.style.setProperty('--eew-camera-bottom',`${layout.bottom}px`);
      panel.hidden=layout.mode==='off'||layout.mode==='compact'&&layout.bottom===0;
      panel.dataset.layout=layout.mode;
      panel.dataset.logSpace=String(layout.mode==='side'||layout.mode==='bottom'&&layout.bottom>=390);
      control.setAttribute('aria-expanded',String(!panel.hidden));
      globalThis.scaffolding?.relayout?.();
      document.dispatchEvent(new Event('eew-layout-change'));
      renderInfo();
    }
    ensurePlayer();
    renderLog();
  }
  function choose(camera){
    if(!camera)return;
    selected=camera;description.textContent='';renderInfo();syncLayout();
  }
  function adopt(event){
    const prior=current?.id===event.id?selected?.id:null;
    current=event;choices=rankCameras(event,LIVE_CAMERAS);failed.clear();
    selected=choices.find(camera=>camera.id===prior)||choices[0]||null;
    lifetime.start(event);
    if(automatic&&selected)expanded=true;
    renderInfo();syncLayout();
  }
  function clearCurrent(){
    current=null;choices=[];selected=null;expanded=false;failed.clear();
    lifetime.clear();
    resetPlayer();renderInfo();syncLayout();
  }
  function tick(){
    clearTimeout(timer);timer=null;
    if(stopped||suspended||document.hidden)return;
    try{
      const event=monitor.update(globalThis.vm);
      latestNative=event;
      preview.disabled=!(event&&!event.cancelled&&!event.replay&&event.reliable&&rankCameras(event,LIVE_CAMERAS).length);
      const displayed=current?monitor.status?.(current.id):null;
      const replay=Boolean(event?.replay||displayed?.replay);
      if(current&&(replay||displayed?.cancelled||displayed?.reliable===false||displayed?.located===false||displayed?.reason==='future'||
        event?.id===current.id&&(event.cancelled||event.reliable===false)))clearCurrent();
      if(!replay&&event?.isNew)adopt(event);
      else if(!replay&&event&&current?.id===event.id){
        const moved=event.lat!==current.lat||event.lon!==current.lon;
        current={...event,manual:current.manual};
        if(moved){const id=selected?.id;choices=rankCameras(event,LIVE_CAMERAS);selected=choices.find(camera=>camera.id===id)||choices[0]||null;}
        renderInfo();
      }
      if(current&&lifetime.update(monitor.status(current.id)).close)clearCurrent();
      syncLayout();
    }catch(error){console.warn('Camera earthquake monitor could not update',error);}
    timer=setTimeout(tick,1000);
  }
  function openPanel(){
    if(selected&&innerHeight<=350){open(selected.sourceURL,'_blank','noopener,noreferrer');return;}
    const details=document.querySelector('.eew-community-panel');
    if(!(innerWidth>=960&&innerHeight>=500)&&details?.open){details.open=false;expanded=true;}
    else expanded=!expanded;
    renderInfo();syncLayout();
  }
  function visibility(){if(document.hidden){clearTimeout(timer);resetPlayer();}else tick();}
  function pause(){suspended=true;clearTimeout(timer);resetPlayer();}
  function resume(){suspended=false;tick();}
  function resize(){syncLayout();}
  control.addEventListener('click',openPanel);
  panel.querySelector('.eew-camera-close').addEventListener('click',()=>{expanded=false;syncLayout();});
  auto.addEventListener('change',()=>{automatic=auto.checked;persist(automatic);if(!automatic){expanded=false;syncLayout();}});
  select.addEventListener('change',()=>{const camera=choices.find(item=>item.id===select.value);if(camera){failed.delete(camera.id);choose(camera);}});
  next.addEventListener('click',()=>{if(failed.size>=choices.length)failed.clear();nextCamera();});
  preview.addEventListener('click',()=>{
    if(latestNative&&!preview.disabled){adopt({...latestNative,manual:true});expanded=true;renderInfo();syncLayout();}
  });
  play.addEventListener('click',()=>{
    if(selected&&failed.has(selected.id)){failed.delete(selected.id);syncLayout();}
    else player.play();
  });
  const observer=new MutationObserver(syncLayout);
  observer.observe(document.body,{attributes:true,attributeFilter:['class']});
  document.addEventListener('visibilitychange',visibility);
  addEventListener('resize',resize);addEventListener('pagehide',pause);addEventListener('pageshow',resume);
  renderInfo();tick();
  return {stop(){
    stopped=true;clearTimeout(timer);resetPlayer();observer.disconnect();
    lifetime.clear();document.removeEventListener('eew-community-log',receiveLog);
    document.removeEventListener('visibilitychange',visibility);
    removeEventListener('resize',resize);removeEventListener('pagehide',pause);removeEventListener('pageshow',resume);
    panel.remove();control.remove();
    for(const name of ['eew-camera-enabled','eew-camera-side','eew-camera-bottom','eew-camera-compact'])document.body.classList.remove(name);
    document.body.style.removeProperty('--eew-camera-bottom');
    globalThis.scaffolding?.relayout?.();document.dispatchEvent(new Event('eew-layout-change'));
  }};
}
