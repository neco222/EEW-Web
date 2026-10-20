/* Local synthetic test only: native cloud sends cannot leave this page. */
(() => {
  const audit={blockedSends:0,urls:[],blockedFetches:0,ttsRequested:0,ttsOK:0,ttsFailed:0,ttsFetchRequested:0,ttsXHRRequested:0};
  class Socket extends EventTarget {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    constructor(url){super();this.url=String(url);this.readyState=0;this.bufferedAmount=0;this.protocol='';this.extensions='';this.binaryType='blob';this.onopen=this.onmessage=this.onerror=this.onclose=null;audit.urls.push(this.url);setTimeout(()=>{if(this.readyState!==0)return;this.readyState=1;const event=new Event('open');this.dispatchEvent(event);this.onopen?.(event);},20);}
    send(){audit.blockedSends++;}
    close(){if(this.readyState===3)return;this.readyState=3;const event=new CloseEvent('close',{code:1000,wasClean:true});this.dispatchEvent(event);this.onclose?.(event);}
  }
  for(const key of ['CONNECTING','OPEN','CLOSING','CLOSED'])Object.defineProperty(Socket.prototype,key,{value:Socket[key]});
  globalThis.WebSocket=Socket;
  if(navigator.serviceWorker)navigator.serviceWorker.register=async()=>({active:null,waiting:null,installing:null,update:async()=>{}});
  const fetch=globalThis.fetch;
  globalThis.fetch=function(input,options){
    const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href);
    if(url.hostname==='synthesis-service.scratch.mit.edu'){
      audit.ttsRequested++;audit.ttsFetchRequested++;
      return fetch.call(this,input,options).then(response=>{if(response.ok)audit.ttsOK++;else audit.ttsFailed++;return response;},error=>{audit.ttsFailed++;throw error;});
    }
    if(url.origin===location.origin||['data:','blob:'].includes(url.protocol))return fetch.call(this,input,options);
    audit.blockedFetches++;return Promise.reject(new Error('External data is isolated for local CPU comparison'));
  };
  // Some native extension bundles use the fetch polyfill backed by XHR.
  // Observe its real success/failure too, without changing the transport.
  if(globalThis.XMLHttpRequest){
    const prototype=XMLHttpRequest.prototype,open=prototype.open,send=prototype.send,requests=new WeakMap();
    prototype.open=function(method,url,...args){const result=Reflect.apply(open,this,[method,url,...args]);let tts=false;try{tts=new URL(String(url),location.href).hostname==='synthesis-service.scratch.mit.edu';}catch{}requests.set(this,tts);return result;};
    prototype.send=function(...args){if(requests.get(this)){audit.ttsRequested++;audit.ttsXHRRequested++;this.addEventListener('loadend',()=>{if(this.status===200)audit.ttsOK++;else audit.ttsFailed++;},{once:true});}return Reflect.apply(send,this,args);};
  }
  // Avoid network video decoding and real community histories in CPU runs.
  // This is a fresh localhost-only origin; never change production preferences.
  try{localStorage.setItem('eew-camera-auto','false');}catch{}
  globalThis.cpuIsolation=audit;
})();
