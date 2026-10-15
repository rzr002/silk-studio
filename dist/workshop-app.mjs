import {WorkshopSession,YARNS,GUIDES,createWorkshopModel,finalizeWorkshop} from './workshop.mjs';
import {WorkshopScene,buildCourseBlank} from './workshop-scene.mjs';
import {restoreWorkshopProject,packWorkshopOrigin,packWorkshopResume,restoreWorkshopResume} from './workshop-project.mjs';
import {createPatch} from './physics.mjs';

const $=id=>document.getElementById(id),clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const STORAGE='silk-workshop-v1',stages=['yarn','sample','knit','seam','finish','wear'];
const names={yarn:'选纱与穿线',sample:'试织小样',knit:'编织成形',seam:'对齐封尖',finish:'染整与定型',wear:'试穿与验货'};
const roomNames={yarn:'选纱台',sample:'手轮与试样台',knit:'圆形针织机',seam:'封尖工位',finish:'染整与定型架',wear:'试穿架'};
const descriptions={yarn:'先摸清材料，再把线送到针床。',sample:'留一块试样，拉一拉再决定。',knit:'把针目草图织成自己的袜坯。',seam:'两侧对齐，再踩下缝纫踏板。',finish:'染好颜色，套正形板，理顺褶皱。',wear:'翻看自己的成品，发现问题再回去改。'};
const eventNames={'mount-yarn':'装上纱筒',thread:'穿过导纱位置',unthread:'退出纱路','sample-knit':'转动手轮试织','sample-pull':'试拉小样','set-loop-length':'调整线圈长度','accept-sample':'确认试样','set-dimension':'修改自然尺寸','set-stitch':'画下针目','start-knit':'启动圆机','pause-knit':'暂停圆机',knit:'织出横列',unravel:'拆织返工','align-toe':'对齐袜尖',sew:'送缝封尖',unpick:'拆除缝线','set-dye':'调换色样',dye:'染整处理',board:'套上定型板',smooth:'拉平局部',heat:'蒸汽定型',dress:'套上腿模',pose:'查看动作',inspect:'检查制作结果',name:'命名作品'};
let session=new WorkshopSession(),selectedYarn=null,viewStation='yarn',scene,model,modelKey='',finalCache=null;
let toastTimer,productionTimer,lastFrame=0,lastMonitor=0,painting=false,lastCell=null,activeDrag=null,wheelAngle=null,wheelTravel=0;
const timers=new Map(),s=()=>session.state;
function toast(message){$('workshop-toast').textContent=message;$('workshop-toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('workshop-toast').classList.remove('visible'),3600);}
function fail(error){toast(error.message||String(error));return false;}
function stopTimers(){clearInterval(productionTimer);productionTimer=null;for(const timer of timers.values())clearInterval(timer);timers.clear();}
function act(action,{quiet=false,follow=true}={}){
  try{const before=s().stage,result=session.dispatch(action);finalCache=null;if(follow&&s().stage!==before)viewStation=s().stage;sync({camera:s().stage!==before&&follow});if(!quiet)toast(result.feedback);if(!s().production.running){clearInterval(productionTimer);productionTimer=null;}return result;}
  catch(error){return fail(error);}
}
function station(name){if(!stages.includes(name))return;viewStation=name;sync({camera:true});}
function keyForModel(state){return JSON.stringify([state.recipe.dimensions,state.recipe.program.cells,state.recipe.loopLengthMm,state.recipe.yarnId,state.wear.dressed,state.wear.pose]);}
function sync({camera=false,instant=false}={}){
  const state=s(),key=keyForModel(state);
  // The sketch edits source cells immediately. Compile their spatial equivalent
  // when leaving the sketch, rather than blocking every pointer movement.
  if(key!==modelKey&&(!model||!$('pattern-dialog').open)){model=createWorkshopModel(session);modelKey=key;}
  scene.setWorkshop({session:state,model,material:YARNS.find(y=>y.id===state.recipe.yarnId)||YARNS[0],fitCamera:!camera});if(camera)scene.setStation?.(viewStation,{instant});
  updateUI();
}
function task(){
  const a=s();if(viewStation!==a.stage&&stages.indexOf(viewStation)>stages.indexOf(a.stage))return ['这里还在等待上一道工序',`当前先完成「${names[a.stage]}」。你可以看看工位，完成后再来。`];
  if(viewStation==='yarn'){if(!a.threading.mounted)return ['拿起一卷纱线','从左边的纱架选一卷，拖到机器的纱筒座上。'];const i=a.threading.path.length;return ['把纱线送到针床',i<3?['先穿过上方导纱眼。','把纱线绕过张力器。','最后送入针床旁的喂纱嘴。'][i]:'纱路完整，去手轮旁织一块小样。'];}
  if(viewStation==='sample'){if(a.sample.courses<8)return ['转动手轮，织出一块小样','绕着手轮拖动，看新的线圈一圈圈连接起来。'];const trial=a.sample.trials.find(t=>t.id===a.sample.activeId);if(trial?.damaged)return ['这块小样拉坏了','调节线圈长度后，重新试织。旧小样会留在桌上供你比较。'];return [a.sample.pull>0?'留下这次试样，或者再试一次':'抓住小样，拉到标线','向右拖动小样试拉；比较疏密与回弹，再决定用哪次设置。'];}
  if(viewStation==='knit')return [a.production.running?'袜坯正在长出来':a.production.producedCourses?'暂停了，可以检查针目':'给丝袜留下一点自己的想法',a.production.running?'可以随时暂停。已经织出的部分会保留。':'在针目草图里画出组织，调整尺寸，再启动圆机。'];
  if(viewStation==='seam')return [a.seam.quality==='misaligned'?'这条接缝错位了，先拆线':'把袜尖两侧沿标线对齐',a.seam.quality==='misaligned'?'拆掉缝线，重新对齐。后面的染整工位会继续等待。':'拖动夹具中的袜边，对齐后点击踏板或按送缝按钮。'];
  if(viewStation==='finish'){if(!a.finish.dyed)return ['把袜坯放进染槽','选一块目标色样，点击染槽。处理时间已加速。'];if(!a.finish.boarded)return ['套上定型板','把丝袜套正，再分别理顺袜口、袜身和足部。'];if(a.finish.smoothedZones.length<3)return ['把扭转和褶皱理顺','点击或拖过定型板上的三个区域。都拉平后再进行蒸汽处理。'];return ['可以进行蒸汽定型了','启动蒸汽，等待这次整理完成。'];}
  return [a.wear.dressed?'看看自己的第一件作品':'把成品套上腿模',a.wear.dressed?'转动视角，查看动作与制作记录；需要修改时可以回到相关工序。':'点击试穿架，展示整理后的丝袜，再检查并命名。'];
}
function updateUI(){
  const a=s(),current=stages.indexOf(a.stage),view=stages.indexOf(viewStation);$('room-title').textContent=roomNames[viewStation];$('bench-title').textContent=names[viewStation];$('bench-description').textContent=descriptions[viewStation];
  for(const button of document.querySelectorAll('[data-station]')){const i=stages.indexOf(button.dataset.station);button.setAttribute('aria-current',button.dataset.station===viewStation?'step':'false');button.classList.toggle('completed',i<current);}
  for(const panel of document.querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==viewStation;
  $('locked-note').hidden=view<=current;$('locked-note').textContent=`这道工序等待「${names[a.stage]}」完成。`;
  const [title,description]=task();$('task-title').textContent=title;$('task-description').textContent=description;
  $('piece-stage').textContent=a.production.producedCourses?`${a.production.producedCourses} / 48 段${a.seam.closed?' · 已封尖':' · 袜尖开放'}`:'尚未织出袜布';
  $('production-readout').textContent=a.production.running?'针床正在工作':a.stage==='wear'?'已完成定型 / 可以试穿':`工序 ${current+1} / 6`;
  for(const button of document.querySelectorAll('[data-yarn]'))button.classList.toggle('selected',button.dataset.yarn===(selectedYarn||a.recipe.yarnId));
  $('mount-yarn').disabled=!selectedYarn||a.production.producedCourses>0;
  $('thread-count').textContent=`${a.threading.path.length} / 3`;for(const id of GUIDES){const el=$(`thread-${id}`),done=a.threading.path.includes(id);el.classList.toggle('done',done);el.querySelector('b').textContent=done?'✓':'○';el.disabled=!a.threading.mounted||done||a.production.producedCourses>0;}
  $('unthread').disabled=!a.threading.path.length||a.production.producedCourses>0;
  $('sample-count').textContent=`${a.sample.courses} / 8`;$('sample-knit').disabled=a.stage!=='sample'||a.sample.courses>=8;$('sample-pull').disabled=a.sample.courses<8||!!a.sample.acceptedId;
  $('loop-length').value=a.recipe.loopLengthMm;$('loop-length-value').textContent=`${a.recipe.loopLengthMm.toFixed(1)} mm`;$('loop-length').disabled=a.production.producedCourses>0;
  const trial=a.sample.trials.find(t=>t.id===a.sample.activeId),pull=trial?.pulls.at(-1);$('accept-sample').disabled=a.stage!=='sample'||a.sample.courses<8||!pull||trial?.damaged;
  $('sample-result').textContent=!trial?'织出小样后，亲手拉一拉。':trial.damaged?'这块试样超过了演示材料的伸长范围。留下它，调整后再试一次。':pull?`试拉 ${(pull.extension*100).toFixed(0)}% · 实验拉力 ${pull.forceN.toFixed(2)} N。调节线圈后，可以再织一块比较。`:`小样已织 ${trial.courses}/8 段，织满后试拉。`;
  $('trial-count').textContent=`${a.sample.trials.length} 件`;const tray=$('trial-tray');tray.replaceChildren(...a.sample.trials.map((t,i)=>{const card=document.createElement('div');card.className=`trial-card${t.accepted?' accepted':''}`;const name=document.createElement('strong');name.textContent=`小样 ${i+1}`;const note=document.createElement('span');note.textContent=t.damaged?'受损':t.accepted?'已选用':`${t.courses}/8`;const text=document.createElement('div');text.textContent=`${t.loopLengthMm.toFixed(1)} mm · 试拉 ${(t.maxPull*100).toFixed(0)}%${t.pulls.length?` · ${t.pulls.at(-1).forceN.toFixed(2)} N`:''}`;card.append(name,note,text);return card;}));
  for(const input of document.querySelectorAll('[data-dimension]')){const cm=a.recipe.dimensions[input.dataset.dimension]*100;input.value=cm;$(input.id+'-value').textContent=Number(cm.toFixed(1));input.disabled=a.production.producedCourses>0;}
  $('knit-count').textContent=`${a.production.producedCourses} / 48 段`;$('knit-progress').value=a.production.producedCourses;$('start-knit').disabled=a.stage!=='knit'||a.production.running;$('pause-knit').disabled=!a.production.running;$('unravel').disabled=a.production.producedCourses===0;$('unravel-course').max=a.production.producedCourses;
  $('toe-offset').value=a.seam.alignment;$('toe-offset-value').textContent=a.seam.alignment.toFixed(2);$('toe-offset').disabled=a.production.producedCourses<48||a.seam.feed>0;$('toe-alignment').textContent=Math.abs(a.seam.alignment)<=.12?'两侧对齐':'还有错位';$('seam-progress').value=a.seam.feed;$('sew').disabled=a.production.producedCourses<48||a.seam.closed||timers.has('sew');$('unpick').disabled=a.seam.feed===0;
  $('seam-preview-edge').style.transform=`translateY(${a.seam.alignment*25}px)`;$('seam-preview-stitch').style.height=`${a.seam.feed*50}px`;$('seam-result').textContent=a.seam.quality==='misaligned'?'接缝错位：拆线后才能重新对齐。':a.seam.closed?'脚尖已封合。':`已经送缝 ${(a.seam.feed*100).toFixed(0)}%。`;
  const seamOK=a.seam.closed&&a.seam.quality==='aligned';$('dye-color').value=a.finish.color;$('dye-color').disabled=!seamOK||timers.has('dye');$('dye-state').textContent=a.finish.dyed?'已完成':`${(a.finish.dyeProgress*100).toFixed(0)}%`;$('dye-progress').value=a.finish.dyeProgress;$('dye').disabled=!seamOK||a.finish.dyed||timers.has('dye');$('board').disabled=!a.finish.dyed||a.finish.boarded;$('board-state').textContent=a.finish.boarded?`已理顺 ${a.finish.smoothedZones.length}/3 处`:'等待套模';
  for(const button of document.querySelectorAll('[data-smooth]')){const done=a.finish.smoothedZones.includes(button.dataset.smooth);button.disabled=!a.finish.boarded||a.finish.set||done;button.classList.toggle('done',done);}
  $('heat').disabled=!a.finish.boarded||a.finish.smoothedZones.length!==3||a.finish.set||timers.has('heat');$('heat-progress').value=a.finish.heatProgress;
  $('dress').disabled=a.stage!=='wear'||a.wear.dressed;$('pose').disabled=!a.wear.dressed;$('pose').value=a.wear.pose;$('pose-value').textContent=`${a.wear.pose}°`;$('inspect').disabled=!a.wear.dressed;$('wear-state').textContent=a.wear.dressed?'已套上腿模':'等待试穿';
  const result=$('inspection-result');result.replaceChildren();if(a.wear.inspection){const headline=document.createElement('p');headline.className=a.wear.inspection.passed?'pass':'issue';headline.textContent=a.wear.inspection.passed?'这件作品的制作流程已完成。':'有一处制作问题需要返工。';const list=document.createElement('ul');for(const issue of a.wear.inspection.issues){const li=document.createElement('li');li.textContent=issue.message;list.append(li);}result.append(headline,list);}
  if(document.activeElement!==$('piece-name'))$('piece-name').value=a.name;
  $('send-to-lab').disabled=!a.wear.inspection?.passed;$('export').textContent=a.wear.inspection?.passed?'导出作品':'导出进度';
  $('event-count').textContent=`${a.events.length} 步`;$('event-list').replaceChildren(...a.events.slice(-16).map(e=>{const li=document.createElement('li');li.textContent=`${eventNames[e.action.type]||e.action.type}${e.action.type==='knit'?` · ${e.action.courses} 段`:''}`;return li;}));
  drawPattern($('pattern-preview'));if($('pattern-dialog').open)drawPattern($('pattern-editor'));
  updateMotionMonitor();
}
function updateMotionMonitor(){
  if(!$('activity-label'))return;const state=s(),m=scene.motionStats,a=m.activity||{};
  const active=m.cameraMoving?['正在移动到工位',names[viewStation]]:a.heat>0?['蒸汽正在整理织物','热定型 · 加速演示']:a.dye>0?['染液正在流动',`染整 ${Math.round(state.finish.dyeProgress*100)}%`]:a.sew>0?['针脚正在向前送缝',`已封合 ${Math.round(state.seam.feed*100)}%`]:a.knit>0||state.production.running?['针床与传动正在工作',state.stage==='sample'?`试样 ${state.sample.courses} / 8 段`:`袜坯 ${state.production.producedCourses} / 48 段`]:a.sample>0?['观察小样的伸展',`试拉 ${Math.round(state.sample.pull*100)}%`]:['工位已就绪',task()[0]];
  $('activity-label').textContent=active[0];$('activity-detail').textContent=active[1];
  const progress=state.stage==='yarn'?state.threading.path.length/3:state.stage==='sample'?state.sample.courses/8:state.stage==='knit'?state.production.producedCourses/48:state.stage==='seam'?state.seam.feed:state.stage==='finish'?(state.finish.dyeProgress+Number(state.finish.boarded)+state.finish.smoothedZones.length/3+state.finish.heatProgress)/4:state.wear.inspection?.passed?1:state.wear.dressed ? .8 : 0;
  $('activity-meter').value=progress;$('process-monitor').dataset.active=String(m.active);$('process-monitor').dataset.stage=state.stage;
}
function drawPattern(canvas){
  const a=s(),context=canvas.getContext('2d'),cols=a.recipe.program.cols,rows=a.recipe.program.rows,w=canvas.width/cols,h=canvas.height/rows,colors={knit:'#d5c5ac',tuck:'#748067',miss:'#a98768'};
  context.fillStyle='#efe7d8';context.fillRect(0,0,canvas.width,canvas.height);
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){const type=a.recipe.program.cells[row*cols+col];context.fillStyle=colors[type];context.globalAlpha=row<a.production.producedCourses ? .38 : 1;context.fillRect(col*w+.5,row*h+.5,Math.max(1,w-1),Math.max(1,h-1));if(canvas.id==='pattern-editor'&&type==='knit'){context.strokeStyle='#a08f76';context.lineWidth=.7;context.beginPath();context.moveTo((col+.15)*w,(row+.1)*h);context.quadraticCurveTo((col+.9)*w,(row+.8)*h,(col+.5)*w,(row+.9)*h);context.quadraticCurveTo((col+.1)*w,(row+.8)*h,(col+.85)*w,(row+.1)*h);context.stroke();}}
  context.globalAlpha=1;context.strokeStyle='#657454';context.lineWidth=2;context.beginPath();context.moveTo(0,a.production.producedCourses*h);context.lineTo(canvas.width,a.production.producedCourses*h);context.stroke();
}
let stitch='knit';
function paint(event){const canvas=$('pattern-editor'),r=canvas.getBoundingClientRect(),col=clamp(Math.floor((event.clientX-r.left)/r.width*40),0,39),row=clamp(Math.floor((event.clientY-r.top)/r.height*48),0,47),cell=`${row}:${col}:${stitch}`;if(lastCell===cell)return;lastCell=cell;if(act({type:'set-stitch',row,col,stitch},{quiet:true,follow:false}))$('pattern-feedback').textContent=`第 ${row+1} 段，第 ${col+1} 组针目已改为${{knit:'成圈',tuck:'集圈',miss:'浮线'}[stitch]}。`;else $('pattern-feedback').textContent='这一段已经织出。先暂停并拆回，再修改。';}
function startProduction(){
  if(!act({type:'start-knit'}))return;
  clearTimeout(productionTimer);
  const nextCourse=()=>{
    productionTimer=null;if(!s().production.running)return;
    act({type:'knit',courses:1},{quiet:true});
    // Leave a gap after each completed update for pointer input, including on
    // software WebGL. setInterval can fill that gap with overdue course ticks.
    if(s().production.running)productionTimer=setTimeout(nextCourse,500);
  };
  productionTimer=setTimeout(nextCourse,500);
}
function runProcessing(type){if(timers.has(type))return;const done=()=>type==='sew'?s().seam.closed:type==='dye'?s().finish.dyed:s().finish.set;if(!act({type,amount:.1},{quiet:true}))return;if(done())return;const timer=setInterval(()=>{if(!act({type,amount:.1},{quiet:true})||done()){clearInterval(timer);timers.delete(type);updateUI();if(done())toast(type==='sew'?(s().seam.quality==='aligned'?'脚尖已封合。':'封尖错位，需要拆线返工。'):type==='dye'?'染整完成，可以套模。':'定型完成，去看看自己的作品。');}},type==='sew'?220:type==='dye'?280:300);timers.set(type,timer);updateUI();}
function pointNear(screen,id,distance=60){const p=scene.projectObject?.(id);return p&&Math.hypot(p.x-screen.x,p.y-screen.y)<distance;}
function interaction(event){
  const {type,objectId,screen}=event;if(!objectId)return;
  if(type==='select'&&objectId.startsWith('yarn-')){selectedYarn=objectId.slice(5);updateUI();return;}
  if(type==='drag-start'){activeDrag={objectId,start:screen,alignment:s().seam.alignment};wheelAngle=null;wheelTravel=0;return;}
  if(type==='drag'){
    if(objectId==='handwheel'){
      const p=scene.projectObject('handwheel');if(!p)return;const angle=Math.atan2(screen.y-p.y,screen.x-p.x);if(wheelAngle!==null){let d=angle-wheelAngle;while(d>Math.PI)d-=2*Math.PI;while(d< -Math.PI)d+=2*Math.PI;wheelTravel+=Math.abs(d);if(wheelTravel>.55){wheelTravel-=.55;if(s().stage==='sample'&&s().sample.courses<8)act({type:'sample-knit',courses:1},{quiet:true});else if(s().production.running)act({type:'knit',courses:1},{quiet:true});}}wheelAngle=angle;
    }else if(objectId==='thread-end'){const next=GUIDES[s().threading.path.length];if(next&&pointNear(screen,next,28))act({type:'thread',guideId:next},{quiet:true});}
    else if(objectId==='sample'&&activeDrag&&s().stage==='sample'&&s().sample.courses>=8&&!s().sample.acceptedId)scene.previewSampleStretch(clamp(Math.abs(screen.x-activeDrag.start.x)/180,.1,1));
    return;
  }
  if(type==='drag-end'){
    if(objectId.startsWith('yarn-')&&pointNear(screen,'spindle',75)){selectedYarn=objectId.slice(5);act({type:'mount-yarn',yarnId:selectedYarn});}
    else if(objectId==='sample'&&activeDrag)act({type:'sample-pull',extension:clamp(Math.abs(screen.x-activeDrag.start.x)/180,.1,1)});
    else if((objectId==='toe-left'||objectId==='toe-right')&&activeDrag){const offset=activeDrag.alignment+(screen.x-activeDrag.start.x)/100*(objectId==='toe-left'?1:-1);act({type:'align-toe',offset:clamp(offset,-1,1)});}
    else if(objectId==='blank'&&pointNear(screen,'dye-vat',90))runProcessing('dye');
    else if(objectId.startsWith('smooth-'))act({type:'smooth',zone:objectId.slice(7)});
    scene.clearManipulationPreview();activeDrag=null;wheelAngle=null;return;
  }
  if(type!=='activate')return;
  if(objectId.startsWith('yarn-')){selectedYarn=objectId.slice(5);updateUI();toast('拖动这卷纱线到机器的纱筒座。');}
  else if(objectId==='spindle'){if(selectedYarn)act({type:'mount-yarn',yarnId:selectedYarn});else toast('先从纱架拿一卷纱线。');}
  else if(GUIDES.includes(objectId))act({type:'thread',guideId:objectId});
  else if(objectId==='handwheel'){if(s().stage==='sample'&&s().sample.courses<8)act({type:'sample-knit',courses:1});else toast('围着手轮拖动可以慢转观察。');}
  else if(objectId==='sample')toast('向右拖动小样，试拉到标线。');
  else if(objectId==='sewing-pedal')runProcessing('sew');
  else if(objectId==='dye-vat')runProcessing('dye');
  else if(objectId==='board')act({type:'board'});
  else if(objectId.startsWith('smooth-'))act({type:'smooth',zone:objectId.slice(7)});
  else if(objectId==='steam-button')runProcessing('heat');
  else if(objectId==='mannequin')act({type:'dress'});
  else if(objectId==='blank')toast(`这只袜坯已经织出 ${s().production.producedCourses} 段${s().seam.closed?'，脚尖已封合。':'，脚尖仍是开放边界。'}`);
}
function finished(){const state=s();if(!state.wear.inspection?.passed)return null;if(finalCache?.revision===state.revision)return finalCache;const result=finalizeWorkshop(session);finalCache={revision:state.revision,...result};return finalCache;}
function project(){const result=finished();return {schema:'silk-workshop-project',version:1,workshop:session.snapshot(),design:result?.design.snapshot()||null,bridge:result?.bridge||null};}
function loadProject(value){
  const loaded=restoreWorkshopProject(value);
  stopTimers();session=loaded.session;finalCache=loaded.design?{revision:s().revision,design:loaded.design,bridge:loaded.bridge}:null;selectedYarn=s().recipe.yarnId;viewStation=s().stage;modelKey='';sync({camera:true});$('save-state').textContent='已打开制作记录';
}
function saveProgress(){localStorage.setItem(STORAGE,JSON.stringify(packWorkshopResume(session)));}
function resumeProgress(value){
  if(value?.schema!=='silk-workshop-resume'){loadProject(value);saveProgress();return;}
  const loaded=restoreWorkshopResume(value);stopTimers();session=loaded.session;finalCache=null;selectedYarn=s().recipe.yarnId;viewStation=s().stage;modelKey='';sync({camera:true});
}
function download(name,text,type='application/json'){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
try{
  scene=new WorkshopScene($('workshop-viewport'),interaction);
  const storedMotion=localStorage.getItem('silk-workshop-motion'),motionEnabled=storedMotion?storedMotion==='on':!matchMedia('(prefers-reduced-motion: reduce)').matches;scene.setMotionEnabled(motionEnabled);
  if($('motion-toggle')){$('motion-toggle').setAttribute('aria-pressed',String(motionEnabled));$('motion-toggle').onclick=()=>{const enabled=$('motion-toggle').getAttribute('aria-pressed')!=='true';scene.setMotionEnabled(enabled);$('motion-toggle').setAttribute('aria-pressed',String(enabled));localStorage.setItem('silk-workshop-motion',enabled?'on':'off');updateMotionMonitor();};}
  $('yarn-shelf').replaceChildren(...YARNS.map((y,i)=>{const button=document.createElement('button');button.id=`yarn-${y.id}`;button.className='yarn-card';button.dataset.yarn=y.id;button.setAttribute('aria-label',`拿起${y.name}`);const swatch=document.createElement('span');swatch.className='yarn-swatch';swatch.style.setProperty('--yarn-color',y.color);const info=document.createElement('span'),name=document.createElement('strong'),desc=document.createElement('small');name.textContent=y.name;desc.textContent=['轻薄 · 细密','柔软 · 有弹性','较紧实 · 加固'][i];info.append(name,desc);button.append(swatch,info,document.createElement('i'));button.onclick=()=>{selectedYarn=y.id;updateUI();toast(`拿起${y.name}，放上机器再穿线。`);};return button;}));
  for(const button of document.querySelectorAll('[data-station]'))button.onclick=()=>station(button.dataset.station);
  $('mount-yarn').onclick=()=>act({type:'mount-yarn',yarnId:selectedYarn});for(const id of GUIDES)$(`thread-${id}`).onclick=()=>act({type:'thread',guideId:id});$('unthread').onclick=()=>act({type:'unthread'});
  $('sample-knit').onclick=()=>act({type:'sample-knit',courses:Math.min(4,8-s().sample.courses)});$('loop-length').oninput=()=>{$('loop-length-value').textContent=`${Number($('loop-length').value).toFixed(1)} mm`;};$('loop-length').onchange=()=>act({type:'set-loop-length',mm:Number($('loop-length').value)});
  $('sample-extension').oninput=()=>{$('sample-extension-value').textContent=`${$('sample-extension').value}%`;};$('sample-pull').onclick=()=>act({type:'sample-pull',extension:Number($('sample-extension').value)/100});$('accept-sample').onclick=()=>act({type:'accept-sample'});
  for(const input of document.querySelectorAll('[data-dimension]')){input.oninput=()=>$(input.id+'-value').textContent=input.value;input.onchange=()=>act({type:'set-dimension',key:input.dataset.dimension,value:Number(input.value)/100});}
  $('start-knit').onclick=startProduction;$('pause-knit').onclick=()=>act({type:'pause-knit'});$('unravel').onclick=()=>{if(act({type:'unravel',toCourse:Number($('unravel-course').value)})){stopTimers();updateUI();}};
  for(const button of document.querySelectorAll('[data-stitch]'))button.onclick=()=>{stitch=button.dataset.stitch;for(const b of document.querySelectorAll('[data-stitch]'))b.setAttribute('aria-pressed',String(b.dataset.stitch===stitch));};
  $('open-pattern').onclick=$('pattern-preview').onclick=()=>{$('pattern-dialog').showModal();drawPattern($('pattern-editor'));};$('close-pattern').onclick=()=>$('pattern-dialog').close();$('pattern-dialog').addEventListener('close',()=>sync());
  $('pattern-editor').onpointerdown=e=>{painting=true;lastCell=null;e.currentTarget.setPointerCapture(e.pointerId);paint(e);};$('pattern-editor').onpointermove=e=>{if(painting)paint(e);};$('pattern-editor').onpointerup=$('pattern-editor').onpointercancel=()=>{painting=false;lastCell=null;};
  $('toe-offset').oninput=()=>{$('toe-offset-value').textContent=Number($('toe-offset').value).toFixed(2);};$('toe-offset').onchange=()=>act({type:'align-toe',offset:Number($('toe-offset').value)});$('sew').onclick=()=>runProcessing('sew');$('unpick').onclick=()=>{if(act({type:'unpick'})){stopTimers();updateUI();}};
  $('dye-color').onchange=()=>act({type:'set-dye',color:$('dye-color').value});$('dye').onclick=()=>runProcessing('dye');$('board').onclick=()=>act({type:'board'});for(const button of document.querySelectorAll('[data-smooth]'))button.onclick=()=>act({type:'smooth',zone:button.dataset.smooth});$('heat').onclick=()=>runProcessing('heat');
  $('dress').onclick=()=>act({type:'dress'});$('pose').oninput=()=>act({type:'pose',angle:Number($('pose').value)},{quiet:true});$('inspect').onclick=()=>act({type:'inspect'});$('piece-name').onchange=()=>act({type:'name',value:$('piece-name').value});$('repair').onclick=()=>station('knit');
  $('save').onclick=()=>{try{saveProgress();$('save-state').textContent='制作进度已保存';toast('制作记录和试样都已保存。');}catch(error){fail(error);}};
  $('load').onclick=()=>$('load-file').click();$('load-file').onchange=async()=>{const file=$('load-file').files[0];if(!file)return;try{if(file.size>20*1024*1024)throw new Error('制作文件超过20 MB');loadProject(JSON.parse(await file.text()));toast('已打开这件作品，织机保持暂停。');}catch(error){fail(error);}finally{$('load-file').value='';}};
  $('export').onclick=()=>{try{const value=project();download(`silk-workshop-v${s().revision}.json`,JSON.stringify(value,null,2));toast(value.design?'制作记录和成品源文件已一起导出。':'未完成的制作进度已导出，可以继续。');}catch(error){fail(error);}};
  $('send-to-lab').onclick=()=>{try{const result=finished();if(!result)throw new Error('请先完成制作和检查');const design=result.design.snapshot(),source=project(),value={format:'silk-design-workbench',version:2,activeView:'stocking',design,lab:createPatch().snapshot(),pose:design.pose,targetPose:design.pose,settings:{backend:'browser',gravity:true,collider:true,selfCollision:true,continuousCollision:true,quality:'standard'},playing:false,manufacturing:{status:'unverified',nativeProgram:null},workshopOrigin:packWorkshopOrigin(source)};saveProgress();localStorage.setItem('silk-design-workbench-v2',JSON.stringify(value));location.assign('./lab.html');}catch(error){fail(error);}};
  $('new-piece').onclick=()=>{stopTimers();session=new WorkshopSession();selectedYarn=null;viewStation='yarn';modelKey='';finalCache=null;sync({camera:true});$('save-state').textContent='新作品尚未保存';};$('reset-view').onclick=()=>scene.setStation?.(viewStation);$('photo').onclick=()=>{const a=document.createElement('a');a.href=scene.capture();a.download=`silk-workshop-${s().stage}.png`;a.click();};
  window.workshop={inspect:()=>{const state=session.snapshot(),blank=buildCourseBlank(model,{producedCourses:state.production.producedCourses,totalCourses:state.production.totalCourses,toeClosed:state.seam.closed,useCurrentPositions:state.wear.dressed});return {snapshot:state,stage:state.stage,viewStation,selectedYarn,geometry:{vertices:(blank.positions?.length||0)/3,faces:(blank.indices?.length||blank.triangles?.length||0)/3,toeClosed:state.seam.closed,producedCourses:state.production.producedCourses,totalCourses:state.production.totalCourses},rendering:scene.renderStats?structuredClone(scene.renderStats):null,motion:scene.motionStats};},projectObject:id=>scene.projectObject(id)};
  sync({camera:true,instant:true});let openedSource=false;const sourceResume=sessionStorage.getItem('silk-workshop-open-source');
  if(sourceResume){try{resumeProgress(JSON.parse(sourceResume));openedSource=true;$('save-state').textContent='正在查看制作原件';toast('已打开这件作品的制作原件。另一件已保存的进度仍保留。');}catch(error){toast(`制作原件未能打开：${error.message}`);}finally{sessionStorage.removeItem('silk-workshop-open-source');}}
  const stored=localStorage.getItem(STORAGE);if(stored&&!openedSource){try{resumeProgress(JSON.parse(stored));$('save-state').textContent='已恢复制作记录';toast('上次的制作进度在这里，织机保持暂停。');}catch(error){toast(`上次记录未能恢复：${error.message}`);}}
  $('workshop-loading').remove();function frame(time){requestAnimationFrame(frame);if(time-lastFrame>16){scene.render(time);lastFrame=time;}if(time-lastMonitor>120){updateMotionMonitor();lastMonitor=time;}}requestAnimationFrame(frame);
  addEventListener('pagehide',event=>{stopTimers();if(s().production.running)session.dispatch({type:'pause-knit'});if(!event.persisted)scene.dispose?.();});
  addEventListener('pageshow',event=>{if(event.persisted)sync({camera:true});});
}catch(error){console.error(error);$('workshop-loading').textContent=`工坊未能打开：${error.message}`;}
