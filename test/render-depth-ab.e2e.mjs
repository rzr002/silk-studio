import {LAB_URL} from './lab-url.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadPlaywright} from './playwright.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const playwright=loadPlaywright();
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fixturePath=resolve('evidence/native-checkpoint-fixture-a27588c1b42f.json');
const fixtureText=await readFile(fixturePath,'utf8'),fixture=JSON.parse(fixtureText);
assert.equal(digest(fixtureText).slice(0,12),'a27588c1b42f');
assert.ok(Math.abs(fixture.pose-17.5)<1e-10);assert.equal(fixture.playing,false);
const sourcePath=resolve('dist/scene.mjs'),sourceText=await readFile(sourcePath,'utf8'),sourceHash=digest(sourceText);
const cameraFragment='new THREE.PerspectiveCamera(34,1,.01,20)';
const shadowFragment='this.mesh.receiveShadow=true;';
const probeFragment='this.resizeObserver=new ResizeObserver';
function replaceOnce(text,from,to){assert.equal(text.split(from).length-1,1,`exactly one source fragment: ${from}`);return text.replace(from,to);}
for(const fragment of [cameraFragment,shadowFragment,probeFragment])replaceOnce(sourceText,fragment,fragment);
const variants=[
  {id:'baseline',near:.01,far:20,clothShadow:true},
  {id:'near05-far5',near:.05,far:5,clothShadow:true},
  {id:'cloth-no-shadow',near:.01,far:20,clothShadow:false},
];
const regions={
  kneeContour:{x:562,y:390,width:22,height:78},
  ankleContour:{x:532,y:730,width:42,height:88},
  kneeInterior:{x:590,y:392,width:18,height:45},
  backgroundControl:{x:520,y:390,width:24,height:70},
};
const report={date:new Date().toISOString(),scope:'isolated routed-renderer A/B; identical checkpoint imported using actual file input; no native solve',fixturePath,fixtureHash:digest(fixtureText),sceneSourceHash:sourceHash,regions,variants:[],nativeStepAttempts:[],pageErrors:[],consoleErrors:[]};
const browser=await playwright.chromium.launch({headless:true});
let baselinePixels;
async function inspectScene(page){return page.evaluate(()=>{
  const s=window.__renderABScene,w=workbench.inspect(),gl=s.renderer.getContext(),m=s.camera.matrixWorldInverse.elements;
  const depthRange=positions=>{let min=Infinity,max=-Infinity,clippedNear=0;for(let i=0;i<positions.length;i+=3){const z=-(m[2]*positions[i]+m[6]*positions[i+1]+m[10]*positions[i+2]+m[14]);min=Math.min(min,z);max=Math.max(max,z);if(z<s.camera.near)clippedNear++;}return {min,max,clippedNear};};
  return {pose:w.pose,targetPose:w.targetPose,steps:w.steps,playing:w.playing,computing:w.computing,snapshot:w.snapshot,rendering:w.rendering,
    depthBits:gl.getParameter(gl.DEPTH_BITS),contextAttributes:gl.getContextAttributes(),camera:{near:s.camera.near,far:s.camera.far,position:s.camera.position.toArray(),quaternion:s.camera.quaternion.toArray(),target:s.target.toArray(),angle:s.angle,elevation:s.elevation,distance:s.distance},
    clothReceiveShadow:s.mesh.receiveShadow,bodyReceiveShadow:s.body.receiveShadow,clothDepthTest:s.material.depthTest,clothDepthWrite:s.material.depthWrite,
    depthRanges:{cloth:depthRange(s.model.positions),body:depthRange(s.body.geometry.attributes.position.array)},canvasRect:s.renderer.domElement.getBoundingClientRect().toJSON()};
});}
async function pixels(page){return page.locator('#viewport canvas').evaluate(canvas=>canvas.toDataURL('image/png'));}
async function comparePixels(page,before,after){return page.evaluate(async({before,after,regions})=>{
  const load=async url=>{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return {width:canvas.width,height:canvas.height,data:context.getImageData(0,0,canvas.width,canvas.height).data};};
  const a=await load(before),b=await load(after),rect=document.querySelector('#viewport canvas').getBoundingClientRect();
  if(a.width!==b.width||a.height!==b.height)throw Error('A/B canvas dimensions differ');
  const scaleX=a.width/rect.width,scaleY=a.height/rect.height,Y=(data,x,y)=>{const i=(y*a.width+x)*4;return .2126*data[i]+.7152*data[i+1]+.0722*data[i+2];};
  const out={width:a.width,height:a.height,regions:{}};
  for(const [name,r]of Object.entries(regions)){
    const x0=Math.round((r.x-rect.x)*scaleX),y0=Math.round((r.y-rect.y)*scaleY),width=Math.round(r.width*scaleX),height=Math.round(r.height*scaleY);
    let baselineDark=0,variantDark=0,baselineLocalOutliers=0,variantLocalOutliers=0,darkRecovered=0,changedAbove12=0,sumAbsDelta=0,maxAbsDelta=0;const changed=[];
    const localOutlier=(data,x,y,yValue)=>{if(yValue>=90)return false;const neighbours=[];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)neighbours.push(Y(data,x+dx,y+dy));neighbours.sort((p,q)=>p-q);return neighbours[4]-yValue>12;};
    for(let y=y0;y<y0+height;y++)for(let x=x0;x<x0+width;x++){
      const av=Y(a.data,x,y),bv=Y(b.data,x,y),delta=bv-av,abs=Math.abs(delta);baselineDark+=av<75;variantDark+=bv<75;baselineLocalOutliers+=localOutlier(a.data,x,y,av);variantLocalOutliers+=localOutlier(b.data,x,y,bv);darkRecovered+=av<75&&delta>12;changedAbove12+=abs>12;sumAbsDelta+=abs;maxAbsDelta=Math.max(maxAbsDelta,abs);if(abs>12)changed.push({x:rect.x+x/scaleX,y:rect.y+y/scaleY,baselineY:av,variantY:bv});
    }
    out.regions[name]={pixels:width*height,baselineDark,variantDark,baselineLocalOutliers,variantLocalOutliers,darkRecovered,changedAbove12,changedFraction:changedAbove12/(width*height),meanAbsLumaDelta:sumAbsDelta/(width*height),maxAbsLumaDelta:maxAbsDelta,changedSamples:changed.slice(0,40)};
  }
  return out;
},{before,after,regions});}
try{
  await mkdir('evidence',{recursive:true});
  for(const variant of variants){
    const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1}),page=await context.newPage();let routed=0;
    page.on('pageerror',error=>report.pageErrors.push({variant:variant.id,message:error.message}));
    page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push({variant:variant.id,message:message.text()});});
    await page.route('**/api/reference-step',async route=>{report.nativeStepAttempts.push({variant:variant.id,method:route.request().method()});await route.abort('blockedbyclient');});
    await page.route('**/scene.mjs',async route=>{
      routed++;const response=await route.fetch();let text=await response.text();assert.equal(digest(text),sourceHash,'server scene source must match frozen on-disk source');
      if(variant.near!==.01)text=replaceOnce(text,cameraFragment,`new THREE.PerspectiveCamera(34,1,${variant.near},${variant.far})`);
      if(!variant.clothShadow)text=replaceOnce(text,shadowFragment,'this.mesh.receiveShadow=false;');
      text=replaceOnce(text,probeFragment,'window.__renderABScene=this;this.resizeObserver=new ResizeObserver');
      await route.fulfill({response,body:text,contentType:'text/javascript'});
    });
    await page.goto(LAB_URL);await page.waitForFunction(()=>window.workbench?.inspect);
    await page.locator('#file-input').setInputFiles(fixturePath);
    await page.waitForFunction(id=>workbench.inspect().designId===id,fixture.design.id);
    await page.waitForFunction(()=>workbench.inspect().rendering?.dirty===false);await page.waitForTimeout(250);
    const state=await inspectScene(page);assert.deepEqual(state.snapshot,fixture,'complete imported source/dynamics must remain identical');assert.equal(state.steps,0);assert.equal(state.playing,false);assert.equal(state.computing,false);assert.equal(routed,1);
    assert.equal(state.camera.near,variant.near);assert.equal(state.camera.far,variant.far);assert.equal(state.clothReceiveShadow,variant.clothShadow);
    const projection=await page.evaluate(()=>[[.2,.2],[.2,.5],[.7,.8]].map(([u,v])=>workbench.projectUV(u,v)));
    if(report.variants.length){assert.deepEqual(state.camera.position,report.variants[0].initial.camera.position);assert.deepEqual(state.camera.quaternion,report.variants[0].initial.camera.quaternion);assert.deepEqual(projection,report.variants[0].projection);}
    const initialPixels=await pixels(page);baselinePixels??=initialPixels;
    const metrics=await comparePixels(page,baselinePixels,initialPixels);
    const fullPath=`evidence/render-ab-${variant.id}.png`,localPath=`evidence/render-ab-${variant.id}-local.png`;
    await page.screenshot({path:fullPath,fullPage:true});
    await page.screenshot({path:localPath,clip:{x:515,y:385,width:180,height:450}});
    await page.screenshot({path:`evidence/render-ab-${variant.id}-knee.png`,clip:{x:550,y:385,width:125,height:95}});
    await page.screenshot({path:`evidence/render-ab-${variant.id}-ankle.png`,clip:{x:515,y:725,width:145,height:105}});
    const entry={...variant,initial:{...state,snapshotHash:digest(state.snapshot),snapshot:undefined},projection,metrics,files:{fullPath,localPath}};report.variants.push(entry);

    // Use the real wheel UI to reach the existing maximum zoom clamp, without
    // writing scene parameters or any workbench data from the test.
    const box=await page.locator('#viewport').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-2000);
    await page.waitForFunction(()=>window.__renderABScene.distance===.6&&workbench.inspect().rendering.dirty===false);
    const maxZoom=await inspectScene(page);assert.deepEqual(maxZoom.snapshot,fixture);assert.equal(maxZoom.camera.distance,.6);
    const zoomProjection=await page.evaluate(()=>workbench.projectUV(.2,.5));await page.mouse.wheel(0,-500);await page.waitForTimeout(150);assert.deepEqual(await page.evaluate(()=>workbench.projectUV(.2,.5)),zoomProjection,'the real zoom clamp is reached');
    entry.maxZoom={...maxZoom,snapshotHash:digest(maxZoom.snapshot),snapshot:undefined};
    await page.screenshot({path:`evidence/render-ab-${variant.id}-max-zoom.png`,fullPage:true});
    assert.equal(maxZoom.depthRanges.cloth.clippedNear,0,'maximum zoom must not clip cloth vertices at the near plane');
    assert.equal(maxZoom.depthRanges.body.clippedNear,0,'maximum zoom must not clip body vertices at the near plane');
    assert.deepEqual(report.nativeStepAttempts,[]);await context.close();
    console.log('PASS',variant.id,JSON.stringify({depthBits:state.depthBits,metrics:metrics.regions,maxZoomDepthRanges:entry.maxZoom.depthRanges}));
  }
  assert.deepEqual(report.nativeStepAttempts,[]);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.equal(digest(await readFile(sourcePath,'utf8')),sourceHash,'product scene source must remain byte-identical');
  report.passed=true;
}catch(error){report.failure=error.stack;throw error;}
finally{await writeFile('evidence/render-depth-ab-report.json',JSON.stringify(report,null,2));await browser.close();}
