import {installRuntimeEfficiency} from './runtime-efficiency.js';

// Keep the original packaged viewer intact. Additions are independent modules.
import('./community.js').then(({startCommunity}) => startCommunity()).catch(error => {
  console.error('Community report display could not start', error);
});
import('./watermark.js').then(({startWatermark}) => startWatermark()).catch(error => {
  console.error('Watermark could not start', error);
});
import('./index.js').then(() => {
  if (globalThis.vm) installRuntimeEfficiency(globalThis.vm);
}).catch(error => {
  console.error('Viewer failed to load', error);
  document.getElementById('error-message').textContent = '地震ビューアーを読み込めませんでした。再読み込みしてください。';
  document.getElementById('error').hidden = false;
});
