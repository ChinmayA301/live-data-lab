import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import worker, { collect } from '../src/worker.ts';
import { SqliteStore } from '../runtime/sqlite.mjs';
const output=resolve('public/snapshots');await mkdir(output,{recursive:true});
const previousOrigin=process.env.PREVIOUS_ORIGIN;
async function prior(kind){try{if(!previousOrigin)return null;const r=await fetch(`${previousOrigin}/snapshots/${kind}.json?publish=${Date.now()}`,{signal:AbortSignal.timeout(15000)});return r.ok?await r.json():null;}catch{return null;}}
const [oldTransit,oldSeismic]=await Promise.all([prior('transit'),prior('seismic')]);
const db=new SqliteStore(),now=Date.now();
if(oldSeismic?.available)for(const s of oldSeismic.snapshots)await db.prepare('INSERT OR IGNORE INTO seismic_snapshots VALUES(?,?,?,?,?,?)').bind(s.commit_sha,s.generated_at,s.imported_at,JSON.stringify(s.metrics),JSON.stringify(s.counts),JSON.stringify(s.quality)).run();
// Carry the accepted timestamp/hash contract across ephemeral runners.
if(oldTransit?.available)await db.prepare('INSERT INTO state VALUES(?,?,?)').bind('transit_latest',now,JSON.stringify(oldTransit.latest)).run();
await collect({DB:db},now);
for(const kind of ['transit','seismic']) {
 const current=await (await worker.fetch(new Request(`http://snapshot/api/${kind}`),{DB:db})).json();
 const previous=kind==='transit'?oldTransit:oldSeismic;
 let result=current.available?current:previous;
 if(!result?.available)throw Error(`No verified ${kind} snapshot is available; retain the last published site`);
 if(!current.available)result={...previous,runs:db.db.prepare('SELECT * FROM runs WHERE pipeline=? ORDER BY started_at DESC LIMIT 8').all(kind)};
 result={...result,mode:'snapshot',published_at:Date.now(),cadence_minutes:15};
 if(kind==='transit'){
  const history=structuredClone(oldTransit?.history_by_route||{});
  if(current.available && current.latest.source_ts!==oldTransit?.latest?.source_ts){
   const routes=[...current.latest.routes,{route_key:'all',with_delay:current.latest.routes.reduce((n,r)=>n+r.with_delay,0),mean_delay:current.latest.routes.reduce((n,r)=>n+(r.mean_delay??0)*r.with_delay,0)/current.latest.routes.reduce((n,r)=>n+r.with_delay,0)}];
   for(const r of routes)if(r.with_delay&&Number.isFinite(r.mean_delay)){
    const rows=history[r.route_key]||[];rows.push({t:current.latest.source_ts,delay_seconds:r.mean_delay,trips:r.with_delay});history[r.route_key]=rows;
   }
  }
  for(const key of Object.keys(history)){history[key]=history[key].filter(r=>r.t>Date.now()-86400000).slice(-96);if(!history[key].length)delete history[key];}
  result.history_by_route=history;result.history=history.all||[];result.forecasts=[];result.models=[];result.evaluation=[];
  result.archive=null;result.training=null;
  result.source={...result.source,collector_interval_seconds:900,stale_after_seconds:2700};
  result.runs=[...(current.runs||result.runs||[]),...(oldTransit?.runs||[])].slice(0,12);
 }
 await writeFile(resolve(output,`${kind}.json`),JSON.stringify(result));
}
db.close();console.log('Published verified snapshots; prior accepted data retained when an upstream collection fails.');
