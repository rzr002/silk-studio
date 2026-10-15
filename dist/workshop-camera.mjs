/** Display-only camera interpolation; no design or simulation state is touched. */
export function cameraFrameAt(travel,timeMs){
  const {from,to,startMs,durationMs}=travel;
  if(durationMs<=0||timeMs>=startMs+durationMs)return {frame:structuredClone(to),moving:false};
  if(timeMs<=startMs)return {frame:structuredClone(from),moving:true};
  const t=(timeMs-startMs)/durationMs,ease=t*t*(3-2*t),lerp=(a,b)=>a+(b-a)*ease;
  let turn=to.angle-from.angle;while(turn>Math.PI)turn-=Math.PI*2;while(turn< -Math.PI)turn+=Math.PI*2;
  return {frame:{target:from.target.map((value,i)=>lerp(value,to.target[i])),distance:lerp(from.distance,to.distance),elevation:lerp(from.elevation,to.elevation),angle:from.angle+turn*ease,offsetY:lerp(from.offsetY,to.offsetY)},moving:true};
}
