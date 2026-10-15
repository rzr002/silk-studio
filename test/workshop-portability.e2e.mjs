import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {restoreWorkshopProject} from '../dist/workshop-project.mjs';
import {loadPlaywright} from './playwright.mjs';

const source=JSON.parse(await readFile(new URL('../examples/finished-stocking.json',import.meta.url),'utf8'));
const normalized=restoreWorkshopProject(source).project;
const browser=await loadPlaywright().chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const report={date:new Date().toISOString(),scope:'actual UI roundtrip of a Chromium project normalized in Node',checks:[],errors:[],nativeRequests:[]};
const pass=name=>{report.checks.push(name);console.log('PASS',name);};
page.on('pageerror',e=>report.errors.push(e.message));
page.on('request',r=>{if(new URL(r.url()).pathname==='/api/reference-step')report.nativeRequests.push(r.method());});
try{
  const url=new URL('/',process.env.WORKSHOP_URL||'http://127.0.0.1:4197').href;
  assert.equal((await page.goto(url)).status(),200);
  await page.waitForFunction(()=>window.workshop?.inspect);
  assert.equal((await page.evaluate(()=>workshop.inspect())).stage,'yarn');
  pass('the clean public workshop starts from unmounted yarn');
  await page.locator('#load-file').setInputFiles({name:'node-normalized-project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(normalized))});
  await page.waitForFunction(id=>workshop.inspect().snapshot.id===id,source.workshop.id);
  await page.waitForFunction(()=>!workshop.inspect().motion.active);
  const current=await page.evaluate(()=>workshop.inspect());
  assert.deepEqual(current.snapshot,source.workshop);
  assert.equal(current.stage,'wear');
  pass('Chromium opens the Node-normalized completed project with identical making records');
  const tampered=structuredClone(normalized);tampered.design.model.positions[219]+=1e-8;
  await page.locator('#load-file').setInputFiles({name:'changed-geometry.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(tampered))});
  await page.waitForFunction(()=>document.querySelector('#load-file').value==='');
  assert.match(await page.locator('#workshop-toast').textContent(),/不一致/);
  assert.deepEqual((await page.evaluate(()=>workshop.inspect())).snapshot,current.snapshot);
  pass('the real file picker rejects changed geometry without mutating the current piece');
  await page.locator('#send-to-lab').click();await page.waitForURL('**/lab.html');
  await page.waitForFunction(()=>window.workbench?.inspect);
  const lab=await page.evaluate(()=>workbench.inspect());
  assert.equal(lab.designId,source.design.id);
  assert.equal(lab.revision,source.design.revision);
  assert.deepEqual(lab.snapshot.workshopOrigin.workshop,source.workshop);
  assert.equal(lab.snapshot.manufacturing.status,'unverified');
  pass('professional lab handoff retains the source and leaves production unverified');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.nativeRequests,[]);
  report.passed=true;
}catch(e){report.failure={message:e.message,stack:e.stack};throw e;}
finally{await mkdir('evidence',{recursive:true});await writeFile('evidence/public-portability-browser-report.json',JSON.stringify(report,null,2));await browser.close();}
