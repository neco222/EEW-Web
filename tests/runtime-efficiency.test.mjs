import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizeDrawableEffects,optimizeFrontLayer,installRuntimeEfficiency} from '../docs/runtime-efficiency.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function fixture() {
  class Drawable {
    constructor(){this.effects={};this.writes=0;this.dirty=false;}
    updateEffect(effect,value){this.effects[effect]=value;this.writes++;this.dirty=true;}
    updateProperties(properties){for(const [effect,value] of Object.entries(properties))this.updateEffect(effect,value);}
  }
  return Drawable;
}
test('steady effect writes are omitted without changing effect output',()=>{
  const Drawable=fixture();const baseline=new Drawable();const sample=new Drawable();
  const result=optimizeDrawableEffects(Drawable);
  for(let frame=0;frame<3600;frame++){
    sample.updateEffect('ghost',30);
    if(frame%120===0)sample.updateEffect('color',frame/120);
  }
  assert.equal(sample.effects.ghost,30);
  assert.equal(sample.effects.color,29);
  assert.equal(result.stats.repeatedEffectsSkipped,3599);
  assert.equal(sample.writes,31);
  sample.dirty=false;sample.updateEffect('ghost',30);assert.equal(sample.dirty,false);
  sample.updateEffect('ghost',0);assert.equal(sample.effects.ghost,0);assert.equal(sample.dirty,true);
  result.uninstall();baseline.updateEffect('ghost',30);baseline.updateEffect('ghost',30);assert.equal(baseline.writes,2);
});
test('properties, clones, new drawables and independent renderers keep separate effects',()=>{
  const Drawable=fixture();const a=new Drawable();const b=new Drawable();
  const patched=optimizeDrawableEffects(Drawable);
  a.updateProperties({ghost:30,color:10});a.updateEffect('ghost',30);b.updateEffect('ghost',30);
  assert.equal(a.writes,2);assert.equal(b.writes,1);
  a.updateProperties({ghost:0});a.updateEffect('ghost',30);assert.equal(a.writes,4);
  const Other=fixture();const other=new Other();other.updateEffect('ghost',30);other.updateEffect('ghost',30);assert.equal(other.writes,2);
  assert.equal(installRuntimeEfficiency({runtime:{renderer:{exports:{Drawable}}}}),patched);
  assert.equal(optimizeDrawableEffects(Drawable),patched);
  patched.uninstall();
});
test('unavailable renderer degrades gracefully, failed writes never populate the cache',()=>{
  assert.equal(installRuntimeEfficiency({}),null);
  class Broken{updateEffect(){throw new Error('write failed');}}
  const p=optimizeDrawableEffects(Broken);const d=new Broken();
  assert.throws(()=>d.updateEffect('ghost',30));assert.throws(()=>d.updateEffect('ghost',30));
  assert.equal(p.stats.repeatedEffectsSkipped,0);p.uninstall();
});

test('front-layer optimization preserves the bundled renderer return values and ordering',()=>{
  const source=readFileSync(new URL('../docs/index.js',import.meta.url),'utf8');
  const start=source.indexOf('setDrawableOrder(P,H,W,L,j){');
  const end=source.indexOf('skinWasAltered(',start);
  assert.ok(start>0 && end>start);
  const RealRenderer=runInNewContext(`(class {${source.slice(start,end)}})`,{g:{warn(){}}});
  function make(){const r=new RealRenderer();r._drawList=['bg','a','b'];r._groupOrdering=['background','sprite'];r._layerGroups={background:{drawListOffset:0},sprite:{drawListOffset:1}};r._endIndexForKnownLayerGroup=function(g){return g===this._layerGroups.sprite?this._drawList.length:1;};r.dirty=false;return r;}
  const base=make(), fast=make();const optimized=optimizeFrontLayer(fast);
  const cases=[['b',Infinity,'sprite'],['b',Infinity,'sprite'],['a',Infinity,'sprite'],['a',Infinity,'sprite'],['b',-Infinity,'sprite',false],['a',0,'sprite',true],['bg',Infinity,'background'],['a',1,'sprite',true],['missing',Infinity,'sprite']];
  for(const args of cases){assert.equal(fast.setDrawableOrder(...args),base.setDrawableOrder(...args));assert.deepEqual([...fast._drawList],[...base._drawList]);}
  assert.equal(optimized.stats.repeatedFrontMovesSkipped,3);
  fast._drawList=['bg','a','b'];fast.dirty=false;fast.setDrawableOrder('b',Infinity,'sprite');assert.equal(fast.dirty,false);
  optimized.uninstall();fast.setDrawableOrder('b',Infinity,'sprite');assert.equal(fast.dirty,true);
});
