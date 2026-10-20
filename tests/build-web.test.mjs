import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('original Scratch project and user-facing functions remain present',()=>{
  const project=JSON.parse(readFileSync(new URL('../docs/assets/project.json',import.meta.url),'utf8'));
  const names=new Set(project.targets.map(t=>t.name));
  for(const name of ['地図','UI','受信と検出','効果音&読み上げ','配色'])assert.ok(names.has(name),name);
  assert.ok(project.targets.reduce((sum,t)=>sum+Object.keys(t.blocks).length,0)>30000);
});

test('entry retains the original runtime and adds optional overlay without analytics',()=>{
  const html=readFileSync(new URL('../docs/index.html',import.meta.url),'utf8');
  const entry=readFileSync(new URL('../docs/viewer-entry.js',import.meta.url),'utf8');
  assert.match(html,/viewer-entry\.js/);assert.match(entry,/import\('\.\/index\.js'\)/);
  assert.doesNotMatch(html,/googletagmanager|gtag\(/);
  const runtime=readFileSync(new URL('../docs/index.js',import.meta.url),'utf8');
  assert.match(runtime,/setFramerate\(60\)/);
  assert.match(runtime,/setUseHighQualityRender\(!0\)/);
});
