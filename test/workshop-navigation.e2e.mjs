import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const playwright=loadPlaywright();
const url=new URL('/',process.env.WORKSHOP_URL||process.env.DEMO_URL||'http://127.0.0.1:4197').href;
const fixture=process.env.WORKSHOP_FIXTURE||'examples/finished-stocking.json';
const bytes=await readFile(fixture),project=JSON.parse(bytes),a=project.workshop;
assert.equal(project.schema,'silk-workshop-project');assert.ok(project.design&&project.bridge&&a.wear.inspection.passed);
await mkdir('evidence',{recursive:true});
const fixtureHash=createHash('sha256').update(bytes).digest('hex'),preservedFixture=`evidence/workshop-fixture-${fixtureHash.slice(0,16)}.json`;
await writeFile(preservedFixture,bytes);
const browser=await playwright.chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
await page.addInitScript(()=>{window.__workshopPageShows=[];addEventListener('pageshow',e=>window.__workshopPageShows.push({persisted:e.persisted}));});
const report={date:new Date().toISOString(),url,fixture,preservedFixture,fixtureHash,fixtureBytes:bytes.length,sourceId:a.id,sourceRevision:a.revision,checks:[],nativeRequests:[],pageErrors:[],consoleErrors:[],failure:null};
page.on('request',r=>{if(new URL(r.url()).pathname==='/api/reference-step')report.nativeRequests.push(r.method());});
page.on('pageerror',e=>report.pageErrors.push(e.message));
page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());});
const reportPath='evidence/workshop-navigation-report.json',started=Date.now();
function pass(name){report.checks.push(name);writeFileSync(reportPath,JSON.stringify(report,null,2));console.log('PASS',`${((Date.now()-started)/1000).toFixed(1)}s`,name);}
const inspect=()=>page.evaluate(()=>workshop.inspect());
const labInspect=()=>page.evaluate(()=>workbench.inspect());
async function waitState(predicate,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){const state=await inspect();if(predicate(state))return state;await page.waitForTimeout(100);}throw new Error('Expected workshop state transition did not occur');}
async function download(button,path){const [file]=await Promise.all([page.waitForEvent('download'),page.locator(button).click()]);await file.saveAs(path);return readFile(path);}
async function labUpload(path){await page.locator('#file-input').setInputFiles(path);await page.waitForFunction(()=>document.querySelector('#file-input').value==='');}
async function photo(label){
  const state=await inspect();assert.equal(state.rendering.disposed,false);
  const rect=await page.locator('#workshop-viewport').boundingBox(),draws=state.rendering.draws;
  await page.mouse.move(rect.x+rect.width*.55,rect.y+rect.height*.4);await page.mouse.down({button:'right'});await page.mouse.move(rect.x+rect.width*.55+70,rect.y+rect.height*.4+15,{steps:5});await page.mouse.up({button:'right'});
  await waitState(s=>s.rendering.draws>draws);
  const image=await download('#photo',`evidence/workshop-${label}.png`);
  assert.deepEqual([...image.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  const pixels=await page.evaluate(async data=>{const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const values=ctx.getImageData(0,0,canvas.width,canvas.height).data,colors=new Set();for(let i=0;i<values.length;i+=4*97)colors.add(`${values[i]},${values[i+1]},${values[i+2]}`);return {width:canvas.width,height:canvas.height,colors:colors.size};},image.toString('base64'));
  assert.ok(pixels.width>0&&pixels.height>0&&pixels.colors>30,'the real returned canvas PNG must be nonblank');
  report[label]=pixels;
}

try{
  await page.goto(url);await page.waitForFunction(()=>window.workshop?.inspect);
  await page.locator('#load-file').setInputFiles(preservedFixture);await waitState(s=>s.snapshot.id===a.id);
  assert.deepEqual((await inspect()).snapshot,a);
  const nav=page.waitForURL('**/lab.html');await page.locator('#send-to-lab').click();await nav;await page.waitForFunction(()=>window.workbench?.inspect);
  let lab=await labInspect();assert.deepEqual(lab.snapshot.design,project.design);assert.equal(lab.playing,false);assert.equal(lab.computing,false);
  const origin=lab.snapshot.workshopOrigin;assert.deepEqual(origin.workshop,a);assert.deepEqual(origin.bridge,project.bridge);
  pass('a real finished file opens the exact source and making origin in the professional lab');
  const sourcePath='evidence/workshop-navigation-lab-source.json',source=JSON.parse(await download('#export-button',sourcePath));
  assert.deepEqual(source.workshopOrigin,origin);assert.deepEqual(source.design,project.design);
  await page.locator('#manufacturing-controls > summary').click();
  const pack=JSON.parse(await download('#manufacturing-export','evidence/workshop-navigation-tech-pack.json'));
  assert.deepEqual(pack.workshopOrigin,origin);assert.equal(pack.nativeProgram,null);assert.equal(pack.productionVerified,false);assert.equal(pack.evidenceVerified,false);
  pass('actual source and technical pack downloads preserve making origin without promoting manufacturing');
  await labUpload(sourcePath);lab=await labInspect();assert.deepEqual(lab.snapshot.workshopOrigin,origin);assert.deepEqual(lab.snapshot.design,project.design);
  await page.locator('#save-button').click();assert.match(await page.locator('#toast').textContent(),/已保存/);await page.reload();await page.waitForFunction(()=>window.workbench?.inspect);lab=await labInspect();assert.deepEqual(lab.snapshot.workshopOrigin,origin);assert.deepEqual(lab.snapshot.design,project.design);assert.equal(lab.playing,false);assert.equal(lab.computing,false);
  pass('lab file upload and actual save/reload retain the complete original workshop source');
  await page.goBack({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.workshop?.inspect);report.backPageShows=await page.evaluate(()=>window.__workshopPageShows);assert.deepEqual((await inspect()).snapshot,a);await photo('navigation-back');
  pass('actual browser back retains the source, orbit redraw and a nonblank downloadable workshop canvas');
  await page.locator('#new-piece').click();const b=(await inspect()).snapshot;assert.notEqual(b.id,a.id);await page.locator('#save').click();const savedB=await page.evaluate(()=>JSON.parse(localStorage.getItem('silk-workshop-v1')));assert.deepEqual(savedB.workshop,b);report.otherSavedId=b.id;
  await page.locator('.rail-bottom a').click();await page.waitForURL('**/lab.html');await page.waitForFunction(()=>window.workbench?.inspect);await labUpload(sourcePath);
  await page.locator('#material-data-controls > summary').click();const originalLink=page.locator('#workshop-origin-note');assert.equal(await originalLink.isVisible(),true);await originalLink.click();await page.waitForURL(url);await page.waitForFunction(()=>window.workshop?.inspect);await waitState(s=>s.snapshot.id===a.id);
  assert.deepEqual((await inspect()).snapshot,a);assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('silk-workshop-v1'))),savedB);await photo('navigation-origin-a');
  pass('the actual original-source link opens A while leaving the separately saved project B untouched');
  await page.locator('[data-station="knit"]').click();await page.locator('.repair-tools summary').click();await page.locator('#unravel-course').fill('0');await page.locator('#unravel').click();assert.equal((await inspect()).snapshot.production.producedCourses,0);
  await page.locator('#start-knit').click();await waitState(s=>s.snapshot.production.producedCourses>=2);const before=await inspect();await page.locator('#unravel-course').fill('100');await page.locator('#unravel').click();assert.match(await page.locator('#workshop-toast').textContent(),/拆|范围|无效|整数/);const refused=await inspect();assert.equal(refused.snapshot.production.running,true);
  const grown=await waitState(s=>s.snapshot.production.producedCourses>refused.snapshot.production.producedCourses,5000);assert.ok(grown.snapshot.production.producedCourses>before.snapshot.production.producedCourses);
  await page.locator('#pause-knit').click();const paused=(await inspect()).snapshot;assert.equal(paused.production.running,false);await page.waitForTimeout(800);assert.deepEqual((await inspect()).snapshot,paused);
  pass('an illegal unravel request refuses without stopping production and the real pause control still works');
  assert.deepEqual(report.nativeRequests,[]);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);pass('the navigation and repair routes make zero native requests and raise no browser errors');
}catch(error){report.failure={message:error.message,stack:error.stack};await page.screenshot({path:'evidence/workshop-navigation-failure.png',fullPage:true}).catch(()=>{});report.observed=await page.evaluate(()=>window.workshop?.inspect?.()||window.workbench?.inspect?.()||null).catch(()=>null);throw error;}
finally{await writeFile(reportPath,JSON.stringify(report,null,2));await browser.close();}
