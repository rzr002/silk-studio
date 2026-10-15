import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const playwright=loadPlaywright();
const url=new URL('/',process.env.WORKSHOP_URL||process.env.DEMO_URL||'http://127.0.0.1:4197').href;
const browser=await playwright.chromium.launch({headless:true});
const report={date:new Date().toISOString(),url,scope:'workshop responsive display, view controls, PNG and idle rendering',checks:[],errors:[],nativeRequests:[]};
await mkdir('evidence',{recursive:true});
const pass=name=>{report.checks.push(name);console.log('PASS',name);};
try{
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const page=await browser.newPage({viewport,hasTouch:viewport.width===390,isMobile:viewport.width===390});
    page.on('pageerror',error=>report.errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/reference-step')report.nativeRequests.push(request.method());});
    await page.goto(url);await page.waitForFunction(()=>window.workshop&& !document.querySelector('#workshop-loading'));
    const prefix=viewport.width===390?'mobile':'desktop';
    await page.waitForFunction(()=>!workshop.inspect().motion?.cameraMoving);
    const layout=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,canvas:document.querySelector('#workshop-viewport canvas').getBoundingClientRect().toJSON(),spool:workshop.projectObject('yarn-nylon-stretch')}));
    report[prefix]=layout;assert.ok(layout.documentWidth<=layout.width,`${prefix} must not have horizontal overflow`);
    assert.ok(layout.canvas.width>250&&layout.canvas.height>=400);
    assert.ok(layout.spool.x>0&&layout.spool.x<layout.canvas.width&&layout.spool.y>0&&layout.spool.y<layout.canvas.height,`${prefix} selected spool must be within the visible workroom`);
    for(const id of ['spindle','guide-1','tensioner','feeder']){
      const p=await page.evaluate(id=>workshop.projectObject(id),id);
      assert.ok(p&&p.x>=20&&p.x<=layout.canvas.width-20&&p.y>=55&&p.y<=layout.canvas.height-110,`${prefix} ${id} must fit above the task card`);
    }
    assert.equal((await page.evaluate(()=>workshop.inspect())).geometry.faces,0);
    await page.screenshot({path:`evidence/workshop-${prefix}.png`,fullPage:true});pass(`${prefix} actual homepage fits the viewport and starts without finished cloth`);
    await page.waitForFunction(()=>!workshop.inspect().motion?.active);
    const before=await page.evaluate(()=>workshop.inspect().rendering);
    await page.waitForTimeout(1000);const idle=await page.evaluate(()=>workshop.inspect().rendering);
    assert.equal(idle.draws,before.draws);assert.ok(idle.skipped>before.skipped);pass(`${prefix} idle workroom does not redraw WebGL continuously`);
    const canvas=page.locator('#workshop-viewport canvas'),box=await canvas.boundingBox();
    await page.mouse.move(box.x+box.width*.6,box.y+box.height*.6);await page.mouse.down({button:'right'});await page.mouse.move(box.x+box.width*.7,box.y+box.height*.64,{steps:10});await page.mouse.up({button:'right'});
    await page.mouse.wheel(0,-120);await page.waitForTimeout(150);
    const moved=await page.evaluate(()=>workshop.inspect().rendering);assert.ok(moved.draws>idle.draws);
    await page.locator('#reset-view').click();await page.waitForFunction(()=>!workshop.inspect().motion?.cameraMoving);
    const restored=await page.evaluate(()=>workshop.projectObject('yarn-nylon-stretch'));assert.ok(Math.hypot(restored.x-layout.spool.x,restored.y-layout.spool.y)<.01);pass(`${prefix} orbit, zoom and return-to-station update the actual view`);
    const downloadPromise=page.waitForEvent('download');await page.locator('#photo').click();const download=await downloadPromise;const file=`evidence/workshop-${prefix}-photo.png`;await download.saveAs(file);const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);assert.ok(Buffer.concat(chunks).length>10000);pass(`${prefix} photo exports the rendered 3D workshop`);
    await page.locator('[data-station="finish"]').click();assert.equal(await page.locator('#dye').isEnabled(),false);assert.equal(await page.locator('#heat').isEnabled(),false);assert.equal((await page.evaluate(()=>workshop.inspect())).stage,'yarn');pass(`${prefix} looking at a future station does not skip manufacturing prerequisites`);
    if(prefix==='mobile'){
      await page.locator('[data-station="yarn"]').tap();
      const tapObject=async id=>{await canvas.scrollIntoViewIfNeeded();await page.waitForFunction(()=>!workshop.inspect().motion?.cameraMoving);const p=await page.evaluate(id=>workshop.projectObject(id),id),r=await canvas.boundingBox();await page.touchscreen.tap(r.x+p.x,r.y+p.y);};
      await tapObject('yarn-nylon-stretch');assert.equal((await page.evaluate(()=>workshop.inspect())).selectedYarn,'nylon-stretch');await page.locator('#mount-yarn').tap();
      report.mobileTouch=[];for(const [i,id] of ['guide-1','tensioner','feeder'].entries()){await tapObject(id);const current=await page.evaluate(()=>workshop.inspect());report.mobileTouch.push({id,stage:current.stage,path:current.snapshot.threading.path});assert.equal(current.snapshot.threading.path.length,i+1,`touching ${id} should add the next yarn guide`);}
      const state=await page.evaluate(()=>workshop.inspect());assert.equal(state.stage,'sample');assert.deepEqual(state.snapshot.threading.path,['guide-1','tensioner','feeder']);pass('mobile touch input selects the real spool and threads all three scene guides');
    }
    await page.close();
  }
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.nativeRequests,[]);report.passed=true;
}catch(error){report.failure={message:error.message,stack:error.stack};throw error;}
finally{await writeFile('evidence/workshop-view-report.json',JSON.stringify(report,null,2));await browser.close();}
