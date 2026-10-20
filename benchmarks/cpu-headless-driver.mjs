// Local performance test only. Does not drive or interact with a browser UI.
import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,appendFile,access} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';

const folder=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2),option=(key,fallback)=>args.find(arg=>arg.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
const chromePath=option('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const origin=option('origin','http://127.0.0.1:4192');
const cases=option('cases','normal,eew,tsunami').split(',');
const variants=option('variants','baseline,optimized').split(',');
const durationMs=Number(option('duration','20000'));
const profileProcedures=option('profile-procedures','false')==='true';
const probeSpeech=option('speech','false')==='true';
const identifier=`${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}`;
const directory=path.join(folder,'cpu-headless',identifier),profile=path.join(directory,'profile');
await mkdir(profile,{recursive:true});
const requestPath=path.join(directory,'sample-request.txt'),stopPath=path.join(directory,'sampler-stop.txt');
const evidence={schema:1,startedAt:new Date().toISOString(),directory,profile,chromePath,origin,durationMs,cases,variants,profileProcedures,probeSpeech,results:[],errors:[],processSampling:{scope:'Dedicated Chrome root and observed descendants, including its SwiftShader GPU process. Cumulative last-observed OS process CPU seconds.',limitations:['A process created and terminated between one-second tree samples could be missed.','The sampler process and other system activity are outside this scoped CPU count.']}};
async function sourceIdentity(){const identity={head:execFileSync('git',['rev-parse','HEAD'],{cwd:path.join(folder,'..'),encoding:'utf8'}).trim(),files:{}};for(const file of ['runtime-efficiency.js','map-render-efficiency.js','viewer-entry.js','index.js','assets/project.json']){try{const bytes=await readFile(path.join(folder,'..','docs',file));identity.files[file]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}catch{identity.files[file]=null;}}return identity;}
evidence.sourceAtStart=await sourceIdentity();
const launchArgs=['--headless=new','--use-angle=swiftshader','--enable-unsafe-swiftshader','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-sync','--metrics-recording-only','--disable-features=OptimizationHints,MediaRouter','--autoplay-policy=no-user-gesture-required','--window-size=1280,720','about:blank'];
evidence.launchArgs=launchArgs;
const chrome=spawn(chromePath,launchArgs,{windowsHide:true,stdio:['ignore','ignore','pipe']});
evidence.browserRootPid=chrome.pid;
let chromeLog='',sampler=null,connection=null,samplerLog='',sampleSequence=0;
const samples=[],samplePending=new Map();
chrome.stderr.on('data',chunk=>{chromeLog+=chunk.toString();});
chrome.on('error',error=>{evidence.errors.push({phase:'chrome-start',message:String(error)});});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const save=()=>writeFile(path.join(directory,'result.json'),JSON.stringify(evidence,null,2));

class CDP {
  constructor(socket){this.socket=socket;this.sequence=0;this.pending=new Map();this.events=[];
    socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.id){const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timeout);message.error?pending.reject(new Error(JSON.stringify(message.error))):pending.resolve(message.result);}else if(/exceptionThrown|consoleAPICalled/.test(message.method)){if(this.events.length<80)this.events.push(message);}});
    socket.addEventListener('close',()=>{for(const item of this.pending.values()){clearTimeout(item.timeout);item.reject(new Error('Dedicated Chrome CDP connection closed'));}this.pending.clear();});
  }
  send(method,params={},sessionId,timeoutMs=90000){const id=++this.sequence;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},timeoutMs);this.pending.set(id,{resolve,reject,timeout});this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{} )}));});}
  async evaluate(expression,sessionId,timeoutMs=90000){const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId,timeoutMs);if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
}
async function startSampler(){
  sampler=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(folder,'cpu-process-sampler.ps1'),'-BrowserRootPid',String(chrome.pid),'-ProfileDirectory',profile,'-RequestPath',requestPath,'-StopPath',stopPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  sampler.stderr.on('data',chunk=>{samplerLog+=chunk.toString();});
  createInterface({input:sampler.stdout}).on('line',line=>{try{const item=JSON.parse(line);samples.push(item);if(item.request&&samplePending.has(item.request)){samplePending.get(item.request)(item);samplePending.delete(item.request);}appendFile(path.join(directory,'process-samples.jsonl'),JSON.stringify(item)+'\n').catch(()=>{});}catch{samplerLog+=line+'\n';}});
  sampler.on('exit',code=>{if(code)evidence.errors.push({phase:'process-sampler',message:`exit ${code}`,details:samplerLog});});
  return sample('ready');
}
async function sample(label){
  const token=`${++sampleSequence}:${label}`;
  const response=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{samplePending.delete(token);reject(new Error(`OS sample timeout: ${label}: ${samplerLog}`));},15000);samplePending.set(token,value=>{clearTimeout(timeout);resolve(value);});});
  await writeFile(requestPath,token);return response;
}
function metricsMap(value){return Object.fromEntries(value.metrics.map(item=>[item.name,item.value]));}
function cpuDifference(start,end){const wallSeconds=(Date.parse(end.at)-Date.parse(start.at))/1000,cpuSeconds=end.totalCpuSeconds-start.totalCpuSeconds;return {wallSeconds,cpuSeconds,oneCorePercent:cpuSeconds/wallSeconds*100,logicalProcessorNormalizedPercent:cpuSeconds/wallSeconds/end.logicalProcessors*100,logicalProcessors:end.logicalProcessors,start,end};}
try{
  await access(chromePath);
  let endpoint;
  for(let attempt=0;attempt<150;attempt++){
    try{const [port,pathname]=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);endpoint=`ws://127.0.0.1:${port}${pathname}`;break;}catch{}
    if(chrome.exitCode!==null)throw new Error(`Dedicated Chrome exited: ${chrome.exitCode}: ${chromeLog.slice(-3000)}`);
    await wait(100);
  }
  if(!endpoint)throw new Error('Dedicated Chrome did not publish DevToolsActivePort');
  const socket=new WebSocket(endpoint);await once(socket,'open');connection=new CDP(socket);
  evidence.browserVersion=await connection.send('Browser.getVersion');
  evidence.environment=await(await fetch(`${origin}/cpu-environment.json`)).json();
  await startSampler();
  for(const variant of variants){
    if(!['baseline','optimized'].includes(variant))throw new Error(`Invalid benchmark variant: ${variant}`);
    const {targetId}=await connection.send('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await connection.send('Target.attachToTarget',{targetId,flatten:true});
    await connection.send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false},sessionId);
    await connection.send('Performance.enable',{timeDomain:'threadTicks'},sessionId);
    await connection.send('Runtime.enable',{},sessionId);
    await connection.send('Page.navigate',{url:`${origin}/${variant}/`},sessionId);
    let ready=false;
    for(let attempt=0;attempt<600;attempt++){
      if(await connection.evaluate('Boolean(globalThis.cpuFixture)',sessionId)){ready=true;break;}
      await wait(100);
    }
    if(!ready)throw new Error('Own fixture script did not load');
    await connection.evaluate('cpuFixture.ready(120000)',sessionId,125000);
    const graphics=await connection.evaluate('cpuBenchmark.graphics()',sessionId);
    await connection.evaluate("(async()=>{const m=await import('./map-render-efficiency.js');globalThis.cpuTestMapEfficiency=m.getMapRenderEfficiency(vm);return true})()",sessionId);
    evidence.graphics??={};evidence.graphics[variant]=graphics;await save();
    if(!graphics.softwareRenderer||!/swiftshader/i.test(graphics.unmaskedRenderer??graphics.renderer??''))throw new Error(`CPU-only requirement failed: ${JSON.stringify(graphics)}`);
    console.log(JSON.stringify({phase:'ready',variant,renderer:graphics.unmaskedRenderer}));
    for(const name of cases){
      await connection.evaluate(`cpuFixture.prepare(${JSON.stringify(name)})`,sessionId,60000);
      // Baseline's sole presentation cap lives in the meter; optimized uses the
      // source runtime's cap. The meter observes actual _drawThese in both.
      const drawFps=variant==='baseline'?15:0;
      await connection.evaluate(`cpuBenchmark.start({drawFps:${drawFps},profileProcedures:${profileProcedures}});new Promise(r=>setTimeout(()=>{cpuBenchmark.stop();r(true)},3000))`,sessionId);
      const osStart=await sample(`${variant}:${name}:start`);
      const cdpStart=metricsMap(await connection.send('Performance.getMetrics',{},sessionId));
      const result=await connection.evaluate(`cpuFixture.run(${JSON.stringify(name)},${JSON.stringify({durationMs,drawFps,profileProcedures,probeSpeech,save:false,prepared:true})})`,sessionId,durationMs+20000);
      const cdpEnd=metricsMap(await connection.send('Performance.getMetrics',{},sessionId));
      const osEnd=await sample(`${variant}:${name}:end`);
      const delta={};for(const key of Object.keys(cdpEnd))if(typeof cdpStart[key]==='number')delta[key]=cdpEnd[key]-cdpStart[key];
      const item={variant,case:name,result,optimizer:{start:result.start.optimization,end:result.end.optimization},cdp:{timeDomain:'threadTicks',scope:'Renderer main thread metrics; ProcessTime is renderer process only, excludes the separate SwiftShader GPU service.',start:cdpStart,end:cdpEnd,delta},osChromeTree:cpuDifference(osStart,osEnd)};
      evidence.results.push(item);await save();
      console.log(JSON.stringify({phase:'result',variant,case:name,checks:result.checks,actualFps:result.measurement.draw.actualFps,oneCorePercent:item.osChromeTree.oneCorePercent,threadTime:delta.ThreadTime,processTime:delta.ProcessTime,output:directory}));
    }
    await connection.send('Target.closeTarget',{targetId});
  }
  evidence.complete=true;
}catch(error){evidence.complete=false;evidence.errors.push({phase:'driver',message:String(error),stack:error.stack});console.error(String(error));process.exitCode=1;}
finally{
  evidence.finishedAt=new Date().toISOString();
  evidence.sourceAtEnd=await sourceIdentity();evidence.sourceUnchanged=JSON.stringify(evidence.sourceAtStart)===JSON.stringify(evidence.sourceAtEnd);
  if(!evidence.sourceUnchanged){evidence.complete=false;evidence.errors.push({phase:'source-validation',message:'Source identity changed during the comparison; discard this run.'});process.exitCode=1;}
  if(connection){evidence.runtimeMessages=connection.events;try{await connection.send('Browser.close',{},undefined,5000);}catch{}connection.socket.close();}
  if(chrome.exitCode===null){await Promise.race([once(chrome,'exit'),wait(5000)]);if(chrome.exitCode===null)await new Promise(resolve=>{const child=spawn('taskkill.exe',['/PID',String(chrome.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});child.on('exit',resolve);child.on('error',resolve);});}
  if(sampler){await writeFile(stopPath,'stop');await Promise.race([once(sampler,'exit'),wait(5000)]);if(sampler.exitCode===null)sampler.kill();}
  evidence.cleanup={chromeExited:chrome.exitCode!==null,samplerExited:!sampler||sampler.exitCode!==null,profilesRetained:true,chromeExitCode:chrome.exitCode};
  await writeFile(path.join(directory,'chrome-stderr.log'),chromeLog);await writeFile(path.join(directory,'sampler-stderr.log'),samplerLog);await save();
  console.log(JSON.stringify({phase:'saved',output:path.join(directory,'result.json'),complete:evidence.complete,cleanup:evidence.cleanup}));
}
