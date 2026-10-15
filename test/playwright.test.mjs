import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const loaderFile=new URL('./playwright.mjs',import.meta.url);
const packageSource=id=>`module.exports={id:${JSON.stringify(id)},chromium:{launch(){}}};`;

async function packageAt(directory,source){
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'package.json'),JSON.stringify({name:'playwright',version:'0.0.0',main:'index.cjs'}));
  await writeFile(join(directory,'index.cjs'),source);
  return directory;
}

async function fixture(t,{installed=false,source=packageSource('project')}={}){
  assert.ok(existsSync(loaderFile),'a portable Playwright loader is required');
  const directory=await mkdtemp(join(tmpdir(),'silk-playwright-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await copyFile(loaderFile,join(directory,'playwright.mjs'));
  if(installed)await packageAt(join(directory,'node_modules','playwright'),source);
  return {directory,...await import(pathToFileURL(join(directory,'playwright.mjs')).href)};
}

function installationHint(error){
  assert.match(error.message,/npm install/);
  assert.match(error.message,/npx playwright install chromium/);
  assert.match(error.message,/PLAYWRIGHT_PATH/);
  return true;
}

test('loads a normally installed project Playwright package',async t=>{
  const {loadPlaywright}=await fixture(t,{installed:true});
  assert.equal(loadPlaywright('').id,'project');
});

test('explicit module directory overrides a normally installed package',async t=>{
  const {directory,loadPlaywright}=await fixture(t,{installed:true});
  const explicit=await packageAt(join(directory,'another installation'),packageSource('explicit'));
  assert.equal(loadPlaywright(explicit).id,'explicit');
});

test('accepts an explicitly selected module file in a path with spaces',async t=>{
  const {directory,loadPlaywright}=await fixture(t);
  const explicit=await packageAt(join(directory,'another installation'),packageSource('file'));
  assert.equal(loadPlaywright(join(explicit,'index.cjs')).id,'file');
});

test('missing project dependency explains the package and browser setup commands',async t=>{
  const {loadPlaywright}=await fixture(t);
  assert.throws(()=>loadPlaywright(''),error=>{
    installationHint(error);
    assert.equal(error.cause.code,'MODULE_NOT_FOUND');
    return true;
  });
});

test('an invalid explicit path is rejected without falling back to another package',async t=>{
  const {directory,loadPlaywright}=await fixture(t,{installed:true});
  assert.throws(()=>loadPlaywright(join(directory,'missing-installation')),installationHint);
});

test('an unrelated module is rejected with actionable setup guidance',async t=>{
  const {loadPlaywright}=await fixture(t,{installed:true,source:'module.exports={chromium:{}};'});
  assert.throws(()=>loadPlaywright(''),installationHint);
});

test('PLAYWRIGHT_PATH selects an installation when no argument is supplied',async t=>{
  const {directory,loadPlaywright}=await fixture(t,{installed:true});
  const previous=process.env.PLAYWRIGHT_PATH;
  t.after(()=>{if(previous===undefined)delete process.env.PLAYWRIGHT_PATH;else process.env.PLAYWRIGHT_PATH=previous;});
  process.env.PLAYWRIGHT_PATH=await packageAt(join(directory,'environment-installation'),packageSource('environment'));
  assert.equal(loadPlaywright().id,'environment');
});

test('all browser entrypoints use the shared loader without personal installation paths',async()=>{
  const entries=['simulation-worker.browser','workshop-navigation.e2e','native.e2e','manufacturing.e2e','workshop.e2e','workshop-scene.browser','interaction.e2e','workshop-view.e2e','render-depth-ab.e2e','idle-render.e2e','workshop-motion.e2e','optimization.e2e','native-motion.e2e','view.e2e','stocking.e2e','native-checkpoint.e2e'];
  for(const entry of entries){
    const source=await readFile(new URL(`./${entry}.mjs`,import.meta.url),'utf8');
    assert.match(source,/import\s*\{\s*loadPlaywright\s*\}\s*from\s*['"]\.\/playwright\.mjs['"]/u,`${entry} must use the portable loader`);
    assert.doesNotMatch(source,/\/(?:Users|home)\//u,`${entry} must not contain a personal installation path`);
  }
});
