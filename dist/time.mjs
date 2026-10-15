/** Fixed simulation clock; display refresh never changes material time. */
export class FixedClock {
  constructor(step=1/60,maxSteps=4){this.step=step;this.maxSteps=maxSteps;this.accumulator=0;}
  reset(){this.accumulator=0;}
  advance(elapsed,callback){this.accumulator+=Math.max(0,Math.min(.1,elapsed));let n=0;while(this.accumulator+1e-10>=this.step&&n<this.maxSteps){callback(this.step);this.accumulator-=this.step;n++;}if(n===this.maxSteps&&this.accumulator>=this.step)this.accumulator%=this.step;return n;}
}
