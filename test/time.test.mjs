import {test} from 'node:test';
import assert from 'node:assert/strict';
test('simulation advances equally at 60 Hz and 144 Hz',async()=>{
  let Clock;try{Clock=(await import('../dist/time.mjs')).FixedClock;}catch{}
  assert.equal(typeof Clock,'function');
  const simulate=fps=>{const clock=new Clock();let n=0;for(let i=0;i<fps;i++)clock.advance(1/fps,()=>n++);return n;};
  assert.equal(simulate(60),60);assert.equal(simulate(144),60);
});
