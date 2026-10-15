import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const playwright=loadPlaywright();
const browser=await playwright.chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),report={scope:'isolated renderer fixture, not domain/gameplay acceptance',errors:[],checks:[]};
page.on('pageerror',error=>report.errors.push(error.message));page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
await page.addInitScript(()=>{window.shaderCompiles=0;for(const type of [window.WebGLRenderingContext,window.WebGL2RenderingContext]){if(!type||!Object.hasOwn(type.prototype,'compileShader'))continue;const original=type.prototype.compileShader;type.prototype.compileShader=function(...args){window.shaderCompiles++;return original.apply(this,args);};}});
const html=`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#dcded7}#viewport{width:100vw;height:100vh}.task-card{position:absolute;bottom:35px;height:95px;left:12px;right:12px;opacity:0;pointer-events:none}</style><div id="viewport"></div><div class="task-card"></div><script type="module">
import {WorkshopScene}from'/workshop-scene.mjs';import{createStocking,fitStocking,DEFAULT_DIMENSIONS}from'/garment-geometry.mjs';
window.events=[];window.s={schema:'silk-workshop',version:1,id:'renderer-fixture',revision:0,stage:'yarn',recipe:{yarnId:null,loopLengthMm:3,dimensions:{...DEFAULT_DIMENSIONS},program:{cols:40,rows:48,cells:Array(1920).fill('knit')}},threading:{mounted:false,path:[]},sample:{courses:0,totalCourses:8,pull:0,trials:[],acceptedId:null},production:{producedCourses:0,totalCourses:48,running:false,courses:[]},seam:{alignment:0,feed:0,closed:false,quality:null},finish:{color:'#594844',dyeProgress:0,dyed:false,boarded:false,smoothedZones:[],heatProgress:0,set:false},wear:{dressed:false,pose:0},events:[]};
window.scene=new WorkshopScene(document.querySelector('#viewport'),event=>window.events.push(event));window.setCase=patch=>{for(const[k,v]of Object.entries(patch))window.s[k]=typeof v==='object'?{...window.s[k],...v}:v;const model=createStocking();if(window.s.wear.dressed)fitStocking(model,{pose:window.s.wear.pose});window.scene.setWorkshop({session:window.s,model});window.scene.render();};setCase({});window.ready=true;function tick(){scene.render();requestAnimationFrame(tick)}requestAnimationFrame(tick);
</script>`;
await page.route('**/__workshop-scene-probe',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
const local=async id=>page.evaluate(id=>scene.projectObject(id),id);
async function clickObject(id,station){
  await page.evaluate(station=>{scene.setStation(station,{instant:true});scene.render();events.length=0;},station);const p=await local(id);assert.ok(p,`${id} has a visible projection`);await page.mouse.click(p.x,p.y);
  const actual=await page.evaluate(()=>events.filter(e=>e.type==='activate').at(-1)?.objectId);assert.equal(actual,id,`the projected ${id} must pick that same real object`);report.checks.push(`project/pick ${id}`);
}
try{
  await mkdir('evidence',{recursive:true});await page.goto((process.env.DEMO_URL||'http://127.0.0.1:4197')+'/__workshop-scene-probe');await page.waitForFunction(()=>window.ready);
  assert.deepEqual(report.errors,[]);await page.screenshot({path:'evidence/workshop-render-initial.png'});
  for(const id of ['yarn-nylon-fine','yarn-nylon-stretch','yarn-reinforced','spindle', 'guide-1','tensioner','feeder'])await clickObject(id,'yarn');
  const p=await local('yarn-nylon-fine');await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+65,p.y+20,{steps:3});assert.equal(await page.evaluate(()=>!!scene.grip?.clone),true);await page.screenshot({path:'evidence/workshop-render-drag-grip.png'});await page.mouse.up();assert.equal(await page.evaluate(()=>scene.grip),null);report.checks.push('actual pointer drag shows and clears the grip ghost');
  await page.evaluate(()=>setCase({stage:'sample',recipe:{yarnId:'nylon-fine'},threading:{mounted:true,path:['guide-1','tensioner','feeder']},sample:{courses:8,pull:.4}}));
  await clickObject('thread-end','yarn');await clickObject('sample','sample');
  await page.evaluate(()=>{scene.resetView();scene.render();});await page.screenshot({path:'evidence/workshop-render-sample.png'});
  const cases=[{name:'first-course',patch:{stage:'knit',production:{producedCourses:1}}},{name:'half-knit',patch:{production:{producedCourses:24}}},{name:'open-toe',patch:{stage:'seam',production:{producedCourses:48},seam:{alignment:.4,feed:.5}}},{name:'dyed',patch:{stage:'finish',seam:{alignment:0,feed:1,closed:true},finish:{dyed:true,dyeProgress:1,color:'#45384a'}}},{name:'boarded',patch:{finish:{boarded:true,smoothedZones:['cuff','leg'],heatProgress:.4}}},{name:'wear',patch:{stage:'wear',finish:{set:true},wear:{dressed:true,pose:35}}}];
  for(const c of cases){await page.evaluate(patch=>{setCase(patch);scene.setStation(s.stage,{instant:true});scene.render();},c.patch);await page.screenshot({path:`evidence/workshop-render-${c.name}.png`});report.checks.push(c.name);}
  const shaderReuse=await page.evaluate(async()=>{
    const{createStocking}=await import('/garment-geometry.mjs'),model=createStocking();s.stage='knit';s.wear.dressed=false;s.seam.closed=false;s.production.producedCourses=2;scene.setWorkshop({session:s,model});scene.render();const before=shaderCompiles;
    for(const count of [4,6,8]){s.production.producedCourses=count;scene.setWorkshop({session:s,model});scene.render();await new Promise(requestAnimationFrame);}
    return {before,after:shaderCompiles};
  });
  assert.equal(shaderReuse.after,shaderReuse.before,'progress-only updates must reuse compiled fabric/sample shader programs');report.checks.push('progress updates reuse GPU shader programs');
  await page.setViewportSize({width:390,height:480});
  for(const [station,ids]of Object.entries({yarn:['spindle','guide-1','tensioner','feeder'],sample:['sample','handwheel'],seam:['toe-left','toe-right','sewing-pedal'],finish:['dye-vat','board','smooth-cuff','smooth-leg','smooth-foot','steam-button'],wear:['mannequin']})){
    await page.evaluate(station=>{s.stage=station;if(station==='wear'){s.wear.dressed=true;s.production.producedCourses=48;s.seam.closed=true;}else{s.wear.dressed=false;s.seam.closed=false;}setCase({});scene.setStation(station,{instant:true});scene.render();},station);
    for(const id of ids){const p=await local(id);assert.ok(p&&p.x>20&&p.x<370&&p.y>=55&&p.y<350,`${station}/${id} fits narrow canvas above the task card: ${JSON.stringify(p)}`);}
    await page.screenshot({path:`evidence/workshop-render-mobile-${station}.png`});report.checks.push(`narrow-canvas ${station} handles`);
  }
  await page.waitForFunction(()=>!scene.motionStats.active);const before=await page.evaluate(()=>scene.renderStats);await page.waitForTimeout(1000);const after=await page.evaluate(()=>scene.renderStats);assert.equal(before.draws,after.draws);report.checks.push('stationary renderer stays idle');
  await page.evaluate(()=>scene.dispose());assert.equal(await page.locator('canvas').count(),0);assert.equal(await page.evaluate(()=>scene.render()),false);report.checks.push('dispose removes canvas and stops rendering');
  assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure=error.stack;throw error;}
finally{await writeFile('evidence/workshop-scene-browser-report.json',JSON.stringify(report,null,2));await browser.close();}
report.checks.forEach(x=>console.log('PASS',x));
