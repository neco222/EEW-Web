/* Ignored, local-only observation hooks. No project files are changed. */
(() => {
  if (globalThis.cpuBenchmark) return;
  const now = () => performance.now();
  const metrics = new Map();
  const patches = [];
  const stack = [];
  const registeredProcedures = new WeakSet();
  let runtime = null, renderer = null, running = false, startedAt = 0;
  let drawFps = 15, drawDue = 0, profileProcedures = false;
  let drawAttempts = 0, dirtyDraws = 0, throttledDraws = 0, cleanDraws = 0;
  let actualFrames = 0;
  let speechStarted = 0, speechCompleted = 0, speechFailed = 0, audioStarts = 0;
  let label = '', firstState = null, sampleTimer = null, lastResult = null, runGeneration=0;
  const speechLog = [];
  const getMetric = key => {
    if (!metrics.has(key)) metrics.set(key, {calls:0,totalMs:0,selfMs:0,maxMs:0});
    return metrics.get(key);
  };
  function measured(key, fn, self, args) {
    if (!running) return Reflect.apply(fn, self, args);
    const metric = getMetric(key), frame = {started:now(),children:0};
    stack.push(frame);
    try { return Reflect.apply(fn, self, args); }
    finally {
      const elapsed = now() - frame.started;
      stack.pop();
      metric.calls++; metric.totalMs += elapsed;
      metric.selfMs += Math.max(0,elapsed-frame.children);
      metric.maxMs = Math.max(metric.maxMs,elapsed);
      if(stack.length) stack[stack.length-1].children += elapsed;
    }
  }
  function patch(object,key,make) {
    if (!object || typeof object[key] !== 'function') return;
    if (patches.some(item=>item.object===object&&item.key===key&&object[key]===item.wrapper)) return;
    const original=object[key], wrapper=make(original);
    object[key]=wrapper; patches.push({object,key,original,wrapper});
  }
  function graphics() {
    const gl=(globalThis.vm?.runtime?.renderer??renderer)?._gl;
    if(!gl)return {available:false};
    try {
      const ext=gl.getExtension('WEBGL_debug_renderer_info');
      const info={available:true,vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),
        version:gl.getParameter(gl.VERSION),unmaskedVendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):null,
        unmaskedRenderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,
        attributes:gl.getContextAttributes(),contextLost:gl.isContextLost(),
        drawingBuffer:{width:gl.drawingBufferWidth,height:gl.drawingBufferHeight}};
      const text=String(info.unmaskedRenderer??info.renderer);
      info.softwareRenderer=/swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render/i.test(text);
      info.cpuOnlyEvidence=info.softwareRenderer?'software-renderer-reported':'not-established';
      return info;
    }catch(error){return {available:false,error:String(error)};}
  }
  function stageValue(name) {
    const stage=runtime?.getTargetForStage?.();
    return Object.values(stage?.variables??{}).find(item=>item.name===name)?.value;
  }
  function state() {
    const receiving=runtime?.targets?.find(target=>target.isOriginal&&target.getName?.()==='受信と検出');
    const read=name=>Object.values(receiving?.variables??{}).find(item=>item.name===name)?.value;
    return {at:Date.now(),projectTimer:runtime?.ioDevices?.clock?.projectTimer?.(),
      currentMSecs:runtime?.currentMSecs,tab:stageValue('タブ'),mapMode:stageValue('地図表示モード'),
      nativeClock:stageValue('6-4地図エリア表示内容')?.[0],receiveSeconds:read('ca:受信用2000s'),
      latestCloud:stageValue('#r:最新クラウド変数')?.[0],eew:stageValue('0EEW')?.slice(0,14),
      tsunami:stageValue('9津波関連')?.slice(0,14),tsunamiSegments:stageValue('tsu: 地図表示集')?.length,
      speechQueueLength:stageValue('効果音キュー')?.length,
      threadCount:runtime?.threads?.length,compiledThreads:runtime?.threads?.filter(item=>item.isCompiled).length};
  }
  function primitiveHooks() {
    const primitives=runtime?._primitives;
    if(!primitives)return;
    patch(primitives,'text2speech_speakAndWait',original=>function(...args){
      const active=running, generation=runGeneration;
      if(active){speechStarted++;speechLog.push({atMs:now()-startedAt,words:String(args[0]?.WORDS??'').slice(0,100)});}
      let result;
      try{result=measured('speech.dispatch',original,this,args);}catch(error){if(active)speechFailed++;throw error;}
      if(active&&result?.then)Promise.resolve(result).then(()=>{if(running&&generation===runGeneration)speechCompleted++;},()=>{if(running&&generation===runGeneration)speechFailed++;});
      return result;
    });
  }
  function procedureHooks(thread) {
    if(!profileProcedures||!thread?.procedures||registeredProcedures.has(thread.procedures))return;
    registeredProcedures.add(thread.procedures);
    const target=thread.target?.getName?.()??'unknown';
    for(const [key,fn]of Object.entries(thread.procedures)) {
      if(typeof fn!=='function'||!/地図|描画|EEW|クラウド|津波|受信|読み上げ|日付/.test(key))continue;
      const name=`proc:${target}:${key}`;
      patch(thread.procedures,key,original=>function(...args){
        if(!profileProcedures)return Reflect.apply(original,this,args);
        const result=measured(name,original,this,args);
        // Yielding compiled procedures perform their work in iterator.next().
        // Preserve the original iterator and only time its advancing methods.
        if(result&&typeof result.next==='function')for(const method of ['next','throw','return'])
          patch(result,method,advance=>function(...values){return measured(name,advance,this,values);});
        return result;
      });
    }
  }
  function attach(vm=globalThis.vm) {
    const candidate=vm?.runtime;
    if(!candidate?.renderer)return false;
    if(runtime===candidate){primitiveHooks();return true;}
    if(runtime)throw new Error('Reload between project/VM replacements for comparable runs');
    runtime=candidate;renderer=runtime.renderer;
    patch(runtime,'_step',original=>function(...args){return measured('vm.step',original,this,args);});
    patch(runtime.sequencer,'stepThreads',original=>function(...args){return measured('vm.threads',original,this,args);});
    patch(runtime.sequencer,'stepThread',original=>function(thread,...args){
      procedureHooks(thread);
      return measured(`thread:${thread?.target?.getName?.()??'unknown'}`,original,this,[thread,...args]);
    });
    for(const method of ['penClear','penStamp','penPoint','penLine'])
      patch(renderer,method,original=>function(...args){return measured(`renderer.${method}`,original,this,args);});
    patch(renderer,'_drawThese',original=>function(ids,mode,...args){
      // penStamp and sensing also call _drawThese: count only the real canvas
      // presentation pass, below any optimization's renderer.draw wrapper.
      const presented=running&&ids===this._drawList&&mode==='default';
      const result=Reflect.apply(original,this,[ids,mode,...args]);
      if(presented)actualFrames++;
      return result;
    });
    patch(renderer,'draw',original=>function(...args){
      if(!running)return Reflect.apply(original,this,args);
      drawAttempts++;
      if(!this.dirty)cleanDraws++;
      else {
        const time=now();
        if(drawFps>0&&time<drawDue){throttledDraws++;return;}
        if(drawFps>0){const period=1000/drawFps;drawDue+=(Math.floor(Math.max(0,time-drawDue)/period)+1)*period;}
        dirtyDraws++;
      }
      return measured('renderer.draw',original,this,args);
    });
    patch(runtime.ioDevices?.cloud,'postData',original=>function(...args){return measured('cloud.postData',original,this,args);});
    patch(runtime.ioDevices?.cloud,'updateCloudVariable',original=>function(...args){return measured('cloud.updateVariable',original,this,args);});
    patch(runtime.audioEngine,'decodeSoundPlayer',original=>function(...args){return measured('audio.decode',original,this,args);});
    if(globalThis.AudioBufferSourceNode)patch(AudioBufferSourceNode.prototype,'start',original=>function(...args){
      if(running)audioStarts++;
      return measured('audio.start',original,this,args);
    });
    primitiveHooks();
    runtime.on?.('EXTENSION_ADDED',primitiveHooks);
    runtime.on?.('PROJECT_LOADED',primitiveHooks);
    return true;
  }
  function snapshot() {
    const elapsedMs=running?now()-startedAt:lastResult?.elapsedMs??0;
    const measurements=Object.fromEntries([...metrics].map(([key,value])=>[key,{...value,
      callsPerSecond:elapsedMs?value.calls*1000/elapsedMs:0}]));
    return {schema:1,label,running,elapsedMs,drawFps,profileProcedures,
      timingMeaning:'wall-clock JavaScript inclusive and child-instrumentation-exclusive time; not OS CPU/GPU time',
      warning:profileProcedures?'Detailed procedure profiling adds overhead; compare matching settings only.':null,
      userAgent:navigator.userAgent,visibility:document.visibilityState,devicePixelRatio,
      viewport:{width:innerWidth,height:innerHeight},graphics:graphics(),
      vm:{framerate:runtime?.frameLoop?.framerate,stepTime:runtime?.currentStepTime,
        interpolation:runtime?.interpolationEnabled,compiler:runtime?.compilerOptions},
      draw:{attempts:drawAttempts,dirtyDraws,throttled:throttledDraws,cleanCalls:cleanDraws,
        dirtyFps:elapsedMs?dirtyDraws*1000/elapsedMs:0,actualFrames,
        actualFps:elapsedMs?actualFrames*1000/elapsedMs:0},
      speech:{started:speechStarted,completed:speechCompleted,failed:speechFailed,audioStarts,log:[...speechLog]},
      transport:structuredClone(globalThis.cpuIsolation??null),
      measurements,firstState,currentState:state()};
  }
  function publish() {
    let node=document.getElementById('cpu-benchmark-json');
    if(!node&&document.body){node=document.createElement('script');node.type='application/json';node.id='cpu-benchmark-json';document.body.append(node);}
    if(node)node.textContent=JSON.stringify(snapshot());
  }
  function start({drawFps:fps=15,profileProcedures:profile=false,label:name=''}={}) {
    if(running)throw new Error('A measurement is already running');
    if(!attach())throw new Error('Native VM/renderer is not ready');
    if(!Number.isFinite(fps)||fps<0||fps>240)throw new TypeError('drawFps must be 0 (unlimited) or <=240');
    drawFps=fps;profileProcedures=Boolean(profile);label=String(name);
    metrics.clear();speechLog.length=0;
    drawAttempts=dirtyDraws=throttledDraws=cleanDraws=actualFrames=0;
    speechStarted=speechCompleted=speechFailed=audioStarts=0;
    firstState=state();startedAt=now();drawDue=startedAt;runGeneration++;running=true;
    publish();sampleTimer=setInterval(publish,1000);
    return snapshot();
  }
  function stop() {
    if(!running)return lastResult??snapshot();
    const result=snapshot();running=false;clearInterval(sampleTimer);sampleTimer=null;
    lastResult={...result,running:false};publish();return lastResult;
  }
  function dispose() {
    stop();runtime?.removeListener?.('EXTENSION_ADDED',primitiveHooks);runtime?.removeListener?.('PROJECT_LOADED',primitiveHooks);
    for(const {object,key,original,wrapper}of patches.reverse())if(object[key]===wrapper)object[key]=original;
    patches.length=0;document.getElementById('cpu-benchmark-json')?.remove();
  }
  globalThis.cpuBenchmark={attach,graphics,state,start,stop,snapshot,publish,dispose};
  const watcher=setInterval(()=>{if(attach())clearInterval(watcher);},20);
  addEventListener('pagehide',()=>{clearInterval(watcher);stop();},{once:true});
})();
