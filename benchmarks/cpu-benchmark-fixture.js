/* Local synthetic regression inputs for the real, unmodified native project. */
(() => {
  if(globalThis.cpuFixture)return;
  const stage=()=>globalThis.vm?.runtime?.getTargetForStage?.();
  const variable=name=>Object.values(stage()?.variables??{}).find(item=>item.name===name);
  const value=name=>variable(name)?.value;
  const set=(name,data)=>{const item=variable(name);if(!item)throw new Error(`Missing native variable: ${name}`);item.value=data;if(item.type==='list')item._monitorUpToDate=false;};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const epoch=Date.UTC(2000,0,1);
  const seconds=()=>{
    const sensing=globalThis.vm?.runtime?._primitives?.sensing_dayssince2000;
    return sensing?Number(sensing())*86400+Number(value('時間オフセット')||0):(Date.now()-epoch)/1000;
  };
  const broadcasts=name=>globalThis.vm.runtime.startHats('event_whenbroadcastreceived',{BROADCAST_OPTION:name});
  let sequence=0, heartbeat=null, busy=false, currentCase=null, lastResult=null;
  const pendingBlocks=[];
  const audit={heartbeats:0,cloudEchoes:0,lastHeader:null,procedureCalls:[],speechProbe:null};

  async function ready(timeoutMs=60000) {
    const deadline=performance.now()+timeoutMs;
    while(performance.now()<deadline){
      if(globalThis.cpuBenchmark?.attach()&&Array.isArray(value('0EEW'))&&value('0EEW').length>=140&&
        Array.isArray(value('9-2津波エリア情報'))&&value('9-2津波エリア情報').length>=528&&
        document.getElementById('loading')?.hidden)return true;
      await wait(100);
    }
    throw new Error('Native project initialization timed out');
  }
  function invokeProcedure(name,args=[],targetName='受信と検出') {
    const runtime=vm.runtime,target=runtime.targets.find(item=>item.isOriginal&&item.getName?.()===targetName);
    const blocks=target?.blocks;
    const definition=Object.values(blocks?._blocks??{}).find(item=>item.opcode==='procedures_prototype'&&item.mutation?.proccode===name);
    if(!definition)throw new Error(`Missing native procedure: ${targetName}/${name}`);
    const ids=JSON.parse(definition.mutation.argumentids??'[]');
    const id=`cpu-local-${++sequence}`, inputs={};
    for(let index=0;index<ids.length;index++){
      const shadow=`${id}-arg-${index}`;
      blocks.createBlock({id:shadow,opcode:'text',next:null,parent:id,inputs:{},fields:{TEXT:{name:'TEXT',value:String(args[index]??'')}},shadow:true,topLevel:false});
      inputs[ids[index]]={name:ids[index],block:shadow,shadow};
    }
    blocks.createBlock({id,opcode:'procedures_call',next:null,parent:null,inputs,fields:{},topLevel:true,shadow:false,
      mutation:{...definition.mutation}});
    const thread=runtime._pushThread(id,target);
    pendingBlocks.push({id,blocks,thread});
    audit.procedureCalls.push({name,args:args.map(arg=>String(arg).slice(0,24)),at:Date.now()});
    return thread;
  }
  function cleanupBlocks() {
    for(let index=pendingBlocks.length-1;index>=0;index--){
      const item=pendingBlocks[index];
      if(vm.runtime.isActiveThread(item.thread))continue;
      item.blocks.deleteBlock(item.id);pendingBlocks.splice(index,1);
    }
  }
  function pulseHeartbeat() {
    const now=Math.floor(seconds()), header=Array(256).fill('0');
    const timestamp=String(now).padStart(10,'0');
    timestamp.split('').forEach((digit,index)=>header[index]=digit);
    const version=String(value('#バージョン照合')??'28').padStart(2,'0').slice(-2);
    header[42]=version[0];header[43]=version[1];
    // Cloud IO is the same input method used by the packaged cloud provider.
    // The native forever loop performs parsing and clock changes afterwards.
    const encoded=header.join('');
    // c2h advances the receiver clock, whereas the map's visible clock reads
    // the leading timestamp of cloud stream 3 (c2b0..7 in this short format).
    // A timestamp-only payload deliberately contains no fabricated station data.
    vm.postIOData('cloud',{varUpdate:{name:'☁ c2b0',value:`0${timestamp}`}});
    vm.postIOData('cloud',{varUpdate:{name:'☁ c2h',value:encoded}});
    audit.heartbeats++;audit.lastHeader=encoded.slice(0,50);
    const echo=String(100000+(audit.heartbeats%100000));
    vm.postIOData('cloud',{varUpdate:{name:'☁ c2u',value:echo}});
    if(String(value('☁ c2u'))===echo)audit.cloudEchoes++;
  }
  function startHeartbeat() {
    stopHeartbeat();
    // Short header format requires a shared leading consistency digit.
    for(let index=0;index<8;index++)vm.postIOData('cloud',{varUpdate:{name:`☁ c2b${index}`,value:'0'}});
    pulseHeartbeat();heartbeat=setInterval(pulseHeartbeat,1000);
  }
  function stopHeartbeat(){if(heartbeat!==null)clearInterval(heartbeat);heartbeat=null;}
  function tsunamiPacket({levels=[3,4,2,2,0,0],cancel=false}={}) {
    const now=Math.floor(seconds()), packet=Array(474).fill('0');
    const write=(start,text)=>String(text).split('').forEach((char,index)=>packet[start-1+index]=char);
    write(1,String(now).padStart(10,'0'));
    for(let index=0;index<66;index++){
      write(11+index,String(cancel?0:levels[index]??0));
      write(77+index*3,cancel?'999':'002');
    }
    write(275,'0');write(276,String(Math.floor(now/600)).padStart(7,'0'));
    for(let index=0;index<5;index++){
      write(283+index*3,index?'000':'563');write(298+index*3,index?'000':'420');
      write(313+index*3,index?'000':'192');write(328+index*2,index?'00':'78');
      write(338+index*3,index?'999':'030');
      write(353+index*8,String(Math.floor((now-20)/60)).padStart(8,'0'));
      write(393+index*2,String(index+1).padStart(2,'0'));
    }
    write(408,'0');
    return packet.join('');
  }
  function tsunami(options) {
    const packet=tsunamiPacket(options);
    invokeProcedure('津波情報受信 %s',[packet]);
    set('タブ',2);set('地図表示モード',3);
    broadcasts('タブ切り替え');broadcasts('タブ更新');
    earthquakeRecording.setCamera({lat:42.5,lon:142.3,zoom:4.2});
    return packet.length;
  }
  async function prepare(name='normal') {
    if(!['normal','eew','tsunami'].includes(name))throw new TypeError('Use normal, eew, or tsunami');
    await ready();stopHeartbeat();
    earthquakeRecording.clear();earthquakeRecording.dismissDialogs();
    set('9津波関連',[0,0,'','',0,0,'','','','','','','',0]);
    set('9-2津波エリア情報',Array(528).fill(''));
    set('9-2-1前回津波高さ',Array(66).fill(''));
    set('tsu: 地図表示集',[]);
    earthquakeRecording.setTab(1);
    earthquakeRecording.setCamera({lat:42.5,lon:142.3,zoom:4.2});
    currentCase=name;
    startHeartbeat();
    await wait(500);
    if(name==='eew')earthquakeRecording.startEvent({report:1,lat:42,lon:142.3,maximum:6,magnitude:6.8});
    else if(name==='tsunami')tsunami();
    await wait(2000);cleanupBlocks();
    return inspect();
  }
  function inspect() {
    const optimizer=globalThis.cpuTestMapEfficiency;
    return {synthetic:true,case:currentCase,audit:structuredClone(audit),native:cpuBenchmark.state(),graphics:cpuBenchmark.graphics(),
      isolated:structuredClone(globalThis.cpuIsolation??null),videoFrames:document.querySelectorAll('.eew-camera-player iframe').length,
      optimization:optimizer?{active:optimizer.active,cacheActive:optimizer.cacheActive,stats:{...optimizer.stats}}:null};
  }
  function speechProbe(words='これは計測用の模擬データです。') {
    const target=vm.runtime.targets.find(item=>item.isOriginal&&item.getName?.()==='効果音&読み上げ');
    const primitive=vm.runtime._primitives.text2speech_speakAndWait;
    if(!target||typeof primitive!=='function')throw new Error('Native TTS primitive is unavailable');
    const result={startedAt:Date.now(),completedAt:null,failed:false,words};audit.speechProbe=result;
    Promise.resolve(primitive({WORDS:words},{target,stackFrame:{}})).then(()=>{result.completedAt=Date.now();},()=>{result.failed=true;});
    return result;
  }
  async function run(name='normal',{durationMs=20000,drawFps=15,profileProcedures=false,probeSpeech=false,save=true,prepared=false}={}) {
    if(busy)throw new Error('One comparison run at a time');
    if(!Number.isFinite(durationMs)||durationMs<5000||durationMs>120000)throw new RangeError('Use a 5–120 second measurement');
    busy=true;
    try{
      if(prepared){await ready();if(currentCase!==name)throw new Error('Prepare the matching case before a prepared measurement');}
      else await prepare(name);
      const start=inspect();
      cpuBenchmark.start({drawFps,profileProcedures,label:`${globalThis.cpuVariant??'unknown'}:${name}`});
      if(probeSpeech)speechProbe();
      await wait(durationMs);
      const measurement=cpuBenchmark.stop(),end=inspect();
      const initial=start.native,final=end.native;
      const result={schema:1,baseline:globalThis.cpuBaseline,variant:globalThis.cpuVariant,case:name,
        measuredAt:new Date().toISOString(),measurement,start,end,
        checks:{cloudIOAdvanced:end.audit.cloudEchoes>start.audit.cloudEchoes,
          nativeReceiveAdvanced:Number(final.receiveSeconds)>Number(initial.receiveSeconds),
          nativeClockChanged:final.nativeClock!==initial.nativeClock,
          vmClockAdvanced:final.projectTimer>initial.projectTimer,
          eewActive:name==='eew'?Number(final.eew?.[0])===1:null,
          tsunamiActive:name==='tsunami'?Number(final.tsunami?.[0])>0&&final.tsunamiSegments>0:null,
          noVideoDecoder:end.videoFrames===0},
        proofLimits:['Inputs are local synthetic data. No production/cloud delivery is tested.',
          'JavaScript durations are elapsed wall time, not renderer-thread CPU. Use CDP threadTicks alongside this result.',
          'TTS Promise completion alone is not audible proof: native TTS catches network errors. Check ttsOK, audio.decode/audioStarts, and listen.']};
      lastResult=result;
      if(save)try{result.saved=await(await fetch('/cpu-results',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)})).json();}catch(error){result.saveError=String(error);}
      return result;
    }finally{cpuBenchmark.stop();busy=false;}
  }
  globalThis.cpuFixture={ready,prepare,run,inspect,pulseHeartbeat,startHeartbeat,stopHeartbeat,tsunami,tsunamiPacket,invokeProcedure,speechProbe,
    get result(){return lastResult;},dispose(){stopHeartbeat();cpuBenchmark.stop();cleanupBlocks();}};
  addEventListener('pagehide',stopHeartbeat,{once:true});
})();
