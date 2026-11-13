import './build-assets.mjs';
import { readFile,writeFile } from 'node:fs/promises';
const base=process.env.SITE_BASE??'/live-data-lab';
const origin=process.env.SITE_ORIGIN||'https://chinmaya301.github.io';
for(const path of ['index.html','observatories/transit/index.html','observatories/seismic/index.html']){
 const file=new URL('../public/'+path,import.meta.url);let html=await readFile(file,'utf8');
 html=html.replace(/ data-mode="[^"]*"/g,'').replace(/data-api="[^"]*"/g,`data-api="${base}" data-mode="snapshot"`).replace(/(href|src)="\/(?!\/)/g,`$1="${base}/`);
 html=html.replace(/<link rel="canonical"[^>]*>/,`<link rel="canonical" href="${origin}${base}/${path.replace('index.html','')}">`);
 await writeFile(file,html);
}
await writeFile(new URL('../public/.nojekyll',import.meta.url),'');
