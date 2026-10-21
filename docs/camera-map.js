import {LIVE_CAMERAS} from './live-cameras.js';
import {readView} from './viewer-bridge.js';
import {readMapObstacles} from './viewer-obstacles.js';
import {layoutCameraMarkers} from './camera-map-layout.js';

const FRAME_MS = 100;
const IDLE_MS = 500;
const OBSTACLE_MS = 1000;
const SOURCE_LISTS = ['map:表示する震度','5地震情報リスト','0EEW','ten:震度','sten:表示用','9津波関連','9-5各点津波観測状況'];
const SETTINGS = [9,14,16,17,20,22,23,62,78];
const same = (a,b) => a?.length === b?.length && a.every((value,index) => Object.is(value,b[index]));
const noop = () => {};

/** Independent map buttons. No VM writes, runtime hooks, media or requests. */
export function startCameraMap({onSelect = noop, catalog = LIVE_CAMERAS,
  vm = () => globalThis.vm, read = readView, layout = layoutCameraMarkers} = {}) {
  if (typeof document === 'undefined') return {setSelection:noop,setEnabled:noop,wake:noop,stop:noop};
  const doc = document;
  const cameras = Array.isArray(catalog) ? catalog.slice(0,25) : [];
  const layer = doc.createElement('div');
  layer.className = 'eew-camera-map';layer.hidden = true;
  layer.setAttribute('role','group');layer.setAttribute('aria-label','地図上のカメラ');
  layer.dataset.visibleCount = '0';layer.dataset.catalogCount = String(cameras.length);
  const canvas = doc.createElement('canvas');
  canvas.className = 'eew-camera-map-leaders';canvas.setAttribute('aria-hidden','true');
  layer.append(canvas);doc.body.append(layer);
  const context = canvas.getContext('2d',{alpha:true});
  const nodes = new Map();
  const listeners = [];
  let selection = {id:null,playing:false};
  let enabled = true, stopped = false, paused = false, timer = null;
  let lastFrame = -Infinity, motionUntil = -Infinity, lastGeometry = null;
  let obstacleAt = -Infinity, obstacleGeometry = null, obstacleSource = null, obstacles = [];
  let obstacleVersion = 0, lastRender = '', stage = null, variables = null, names = null;
  const now = () => performance.now();

  function listen(target,name,handler,options) {
    target.addEventListener(name,handler,options);
    listeners.push(() => target.removeEventListener(name,handler,options));
  }
  function hide(reason) {
    if (!layer.hidden) context?.clearRect(0,0,canvas.width,canvas.height);
    layer.hidden = true;layer.dataset.visibleCount = '0';layer.dataset.state = reason;lastRender = '';
  }
  function cancelTimer() {if (timer !== null) clearTimeout(timer);timer = null;}
  function runnable() {return enabled && !stopped && !paused && !doc.hidden;}
  function schedule(delay) {
    if (!runnable()) return;
    cancelTimer();timer = setTimeout(tick,Math.max(delay,FRAME_MS - (now()-lastFrame),0));
  }
  function wake() {if (!runnable()) return;motionUntil = now()+750;schedule(0);}
  function resetPresses() {
    for (const entry of nodes.values()) entry.pointer = entry.mouse = entry.touch = false;
  }
  function createMarker(camera) {
    const button = doc.createElement('button');button.type = 'button';
    button.className = 'eew-camera-map-marker';button.dataset.cameraId = camera.id;
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 7.5h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13" r="3.5"/></svg>';
    const entry = {button,pointer:false,mouse:false,touch:false,position:'',label:''};
    for (const [down,up,key] of [['pointerdown','pointerup','pointer'],['mousedown','mouseup','mouse'],['touchstart','touchend','touch']]) {
      button.addEventListener(down,event => {entry[key]=true;event.stopPropagation();},{passive:true});
      // A drag that started on the map must still release Scratch's mouse.
      button.addEventListener(up,event => {if (entry[key]) event.stopPropagation();entry[key]=false;},{passive:true});
    }
    for (const type of ['pointercancel','touchcancel']) button.addEventListener(type,event => {
      if (entry.pointer || entry.touch) event.stopPropagation();entry.pointer=entry.touch=false;
    },{passive:true});
    for (const type of ['keydown','keyup']) button.addEventListener(type,event => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') event.stopPropagation();
    });
    button.addEventListener('click',event => {
      event.stopPropagation();wake();
      try {onSelect(camera.id);} catch (error) {console.warn('Camera selection could not open',error);}
    });
    layer.append(button);nodes.set(camera.id,entry);return entry;
  }
  function sourceSignature(machine) {
    const runtime = machine?.runtime;
    const current = runtime?.targets?.[0]?.isStage ? runtime.targets[0] : runtime?.getTargetForStage?.();
    if (current !== stage || current?.variables !== variables) {
      stage=current;variables=current?.variables;
      names=new Map(Object.entries(variables ?? {}).map(([id,value]) => [value.name,id]));
    }
    const value = name => variables?.[names.get(name)]?.value;
    const cloud = value('#r:最新クラウド変数');
    const settings = value('7システム設定');
    const signature = [stage,variables,cloud,...(Array.isArray(cloud)?cloud.slice(0,10):[]),
      value('地図過去表示モード'),value('描画更新-地図'),settings,...SETTINGS.map(index => settings?.[index])];
    for (const name of SOURCE_LISTS) {const list=value(name);signature.push(list,list?.length);}
    return signature;
  }
  function bubbleRectangles(view) {
    const result = [];
    for (const bubble of doc.querySelectorAll('.eew-community-bubble')) {
      const rect = bubble.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      result.push({left:rect.left-view.canvasRect.left,top:rect.top-view.canvasRect.top,
        width:rect.width,height:rect.height});
    }
    return result;
  }
  function draw(view,placements,protectedRects,ratio) {
    if (!context) return;
    context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,view.width,view.height);
    const lines=[];
    for (const point of placements) {
      const x=Math.max(point.x,Math.min(point.x+point.width,point.anchor.x));
      const y=Math.max(point.y,Math.min(point.y+point.height,point.anchor.y));
      if (Math.hypot(x-point.anchor.x,y-point.anchor.y)<1) continue;
      lines.push({x,y,anchor:point.anchor,id:point.id,left:Math.min(x,point.anchor.x)-2,
        top:Math.min(y,point.anchor.y)-2,right:Math.max(x,point.anchor.x)+2,bottom:Math.max(y,point.anchor.y)+2});
    }
    if (!lines.length) return;
    // Use the same native UI margins as the marker boxes. A displaced point
    // near the map edge must not draw its leader through the clock or toolbar.
    const scaleX=Math.max(1,view.layout.uiScale*view.width/view.stage.width);
    const scaleY=Math.max(1,view.layout.uiScale*view.height/view.stage.height);
    const left=view.viewport.left+30*scaleX,top=view.viewport.top+34*scaleY;
    context.save();context.beginPath();context.rect(left,top,Math.max(0,view.viewport.right-left),Math.max(0,view.viewport.bottom-top));context.clip();
    context.lineWidth=1;
    for (const line of lines) {
      context.strokeStyle=line.id===selection.id&&selection.playing?'rgba(134,224,172,.75)':'rgba(177,207,224,.6)';
      context.beginPath();context.moveTo(line.anchor.x,line.anchor.y);context.lineTo(line.x,line.y);context.stroke();
    }
    // Thin leaders, as well as boxes, yield to native values and report bubbles.
    const toolbar={left:view.viewport.left,top:view.viewport.bottom-116*scaleY,
      width:44*scaleX,height:116*scaleY};
    for (const rect of [...protectedRects,toolbar]) {
      const left=Number(rect.left??rect.x),top=Number(rect.top??rect.y);
      const width=Number(rect.width??Number(rect.right)-left),height=Number(rect.height??Number(rect.bottom)-top);
      if (![left,top,width,height].every(Number.isFinite)) continue;
      if (lines.some(line => left-1.5<line.right&&left+width+1.5>line.left&&top-1.5<line.bottom&&top+height+1.5>line.top)) {
        context.clearRect(left-1.5,top-1.5,width+3,height+3);
      }
    }
    context.restore();
  }
  function render(time) {
    const machine=vm(),view=read(machine);
    const unavailable=['loading','error','launch'].some(id => {const node=doc.getElementById(id);return node&&!node.hidden;});
    if (unavailable || !view || view.settled !== true || String(view.dialog??'')!=='' ||
      ![0,1,2].includes(Number(view.tab)) || !(view.viewport?.width>0&&view.viewport?.height>0)) {
      hide(view&&view.settled!==true?'settling':'unavailable');
      return view&&view.settled!==true ? FRAME_MS : IDLE_MS;
    }
    const geometry=[view.canvas,view.width,view.height,view.canvasRect.left,view.canvasRect.top,
      view.stage.width,view.stage.height,view.camera.x,view.camera.y,view.camera.zoom,
      view.layout.offsetX,view.layout.offsetY,view.layout.halfWidth,view.layout.halfHeight,view.layout.uiScale,
      view.viewport.left,view.viewport.top,view.viewport.width,view.viewport.height,view.tab,view.mapMode];
    if (lastGeometry&&!same(geometry,lastGeometry)) motionUntil=time+750;
    lastGeometry=geometry;
    const source=sourceSignature(machine);
    if (!same(geometry,obstacleGeometry) || !same(source,obstacleSource) || time-obstacleAt>=OBSTACLE_MS) {
      obstacles=readMapObstacles(machine,view);obstacleAt=time;obstacleGeometry=geometry;obstacleSource=source;obstacleVersion++;
    }
    const bubbles=bubbleRectangles(view);
    const ratio=Math.min(globalThis.devicePixelRatio||1,2);
    const key=JSON.stringify([geometry.slice(1),obstacleVersion,bubbles,selection,ratio]);
    if (key!==lastRender) {
      lastRender=key;
      const protectedRects=[...obstacles,...bubbles];
      const placements=layout(cameras,view,protectedRects,{activeId:selection.id});
      Object.assign(layer.style,{left:`${view.canvasRect.left}px`,top:`${view.canvasRect.top}px`,width:`${view.width}px`,height:`${view.height}px`});
      if (canvas.width!==Math.round(view.width*ratio)||canvas.height!==Math.round(view.height*ratio)) {
        canvas.width=Math.round(view.width*ratio);canvas.height=Math.round(view.height*ratio);
      }
      const visible=new Set();
      for (const placement of placements) {
        if (!placement.camera || ![placement.x,placement.y,placement.width,placement.height].every(Number.isFinite)) continue;
        const camera=placement.camera,entry=nodes.get(camera.id)??createMarker(camera),button=entry.button;
        visible.add(camera.id);button.hidden=false;
        const position=[placement.x,placement.y,placement.width,placement.height].join(',');
        if (position!==entry.position) {
          entry.position=position;Object.assign(button.style,{left:`${placement.x}px`,top:`${placement.y}px`,width:`${placement.width}px`,height:`${placement.height}px`});
        }
        const selected=camera.id===selection.id,playing=selected&&selection.playing;
        const label=`${camera.region?`${camera.region}・`:''}${camera.label}のカメラ。位置は撮影対象地域の概略です。${selected?'選択中。':''}${playing?'再生中。':''}押すと映像を開きます。`;
        if (label!==entry.label) {entry.label=label;button.setAttribute('aria-label',label);}
        button.setAttribute('aria-pressed',String(selected));button.dataset.selected=String(selected);button.dataset.playing=String(playing);
      }
      for (const [id,entry] of nodes) if (!visible.has(id)) entry.button.hidden=true;
      draw(view,placements,protectedRects,ratio);
      layer.hidden=visible.size===0;layer.dataset.visibleCount=String(visible.size);layer.dataset.state='ready';
    }
    return time<motionUntil||bubbles.length ? FRAME_MS : IDLE_MS;
  }
  function tick() {
    timer=null;
    if (!runnable()) {hide('paused');return;}
    lastFrame=now();let delay=IDLE_MS;
    try {delay=render(lastFrame);} catch {hide('unavailable');}
    schedule(delay);
  }
  function interaction(event) {
    if (event.type==='keydown') {
      if (event.target?.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target?.tagName??'')) return;
    } else if (!event.target?.closest?.('#app') && !layer.contains(event.target)) return;
    if (event.type==='pointermove'&&!event.buttons) return;
    wake();
  }
  function changed() {hide('settling');wake();}
  function visibility() {if (doc.hidden) {cancelTimer();resetPresses();hide('hidden');}else wake();}
  function pagehide() {paused=true;cancelTimer();resetPresses();hide('hidden');}
  function pageshow() {paused=false;wake();}
  for (const name of ['pointerdown','pointerup','pointermove','wheel','keydown']) listen(doc,name,interaction,{capture:true,passive:true});
  for (const name of ['pointerup','pointercancel','mouseup','touchend','touchcancel']) listen(doc,name,resetPresses,{passive:true});
  for (const name of ['eew-layout-change','eew-camera-layout']) listen(doc,name,changed);
  for (const name of ['eew-community-map-state','eew-community-report']) listen(doc,name,wake);
  listen(doc,'visibilitychange',visibility);listen(globalThis,'resize',changed);
  listen(globalThis,'pagehide',pagehide);listen(globalThis,'pageshow',pageshow);listen(globalThis,'blur',resetPresses);
  layer.dataset.enabled='true';wake();
  return {
    setSelection({id=null,playing=false}={}) {
      if (stopped) return;
      const next={id:typeof id==='string'&&id?id:null,playing:Boolean(playing)};
      if (next.id===selection.id&&next.playing===selection.playing) return;
      selection=next;layer.dataset.selectedId=next.id??'';layer.dataset.playingId=next.playing?next.id??'':'';lastRender='';wake();
    },
    setEnabled(value) {
      if (stopped||enabled===Boolean(value)) return;
      enabled=Boolean(value);layer.dataset.enabled=String(enabled);
      if (enabled) wake();else {cancelTimer();resetPresses();hide('disabled');}
    },
    wake,
    stop() {
      if (stopped) return;
      stopped=true;cancelTimer();for (const remove of listeners) remove();resetPresses();nodes.clear();layer.remove();
    },
  };
}
