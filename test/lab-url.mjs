/** Legacy browser suites always target the professional lab. DEMO_URL changes
 * the server origin; LAB_URL is an explicit page override. */
export function resolveLabURL(env={}){
  const base=env.DEMO_URL||'http://127.0.0.1:4197';
  return env.LAB_URL?new URL(env.LAB_URL,base).href:new URL('/lab.html',base).href;
}
export const LAB_URL=resolveLabURL(process.env);
