import {test} from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../dist/workshop-camera.mjs').catch(()=>({}));
const a={target:[-.6,1,.1],distance:1.8,elevation:.6,angle:3.1,offsetY:15};
const b={target:[.6,.9,.5],distance:2.4,elevation:.3,angle:-3.1,offsetY:35};
const sample=(time,duration=600)=>{assert.equal(typeof api.cameraFrameAt,'function');return api.cameraFrameAt({from:a,to:b,startMs:100,durationMs:duration},time);};
test('camera travel starts at its captured view and finishes exactly at the selected station',()=>{
  const first=sample(100),last=sample(700);assert.deepEqual(first.frame,a);assert.equal(first.moving,true);assert.deepEqual(last.frame,b);assert.equal(last.moving,false);assert.deepEqual(sample(5000).frame,b);
});
test('a station move has intermediate eased positions and follows the shortest angular path',()=>{
  const quarter=sample(250),half=sample(400);assert.ok(quarter.frame.target[0]>a.target[0]&&quarter.frame.target[0]<half.frame.target[0]);assert.ok(Math.abs(half.frame.target[0])<1e-12);assert.ok(Math.abs(Math.abs(half.frame.angle)-Math.PI)<1e-9);assert.ok(Math.abs(quarter.frame.angle-a.angle)<.05);assert.equal(half.moving,true);
});
test('camera sampling never changes source frames and reduced motion resolves immediately',()=>{
  const before=structuredClone([a,b]);sample(350);assert.deepEqual([a,b],before);assert.deepEqual(sample(100,0),{frame:b,moving:false});assert.deepEqual(sample(-500).frame,a);
});
