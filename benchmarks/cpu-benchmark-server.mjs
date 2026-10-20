import http from 'node:http';
import path from 'node:path';
import {readFile,stat,mkdir,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const folder=path.dirname(fileURLToPath(import.meta.url));
const workspace=path.resolve(folder,'..');
const args=process.argv.slice(2);
const option=(name,fallback)=>args.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const root=path.resolve(workspace,option('root','docs'));
const revision=option('baseline','646037c');
const port=Number(option('port','4192'));
const baselineRuntime=execFileSync('git',['show',`${revision}:docs/runtime-efficiency.js`],{cwd:workspace});
const differences=execFileSync('git',['diff','--name-only',revision,'--','docs'],{cwd:workspace,encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.wav':'audio/wav','.mp3':'audio/mpeg'};
const helpers=new Set(['cpu-benchmark-isolation.js','community-recording-init.js','earthquake-recording-fixture.js','cpu-benchmark-meter.js','cpu-benchmark-fixture.js']);
const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><title>EEW CPU comparison · LOCAL SYNTHETIC</title><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:#0c1520;color:#e6f1fa;font:12px system-ui,sans-serif}header{height:34px;display:flex;align-items:center;gap:10px;padding:0 10px;background:#3a2e15}iframe{display:block;width:1280px;height:720px;border:0}button,select{font:inherit}#cpu-graphics{white-space:pre-wrap;margin:4px 10px}#cpu-results{white-space:pre-wrap;font:11px monospace;margin:4px 10px}</style><header><strong>LOCAL SYNTHETIC CPU TEST</strong><select id="variant"><option>baseline</option><option>optimized</option></select><button id="reload">読込</button><button id="normal">通常 20秒</button><button id="eew">EEW 20秒</button><button id="tsunami">津波 20秒</button><span id="status">準備中</span></header><iframe id="viewer" title="CPU比較専用ビューアー" src="/baseline/"></iframe><pre id="cpu-graphics"></pre><pre id="cpu-results"></pre><script>const frame=document.querySelector('iframe'),status=document.getElementById('status');globalThis.benchmark={frame,get app(){return frame.contentWindow},async run(name,options={}){status.textContent=name+' 測定中';const result=await frame.contentWindow.cpuFixture.run(name,options);status.textContent=name+' 完了';document.getElementById('cpu-results').textContent=JSON.stringify(result);return result;}};document.getElementById('reload').onclick=()=>{frame.src='/'+document.getElementById('variant').value+'/';};for(const name of ['normal','eew','tsunami'])document.getElementById(name).onclick=()=>benchmark.run(name).catch(e=>status.textContent=String(e));setInterval(()=>{try{const app=frame.contentWindow;if(app.cpuBenchmark){document.getElementById('cpu-graphics').textContent=JSON.stringify(app.cpuBenchmark.graphics());if(!app.cpuBenchmark.snapshot().running)status.textContent=app.cpuFixture?'準備完了':'fixture準備中';}}catch{}},1000);</script></html>`;
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='POST'&&url.pathname==='/cpu-results'){
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>4*1024*1024){res.writeHead(413).end();return;}chunks.push(chunk);}
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const directory=path.join(folder,'cpu-results');await mkdir(directory,{recursive:true});
      const name=`${new Date().toISOString().replaceAll(':','-')}-${crypto.randomUUID()}.json`;
      await writeFile(path.join(directory,name),JSON.stringify(result,null,2),{flag:'wx'});
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({saved:name}));return;
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
    if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(req.method==='HEAD'?undefined:html);return;}
    if(url.pathname==='/cpu-environment.json'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({revision,root,differences,baselineOverride:'Only runtime-efficiency.js is taken from the baseline commit; all other files are shared.'}));return;}
    const name=path.posix.basename(url.pathname);
    if(helpers.has(name)){
      const bytes=await readFile(path.join(folder,name));res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'}).end(req.method==='HEAD'?undefined:bytes);return;
    }
    const match=/^\/(baseline|optimized)\/(.*)$/.exec(decodeURIComponent(url.pathname));
    if(!match){res.writeHead(404).end();return;}
    const [,,relativeRaw]=match,variant=match[1],relative=relativeRaw||'index.html';
    const target=path.resolve(root,relative);
    if(!target.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    if(relative==='runtime-efficiency.js'&&variant==='baseline'){
      res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'}).end(req.method==='HEAD'?undefined:baselineRuntime);return;
    }
    if(relative==='index.html'){
      let page=await readFile(target,'utf8');
      const available=[];for(const helper of helpers){try{await stat(path.join(folder,helper));available.push(helper);}catch{}}
      const injection=available.map(name=>`<script src="/${name}"></script>`).join('');
      page=page.replace('<head>',`<head><script>globalThis.cpuVariant=${JSON.stringify(variant)};globalThis.cpuBaseline=${JSON.stringify(revision)};</script>${injection}`);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(req.method==='HEAD'?undefined:page);return;
    }
    const info=await stat(target);if(!info.isFile()){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':types[path.extname(target)]??'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-store'});
    if(req.method==='HEAD')res.end();else createReadStream(target).pipe(res);
  }catch(error){res.writeHead(404).end('Local benchmark file is not ready');}
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${port}/`,revision,root,differences})));
