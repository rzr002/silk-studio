import {LAB_URL} from './lab-url.mjs';
import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';

const playwright=loadPlaywright();
await mkdir('evidence',{recursive:true});
const browser=await playwright.chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
const report={date:new Date().toISOString(),checks:[],pageErrors:[],consoleErrors:[],failure:null};
page.on('pageerror',error=>report.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
const inspect=()=>page.evaluate(()=>workbench.inspect());
const pass=name=>{report.checks.push(name);console.log('PASS',name);};
async function download(id,name){const pending=page.waitForEvent('download');await page.locator(id).click();const file=await pending;await file.saveAs(`evidence/${name}`);return JSON.parse(await readFile(`evidence/${name}`,'utf8'));}
function unverified(pack){assert.equal(pack.evidenceVerified,false);assert.equal(pack.productionVerified,false);assert.equal(pack.nativeProgram,null);assert.notEqual(pack.manufacturingStatus,'sample-verified');assert.equal(pack.ruleReport.evidenceVerified,false);assert.equal(pack.ruleReport.productionVerified,false);assert.equal(pack.ruleReport.states.sample.evidenceVerified,false);assert.equal(pack.ruleReport.states.device.evidenceVerified,false);}
try{
  await page.goto(LAB_URL);await page.waitForFunction(()=>window.workbench?.inspect);
  assert.equal((await inspect()).playing,false);assert.equal((await inspect()).settings.backend,'browser');
  await page.locator('#manufacturing-controls>summary').click();await page.locator('#machine-demo').click();await page.waitForFunction(()=>workbench.inspect().machine?.provenance.status==='hypothetical');
  const hypothetical=await download('#manufacturing-export','manufacturing-hypothetical-pack.json');unverified(hypothetical);assert.equal(hypothetical.manufacturingStatus,'unverified');assert.equal(hypothetical.machineProfile.provenance.evidenceVerified,false);pass('actual hypothetical-device UI export retains unverified sample, device and production states');

  const profile=JSON.parse(await readFile('dist/data/hypothetical-machine.json','utf8'));
  profile.provenance={status:'sample-verified',source:'UNVERIFIED TEST DECLARATION',evidenceVerified:true};
  await page.locator('#machine-file').setInputFiles({name:'self-asserted-machine.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(profile))});
  await page.waitForFunction(()=>workbench.inspect().machine?.provenance.declaredStatus==='sample-verified');
  const claimed=await inspect();assert.equal(claimed.machine.provenance.status,'documented');assert.equal(claimed.machine.provenance.evidenceVerified,false);
  const input=await download('#export-button','manufacturing-source-before-claim.json');
  input.design.boundaries={castOn:true,bindOff:true};input.design.sampleEvidence={revision:input.design.revision,status:'passed',recordId:'UNVERIFIED-SAMPLE-DECLARATION',evidenceVerified:true,verified:true};
  await writeFile('evidence/manufacturing-declared-input.json',JSON.stringify(input));
  await page.locator('#file-input').setInputFiles('evidence/manufacturing-declared-input.json');await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('已恢复'));
  const loaded=await inspect();assert.equal(loaded.snapshot.design.sampleEvidence.recordId,'UNVERIFIED-SAMPLE-DECLARATION');assert.equal(loaded.snapshot.design.manufacturing.status,'unverified');
  await page.locator('#manufacturing-check').click();assert.equal(await page.locator('#sample-state').textContent(),'未验证');assert.match(await page.locator('#manufacturing-issues').textContent(),/声明|外部验证/);
  const pack=await download('#manufacturing-export','manufacturing-declared-pack.json');unverified(pack);assert.equal(pack.designId,loaded.designId);assert.equal(pack.revision,loaded.revision);assert.equal(pack.ruleReport.revision,loaded.revision);assert.equal(pack.manufacturingStatus,'sample-required');assert.equal(pack.ruleReport.states.sample.status,'unverified');assert.equal(pack.ruleReport.states.sample.declaredStatus,'passed');assert.equal(pack.ruleReport.states.sample.recordId,'UNVERIFIED-SAMPLE-DECLARATION');assert.equal(pack.ruleReport.states.sample.revision,loaded.revision);assert.equal(pack.machineProfile.provenance.status,'documented');assert.equal(pack.machineProfile.provenance.declaredStatus,'sample-verified');assert.equal(pack.machineProfile.provenance.evidenceVerified,false);pass('actual source import and tech-pack export preserve declared sample identity without attesting the sample or production');
  report.final={designId:pack.designId,revision:pack.revision,manufacturingStatus:pack.manufacturingStatus,states:pack.ruleReport.states,evidenceVerified:pack.evidenceVerified,productionVerified:pack.productionVerified,nativeProgram:pack.nativeProgram};
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);await page.screenshot({path:'evidence/manufacturing-declaration.png',fullPage:true});
}catch(error){report.failure={message:error.message,stack:error.stack};await page.screenshot({path:'evidence/manufacturing-declaration-failure.png',fullPage:true}).catch(()=>{});throw error;
}finally{await writeFile('evidence/manufacturing-declaration-browser-report.json',JSON.stringify(report,null,2));await browser.close();}
