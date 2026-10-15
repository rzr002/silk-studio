import {LAB_URL} from './lab-url.mjs';
import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright.mjs';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const playwright=loadPlaywright();
const digest=text=>createHash('sha256').update(text).digest('hex');
const source=process.env.CHECKPOINT_FIXTURE||'evidence/native-motion-latest-accepted-state.json';
await mkdir('evidence',{recursive:true});
let text,fixture;
for(let attempt=0;attempt<4;attempt++){
  try{text=await readFile(source,'utf8');fixture=JSON.parse(text);break;}
  catch(error){if(attempt===3)throw error;await delay(100);}
}
assert.equal(fixture.format,'silk-design-workbench');assert.equal(fixture.version,2);assert.equal(fixture.playing,false,'the captured design file itself must be paused');
assert.equal(fixture.settings.backend,'native');assert.equal(fixture.design.model.collisionStats.reference.converged,true);assert.equal(fixture.design.pose,fixture.pose);assert.equal(fixture.design.model.collisionStats.reference.acceptedPose,fixture.pose);
const hash=digest(text),fixturePath=resolve(`evidence/native-checkpoint-fixture-${hash.slice(0,12)}.json`);
await writeFile(fixturePath,text);
const report={date:new Date().toISOString(),source,fixturePath,sha256:hash,acceptedPose:fixture.pose,targetPose:fixture.targetPose,designId:fixture.design.id,revision:fixture.design.revision,vertices:fixture.design.model.positions.length/3,pins:fixture.design.model.pins.length,settings:fixture.settings,runtime:fixture.design.model.collisionStats.reference.runtime,
  checks:[],nativeStepAttempts:[],pageErrors:[],consoleErrors:[],failure:null,guard:'Unexpected reference-step POSTs are blocked and counted; a passing run requires zero attempted computations.'};
await writeFile('evidence/native-checkpoint-fixture-manifest.json',JSON.stringify(report,null,2));
const browser=await playwright.chromium.launch({headless:true});
const pass=name=>{report.checks.push(name);console.log('PASS',name);};
async function newPage(){
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true}),page=await context.newPage();
  await page.route('**/api/reference-step',async route=>{report.nativeStepAttempts.push({url:route.request().url(),method:route.request().method()});await route.abort('blockedbyclient');});
  page.on('pageerror',error=>report.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
  await page.goto(LAB_URL);await page.waitForFunction(()=>window.workbench?.inspect);return page;
}
async function inspect(page){return page.evaluate(()=>workbench.inspect());}
async function importFile(page,path){
  await page.locator('#file-input').setInputFiles(path);
  await page.waitForFunction(()=>!!document.getElementById('toast').textContent,null,{timeout:15000});
  const toast=await page.locator('#toast').textContent();assert.match(toast,/已恢复/,`actual file import was rejected: ${toast}`);
}
function same(actual,stage){
  assert.equal(actual.playing,false,`${stage} must stay paused`);assert.equal(actual.computing,false,`${stage} must not start computation`);assert.equal(actual.steps,0,`${stage} must not advance simulation time`);assert.equal(actual.solverError,'');
  assert.equal(actual.designId,fixture.design.id);assert.equal(actual.revision,fixture.design.revision);assert.equal(actual.pose,fixture.pose);assert.equal(actual.targetPose,fixture.targetPose);assert.deepEqual(actual.settings,fixture.settings);
  assert.deepEqual(actual.positions,fixture.design.model.positions);assert.deepEqual(actual.snapshot.design.model.velocities,fixture.design.model.velocities);assert.deepEqual(actual.snapshot.design.model.pins,fixture.design.model.pins);assert.deepEqual(actual.snapshot.design.model.pinTargets,fixture.design.model.pinTargets);
  assert.deepEqual(actual.snapshot,fixture,`${stage} must preserve the full source and accepted dynamic snapshot`);
}
async function stable(page,stage){same(await inspect(page),stage);await page.waitForTimeout(1000);same(await inspect(page),`${stage} after idle`);assert.deepEqual(report.nativeStepAttempts,[],'opening a paused checkpoint must never attempt a native step');}
let page1,page2;
try{
  page1=await newPage();assert.equal((await inspect(page1)).playing,false);await importFile(page1,fixturePath);await stable(page1,'first file import');pass('actual checkpoint file import preserves complete source, accepted dynamics, fixed pins, pose and native settings without playback');
  await page1.screenshot({path:'evidence/native-checkpoint-open.png',fullPage:true});
  await page1.locator('#save-button').click();assert.match(await page1.locator('#toast').textContent(),/已保存/);await page1.reload();await page1.waitForFunction(()=>window.workbench?.inspect);await stable(page1,'local save and reload');pass('the actual save button and reload restore the full accepted checkpoint while remaining paused');
  const pending=page1.waitForEvent('download');await page1.locator('#export-button').click();const download=await pending,exportPath=resolve('evidence/native-checkpoint-export.json');await download.saveAs(exportPath);
  const exportedText=await readFile(exportPath,'utf8'),exported=JSON.parse(exportedText);assert.deepEqual(exported,fixture);report.exported={file:exportPath,sha256:digest(exportedText),acceptedPose:exported.pose};pass('actual JSON export preserves the complete accepted checkpoint');
  page2=await newPage();assert.notEqual((await inspect(page2)).designId,fixture.design.id,'the second context must not silently inherit the first context local storage');await importFile(page2,exportPath);await stable(page2,'second isolated page import');pass('a separate browser context imports the exported file with identical full state and no native computation');
  await page2.screenshot({path:'evidence/native-checkpoint-restored.png',fullPage:true});assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);report.passed=true;
}catch(error){report.failure={message:error.message,stack:error.stack};const page=page2||page1;if(page){report.observed=await inspect(page).catch(()=>null);await page.screenshot({path:'evidence/native-checkpoint-failure.png',fullPage:true}).catch(()=>{});}throw error;
}finally{await writeFile('evidence/native-checkpoint-browser-report.json',JSON.stringify(report,null,2));await browser.close();}
