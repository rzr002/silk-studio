import {SimulationEngine} from './simulation.mjs';

/** Transport only; solver state, validation and time stepping live in the engine. */
export function handleSimulationMessage(engine,message,post){
  try{
    if(message?.type==='sync'){engine.sync(message.snapshot,message.epoch,message);return;}
    if(message?.type!=='step')throw new Error('未知 simulation 消息类型');
    const result=engine.step(message);
    post({type:'result',...result},[result.positions.buffer,result.velocities.buffer,result.lambdas.buffer]);
  }catch(error){post({type:'error',epoch:message?.epoch??null,message:error?.message||String(error)});}
}

if(typeof self!=='undefined'&&typeof self.postMessage==='function'){
  const engine=new SimulationEngine();
  self.onmessage=event=>handleSimulationMessage(engine,event.data,(message,transfer)=>self.postMessage(message,transfer||[]));
}
