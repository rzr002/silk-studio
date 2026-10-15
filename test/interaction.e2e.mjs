import {LAB_URL} from './lab-url.mjs';
import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const playwright=loadPlaywright();
const browser=await playwright.chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
const errors=[],checks=[];let failure=null;
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const inspect=()=>page.evaluate(()=>workbench.inspect());
const check=name=>{checks.push(name);console.log('PASS',name);};
const point=(u,v)=>page.evaluate(([u,v])=>workbench.projectUV(u,v),[u,v]);
const tool=name=>page.locator(`[data-tool=${name}]`).click();
async function open(id){if(!await page.locator(id).getAttribute('open'))await page.locator(`${id}>summary`).click();}
async function pause(){if((await inspect()).playing)await page.locator('#play-button').click();await page.waitForFunction(()=>!workbench.inspect().computing);}
async function download(id,name){const event=page.waitForEvent('download');await page.locator(id).click();const d=await event;await d.saveAs(`evidence/${name}`);return JSON.parse(await readFile(`evidence/${name}`,'utf8'));}
try{
  await mkdir('evidence',{recursive:true});await page.goto(LAB_URL);await page.waitForFunction(()=>window.workbench?.inspect);await pause();
  await open('#solver-controls');await page.locator('#quality').selectOption('reference');await page.locator('#gravity').uncheck();await tool('grab');
  const beforeGrab=await inspect(),p=await point(.10,.56);await page.mouse.move(p.x,p.y);await page.mouse.down();
  await page.waitForFunction(()=>workbench.inspect().snapshot.design.model.grabbed!==null);
  // Multiple pointer events arrive while the background reference solve runs.
  await page.mouse.move(p.x+18,p.y-7,{steps:3});await page.mouse.move(p.x+43,p.y-18,{steps:5});
  const held=(await inspect()).snapshot.design.model.grabbed;assert.ok(held);const index=held.index,target=held.target;
  await page.mouse.up();
  await page.waitForFunction(()=>{const s=workbench.inspect();return !s.computing&&s.snapshot.design.model.grabbed===null&&s.history.includes('抓取并释放');},null,{timeout:30000});
  let s=await inspect();assert.equal(s.playing,false);assert.notDeepEqual(s.positions,beforeGrab.positions);const final=s.positions.slice(index*3,index*3+3);assert.ok(Math.hypot(...final.map((x,k)=>x-target[k]))<1e-6,'paused drag must finish at latest requested target');
  const releasedSteps=s.steps,releasedPositions=s.positions;await page.waitForTimeout(500);s=await inspect();assert.equal(s.steps,releasedSteps);assert.deepEqual(s.positions,releasedPositions);assert.equal(s.snapshot.design.model.grabbed,null);check('paused pointer drag flushes latest target, releases, records history and stops stepping');
  await page.locator('#undo-button').click();s=await inspect();assert.deepEqual(s.positions,beforeGrab.positions);await page.locator('#redo-button').click();s=await inspect();assert.deepEqual(s.positions,releasedPositions);assert.equal(s.snapshot.design.model.grabbed,null);check('grab undo and redo restore completed paused states without stale worker writes');

  await page.locator('[data-scene=patch]').click();await tool('shape');const beforeShape=await inspect(),a=await point(.64,.72);
  await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(a.x+30,a.y-13,{steps:24});await page.mouse.up();
  s=await inspect();const rest=s.snapshot.design.model.rest,operations=s.operations,shapeRevision=s.revision;assert.ok(operations.length>=beforeShape.operations.length+8,'fast sequence should retain multiple rest-edit source operations');assert.notDeepEqual(rest,beforeShape.snapshot.design.model.rest);assert.ok(s.history.includes('修改自然轮廓'));assert.equal(s.designId,beforeShape.designId);
  const saved=await download('#export-button','interaction-shape.json');await page.locator('#file-input').setInputFiles('evidence/interaction-shape.json');await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('已恢复'));
  s=await inspect();assert.equal(s.revision,shapeRevision);assert.deepEqual(s.operations,operations);assert.deepEqual(s.snapshot.design.model.rest,rest);assert.deepEqual(s.snapshot.design.model.positions,saved.design.model.positions);check('rapid pattern moves retain every semantic operation and pass strict file restoration');

  await open('#material-data-controls');await page.locator('#material-source-type').selectOption('synthetic');await page.locator('#material-file').setInputFiles('dist/data/synthetic-material.csv');await page.waitForFunction(()=>workbench.inspect().material?.sourceType==='synthetic');
  const beforeBadMaterial=await inspect();
  await page.locator('#material-file').setInputFiles({name:'bad-width.csv',mimeType:'text/csv',buffer:Buffer.from('direction,strain,forceN,widthM,gaugeM\nwarp,0,0,.05,.1\nwarp,.2,1,NaN,.1')});
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('widthM'));
  s=await inspect();assert.deepEqual(s.material,beforeBadMaterial.material);assert.equal(s.revision,beforeBadMaterial.revision);assert.deepEqual(s.snapshot.design.model.rest,beforeBadMaterial.snapshot.design.model.rest);
  await page.locator('#material-source-type').selectOption('measured');await page.locator('#material-file').setInputFiles('dist/data/synthetic-material.csv');await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('禁止改标'));
  s=await inspect();assert.deepEqual(s.material,beforeBadMaterial.material);assert.equal(s.revision,beforeBadMaterial.revision);check('bad CSV units/data and forbidden synthetic relabeling leave material and design untouched');

  await open('#manufacturing-controls');await page.locator('#machine-demo').click();await page.waitForFunction(()=>workbench.inspect().machine?.provenance.status==='hypothetical');
  const beforeBadMachine=await inspect(),unknown={...beforeBadMachine.machine,schema:'unknown-machine-profile'};
  await page.locator('#machine-file').setInputFiles({name:'unknown-machine.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(unknown))});await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('类型或版本无效'));
  s=await inspect();assert.deepEqual(s.machine,beforeBadMachine.machine);assert.equal(s.revision,beforeBadMachine.revision);assert.deepEqual(s.snapshot.design.model.rest,beforeBadMachine.snapshot.design.model.rest);check('unknown machine JSON is rejected before replacing profile or changing revision');
  await page.locator('#manufacturing-check').click();s=await inspect();const checkedRevision=s.revision;assert.equal(checkedRevision,beforeBadMachine.revision);assert.ok((await page.locator('#manufacturing-status').textContent()).includes(`版本 ${checkedRevision}`));
  await tool('shape');const q=await point(.78,.70);await page.mouse.move(q.x,q.y);await page.mouse.down();await page.mouse.move(q.x+8,q.y+4,{steps:3});await page.mouse.up();
  s=await inspect();assert.ok(s.revision>checkedRevision);assert.match(await page.locator('#manufacturing-status').textContent(),/重新检查/);assert.equal(await page.locator('#structure-state').textContent(),'待检查');
  const pack=await download('#manufacturing-export','interaction-tech-pack.json');s=await inspect();assert.equal(pack.designId,s.designId);assert.equal(pack.revision,s.revision);assert.equal(pack.ruleReport.revision,s.revision);assert.equal(pack.nativeProgram,null);assert.equal(pack.ruleReport.states.device.evidence,'hypothetical');check('structural edits invalidate prior machine checks and exported tech pack uses current revision');
  const badFile=structuredClone(s.snapshot);badFile.design.model.constraints[0].compliance*=2;
  await page.locator('#file-input').setInputFiles({name:'bad-source-compliance.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(badFile))});await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('不一致'));
  const afterBadFile=await inspect();assert.equal(afterBadFile.designId,s.designId);assert.equal(afterBadFile.revision,s.revision);assert.deepEqual(afterBadFile.snapshot.design.model.rest,s.snapshot.design.model.rest);assert.deepEqual(afterBadFile.material,s.material);assert.deepEqual(afterBadFile.machine,s.machine);check('inconsistent source file import is atomic across design material and machine');
  await page.reload();await page.waitForFunction(()=>window.workbench?.inspect);await pause();await open('#solver-controls');await page.locator('#quality').selectOption('reference');await page.locator('#gravity').uncheck();await tool('grab');
  const rapidPoint=await point(.1,.56);
  await page.mouse.move(rapidPoint.x,rapidPoint.y);await page.mouse.down();await page.mouse.move(rapidPoint.x+20,rapidPoint.y-5);await page.mouse.up();
  const firstPending=(await inspect()).computing;
  await page.mouse.move(rapidPoint.x,rapidPoint.y);await page.mouse.down();await page.mouse.move(rapidPoint.x+30,rapidPoint.y-10);await page.mouse.up();
  await page.waitForFunction(()=>{const s=workbench.inspect();return !s.computing&&s.snapshot.design.model.grabbed===null&&s.history.includes('抓取并释放');},null,{timeout:30000});
  const rapidFinal=await inspect();assert.equal(rapidFinal.history.filter(x=>x==='抓取并释放').length,2,`two complete gestures must remain undoable; first worker pending=${firstPending}`);check('two rapid paused drags each retain their own completed history entry');
  assert.deepEqual(errors,[]);await page.screenshot({path:'evidence/interaction-final.png',fullPage:true});
}catch(error){failure={message:error.message,stack:error.stack};await page.screenshot({path:'evidence/interaction-failure.png',fullPage:true}).catch(()=>{});throw error;
}finally{await writeFile('evidence/interaction-browser-report.json',JSON.stringify({date:new Date().toISOString(),checks,errors,failure},null,2));await browser.close();}
