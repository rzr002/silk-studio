import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);

export function loadPlaywright(playwrightPath=process.env.PLAYWRIGHT_PATH){
  try{
    const playwright=require(playwrightPath||'playwright');
    if(typeof playwright?.chromium?.launch!=='function')throw new TypeError('The selected module does not provide Playwright Chromium.');
    return playwright;
  }catch(cause){
    throw new Error('Cannot load Playwright. Run "npm install", then "npx playwright install chromium". To use another installation, set PLAYWRIGHT_PATH to its module directory.',{cause});
  }
}
