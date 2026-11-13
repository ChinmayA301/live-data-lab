import { renderVehicleMap, disposeVehicleMap } from './observatory-map.js';
const API = document.body.dataset.api || '';
const kind = document.body.dataset.lab;
const snapshotMode = document.body.dataset.mode === 'snapshot';
const root = document.getElementById('labContent');
const freshness = document.getElementById('freshness');
const refresh = document.getElementById('refreshLab');
const routeSelect = document.getElementById('routeSelect');
const windowSelect = document.getElementById('windowSelect');
const params = new URLSearchParams(location.search);
let selected = params.get('route') || 'all', windowValue = params.get('window') === '24h' ? '24h' : '6h';
let data, controller, generation = 0, lastError = '', lastFetched = 0;
const cache = new Map();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const num = value => finite(value) ? new Intl.NumberFormat('en-US').format(value) : '—';
const fixed = (value, digits = 1) => finite(value) ? value.toFixed(digits) : '—';
const pct = value => finite(value) ? `${(value * 100).toFixed(1)}%` : '—';
const time = value => value ? new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}) : 'Unavailable';
const ago = value => !value ? 'unavailable' : Date.now() - value < 60_000 ? 'under 1 minute ago' : `${Math.max(0,Math.floor((Date.now()-value)/60_000))} min ago`;
const table = (caption, columns, rows) => `<div class="lab-table-wrap"><table><caption>${esc(caption)}</caption><thead><tr>${columns.map(c=>`<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map((cell,i)=>i ? `<td>${cell}</td>` : `<th scope="row">${cell}</th>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const metric = (label, value, note) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd><small>${esc(note)}</small></div>`;
const legend = items => `<div class="lab-legend">${items.map(item=>`<span style="--legend:${item.color}">${esc(item.label)}</span>`).join('')}</div>`;

function lineChart(id, rows, series, title, domain, gapMs = Infinity) {
  const target = document.getElementById(id);
  if (!rows.length) { target.innerHTML = '<p class="lab-empty">No accepted observations in this window yet.</p>'; return; }
  const d3 = window.d3;
  if (!d3) { target.innerHTML = '<p class="lab-empty">Chart library unavailable. The data table below remains available.</p>'; return; }
  const w = Math.max(300,target.clientWidth-26), h = 300, m = {left:51,right:18,top:18,bottom:40};
  const xExtent = d3.extent(rows, r=>r.t);
  if (xExtent[0] === xExtent[1]) { xExtent[0] -= 5*60_000; xExtent[1] += 5*60_000; }
  const x = d3.scaleTime().domain(xExtent.map(t=>new Date(t))).range([m.left,w-m.right]);
  const values = rows.flatMap(r=>series.map(s=>r[s.key])).filter(finite);
  if (!values.length) { target.innerHTML = '<p class="lab-empty">This metric was not exported for the selected observations.</p>'; return; }
  let yDomain = domain || d3.extent(values);
  if (yDomain[0] === yDomain[1]) yDomain = [yDomain[0]-1,yDomain[1]+1];
  const y = d3.scaleLinear().domain(yDomain).nice().range([h-m.bottom,m.top]);
  target.innerHTML = '';
  const svg = d3.select(target).append('svg').attr('viewBox',`0 0 ${w} ${h}`).attr('role','img').attr('aria-label',title);
  svg.append('title').text(title);
  svg.append('g').attr('transform',`translate(0,${h-m.bottom})`).call(d3.axisBottom(x).ticks(w<500?3:4).tickFormat(d3.timeFormat(xExtent[1]-xExtent[0]>86400_000?'%b %d':'%H:%M')));
  svg.append('g').attr('transform',`translate(${m.left},0)`).call(d3.axisLeft(y).ticks(5));
  svg.append('g').selectAll('line').data(y.ticks(5)).join('line').attr('class','grid-line').attr('x1',m.left).attr('x2',w-m.right).attr('y1',y).attr('y2',y);
  const points = [];
  rows.forEach((row,i)=>{ if(i && row.t-rows[i-1].t>gapMs) points.push(null); points.push(row); });
  for (const s of series) {
    const line = d3.line().defined(r=>r && finite(r[s.key])).x(r=>x(new Date(r.t))).y(r=>y(r[s.key]));
    svg.append('path').datum(points).attr('d',line).attr('fill','none').attr('stroke',s.color).attr('stroke-width',2).attr('stroke-dasharray',s.dashed?'5 4':null);
    svg.append('g').selectAll('circle').data(rows.filter(r=>finite(r[s.key]))).join('circle').attr('cx',r=>x(new Date(r.t))).attr('cy',r=>y(r[s.key])).attr('r',3).attr('fill',s.color).append('title').text(r=>`${time(r.t)} · ${s.label}: ${fixed(r[s.key],3)}`);
  }
}

function updateFreshness() {
  if (!data?.available) return;
  const sourceTs=kind==='seismic'?data.snapshots[0].generated_at:data.latest.source_ts;
  const oldestSourceTs=kind==='transit'?Math.min(sourceTs,data.latest.vehicle_source_ts):sourceTs;
  const threshold=kind==='seismic'?8*3600_000:(snapshotMode?45*60_000:180_000);
  const failed=data.runs?.[0]?.status==='failed';
  const upstreamFailed=kind==='seismic'&&['failure','timed_out','cancelled','action_required'].includes(data.workflows?.find(r=>r.status==='completed')?.conclusion);
  const stale=Date.now()-oldestSourceTs>threshold || !!lastError || failed || upstreamFailed;
  freshness.dataset.stale=String(stale);
  freshness.textContent=`${stale?'Updates are delayed. Showing the last available observations. ':''}Observed ${time(sourceTs)} · ${ago(sourceTs)}. ${kind==='seismic'?'Model reports usually update every six hours.':snapshotMode?'Snapshots are scheduled about every 15 minutes; timing can vary.':'Observations refresh about every minute.'}`;
}

function renderSeismic() {
  const latest=data.snapshots[0], m=latest.metrics, counts=latest.counts;
  const series=[...data.snapshots].reverse().map(s=>({t:s.generated_at,mae:s.metrics.mae,raw:s.metrics.pi90_coverage_raw*100,conformal:s.metrics.pi90_coverage_conformal*100}));
  const workflowRows=(data.workflows||[]).map(r=>[`<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(time(r.started_at))}</a>`,esc(r.status),`<span class="${r.conclusion==='success'?'pass':'failed'}">${esc(r.conclusion||'Pending')}</span>`,esc(r.sha.slice(0,8))]);
  const checks=latest.quality, passed=checks.filter(c=>c.result==='PASS').length;
  root.innerHTML=`<dl class="lab-metrics">${metric('Held-out MAE',fixed(m.mae,3),'Magnitude units')}${metric('Conformal interval coverage',pct(m.pi90_coverage_conformal),`Nominal 90% · test n=${num(m.n_test)}`)}${metric('Scored catalog events',num(counts.scored),`${num(counts.catalog)} catalog events`)}${metric('Review candidates',num(counts.flagged),'Consistency outliers; not confirmed errors')}</dl>
  <div class="lab-grid"><section class="lab-panel"><h2>Uncertainty through time</h2><p>Coverage on each report’s held-out temporal test set. Each point is a distinct published report revision.</p><div id="coverageChart" class="lab-chart"></div>${legend([{label:'Raw coverage (%)',color:'#c0c4c9'},{label:'Conformal coverage (%)',color:'#d1a67d'}])}</section>
  <section class="lab-panel"><h2>Magnitude estimation error</h2><p>Mean absolute error on the held-out temporal test. Cohorts can change between revisions.</p><div id="errorChart" class="lab-chart"></div>${legend([{label:'MAE · magnitude units',color:'#d1a67d'}])}</section></div>
  <details><summary>Inspect report data and revision provenance</summary>${table('Verified published reports',['Generated','MAE','Raw coverage','Conformal coverage','Test n','Revision'],data.snapshots.map(s=>[esc(time(s.generated_at)),fixed(s.metrics.mae,3),pct(s.metrics.pi90_coverage_raw),pct(s.metrics.pi90_coverage_conformal),num(s.metrics.n_test),`<a href="${esc(data.repository)}/tree/${esc(s.commit_sha)}/reports" target="_blank" rel="noopener">${esc(s.commit_sha.slice(0,8))}</a>`]))}</details>
  <details class="lab-technical"><summary>How this was built · pipeline runs and data checks</summary><div class="lab-grid"><section class="lab-panel"><h2>Pipeline execution</h2>${workflowRows.length?table('Upstream GitHub Actions runs',['Started','State','Conclusion','Code revision'],workflowRows):'<p>Workflow history is unavailable.</p>'}</section>
  <section class="lab-panel"><h2>Published data checks</h2><p>${passed} of ${checks.length} exported checks passed for the latest report.</p>${table('Latest source validation report',['Check','Column','Result'],checks.map(c=>[esc(c.expectation.replace('ExpectColumnValues','')),esc(c.column),`<span class="${c.result==='PASS'?'pass':'failed'}">${esc(c.result)}</span>`]))}</section></div>
  <section class="lab-method"><h2>What this observatory measures</h2><p>The model estimates catalog magnitude for already-detected events using detection-network features. It does not forecast earthquakes. Raw and conformal metrics describe a temporal test set; the scored catalog count includes a broader population and is not another test-set score.</p><ol><li>USGS catalog ingestion</li><li>DuckDB upsert and validation</li><li>Training and conformal calibration</li><li>Scoring and report publication</li><li>Revision-pinned import</li></ol><p>Current report: <a href="${esc(data.repository)}/blob/${esc(latest.commit_sha)}/reports/_metrics.json" target="_blank" rel="noopener">machine-readable metrics</a> · <a href="${esc(data.repository)}/blob/${esc(latest.commit_sha)}/reports/STATUS.md" target="_blank" rel="noopener">catalog status</a>. Imported ${esc(time(latest.imported_at))}.</p><p>${data.unavailable.map(esc).join(' ')}</p></section></details>`;
  lineChart('coverageChart',series,[{key:'raw',label:'Raw coverage (%)',color:'#c0c4c9'},{key:'conformal',label:'Conformal coverage (%)',color:'#d1a67d'}],'Held-out prediction interval coverage by report generation time',[0,100]);
  lineChart('errorChart',series,[{key:'mae',label:'MAE',color:'#d1a67d'}],'Held-out magnitude mean absolute error by report generation time');
}

function renderTransit() {
  const all=data.latest.routes;
  const choices=[...all];
  for(const p of data.latest.positions) if(!choices.some(r=>r.route_key===p.route_key)) choices.push({route_key:p.route_key,label:`Route ${p.route_id} · direction ${p.route_key.split('|')[1]} · locations only`});
  const previousSelection=selected;
  routeSelect.innerHTML='<option value="all">All reporting route-directions</option>'+choices.map(r=>`<option value="${esc(r.route_key)}">${esc(r.label)}</option>`).join('');
  if(selected!=='all'&&!choices.some(r=>r.route_key===selected)) routeSelect.insertAdjacentHTML('beforeend',`<option value="${esc(selected)}">${esc(selected)} · no current trips</option>`);
  routeSelect.value=previousSelection;
  const routes=selected==='all'?all:all.filter(r=>r.route_key===selected);
  const positions=data.latest.positions.filter(p=>selected==='all'||p.route_key===selected);
  const tripCount=routes.reduce((n,r)=>n+r.n,0), covered=routes.reduce((n,r)=>n+r.with_delay,0);
  const mean=covered?routes.reduce((n,r)=>n+(r.mean_delay??0)*r.with_delay,0)/covered:null;
  const settled=data.evaluation.reduce((n,r)=>n+r.n,0);
  const quality=data.latest.position_quality;
  const locationNote=quality?`${num(quality.invalid_records)} failed location checks; ${num(quality.duplicate_records)} redundant and ${num(quality.conflicting_records)} conflicting records excluded. ${num(quality.duplicate_entity_ids)} repeated source IDs.`:`${num(data.latest.invalid_positions)} vehicle records excluded by location checks.`;
  const forecast=data.forecasts[0];
  const evaluationRows=data.evaluation.map(r=>[esc(r.model_version),num(r.n),`${fixed(r.baseline_mae)} s`,`${fixed(r.candidate_mae)} s`,esc(time(r.last_outcome))]);
  disposeVehicleMap();
  root.innerHTML=`<dl class="lab-metrics">${metric('Estimated schedule difference',finite(mean)?`${fixed(mean/60)} min`:'—','Average across available estimates; not an arrival prediction')}${metric('Trips with usable estimates',`${num(covered)} / ${num(tripCount)}`,'Coverage helps you judge how complete this view is')}${metric('Vehicles on the map',num(positions.length),'Reported locations at the observation time')}</dl>
  <section class="lab-panel"><div class="lab-map-heading"><div><h2>Vehicles across the Twin Cities</h2><p>Pan or zoom to explore. Select a vehicle for its route and observation time.</p></div><button id="fitVehicles" type="button">Fit vehicles</button></div><div id="vehicleMap" class="lab-map" role="region" aria-label="Geographic map of reported vehicle locations"></div><p id="mapStatus" class="lab-note" role="status"></p><details><summary>Inspect vehicle locations</summary>${table('Timestamped vehicle observations',['Vehicle','Route-direction','Latitude','Longitude','Observed'],positions.map(p=>[esc(p.vehicle_id),esc(p.route_key),fixed(p.lat,5),fixed(p.lon,5),esc(time(p.observed_at))]))}</details></section>
  <section class="lab-panel"><h2>How estimates have changed</h2><p>${snapshotMode?'Average published schedule difference at each collected snapshot. Positive values mean later than scheduled; negative values mean earlier.':'Trip-weighted mean of published delay estimates, aggregated into two-minute bins.'} Gaps are left visible.</p><div id="delayChart" class="lab-chart"></div>${legend([{label:'Published delay · minutes',color:'#d1a67d'}])}<p>${data.history.length} observations in the selected window.</p></section>
  <section class="lab-panel"><h2>Where is the information most complete?</h2><p>Share of reporting trips with a usable delay estimate. Showing up to 12 route-directions with the most reporting trips in this selection.</p><ul class="lab-coverage">${[...routes].sort((a,b)=>b.n-a.n||a.route_key.localeCompare(b.route_key)).slice(0,12).map(r=>`<li><span>${esc(r.label)}</span><span class="coverage-track" aria-hidden="true"><span style="width:${r.n?r.with_delay/r.n*100:0}%"></span></span><span>${num(r.with_delay)} / ${num(r.n)} · ${r.n?pct(r.with_delay/r.n):'—'}</span></li>`).join('')||'<li>No reporting trips for this selection.</li>'}</ul></section>
  <details class="lab-technical"><summary>How this was built · data quality and model experiments</summary><section class="lab-panel"><h2>Ten-minute forecast</h2>${snapshotMode?'<p>Forecasting is paused in the free snapshot edition. The one-minute collector and evaluation code remain available for a future always-on deployment.</p>':forecast?`<p>Issued ${esc(time(forecast.issued_at))}; target ${esc(time(forecast.target_at))}. Persistence baseline: <strong>${fixed(forecast.persistence/60)} min</strong>. Candidate: <strong>${fixed(forecast.candidate/60)} min</strong>. Candidate version: ${esc(forecast.model_version)}.</p>`:'<p>No forecast is issued when fewer than two usable trip estimates are available for this selection.</p>'}
  ${snapshotMode?'<p class="lab-note">No forecast accuracy is claimed for this edition.</p>':evaluationRows.length?table('Prospective forecast evaluation · last 24 hours',['Candidate version','Matched n','Persistence MAE','Candidate MAE','Latest outcome'],evaluationRows):'<p class="lab-note">Outcome history is accumulating. Errors remain unavailable until a forecast is matched to a subsequent feed estimate at or just after its ten-minute target.</p>'}
  ${data.models.length?table('Ridge model held-out temporal evaluation',['Version','Training n','Test n','Persistence MAE','Ridge MAE'],data.models.map(m=>[esc(m.version),num(m.train_n),num(m.test_n),`${fixed(m.baseline_mae)} s`,`${fixed(m.test_mae)} s`])):'<p class="lab-note">The initial candidate is a fixed, damped trend rule. A route-specific ridge model is fitted only after at least 80 matched forecast records, with at least 40 training and 15 test cases after a ten-minute overlap purge. No trained-model result is claimed before those gates pass. This experiment belongs to the always-on edition and is paused for snapshot publishing.</p>'}</section>
  <details><summary>Inspect current route estimates and chart data</summary>${table('Latest accepted route-direction estimates',['Route-direction','Trips','With delay','Mean delay','Median delay','P90 delay'],routes.map(r=>[esc(r.label),num(r.n),num(r.with_delay),`${fixed(r.mean_delay)} s`,`${fixed(r.median_delay)} s`,`${fixed(r.p90_delay)} s`]))}${table('Chart data',['Time','Mean delay','Trip-snapshots'],data.history.map(r=>[esc(time(r.t)),`${fixed(r.delay_seconds)} s`,num(r.trips)]))}</details>
  <section class="lab-panel"><h2>Collection diagnostics</h2>${table('Recent collection attempts',['Started','Result','Accepted entities','Rejected entities'],data.runs.map(r=>[esc(time(r.started_at)),`<span class="${r.status==='success'?'pass':'failed'}">${esc(r.status)}</span>`,num(r.accepted_rows),num(r.rejected_rows)]))}<p class="lab-note">Latest attempt: ${esc(data.runs[0]?.message||'Unavailable')}. ${snapshotMode?'Raw feeds are validated during collection but are not retained by this snapshot site.':`Replay archive: ${num(data.archive?.snapshots)} compressed feed objects, ${fixed((data.archive?.bytes||0)/1024,1)} KiB; oldest retained ${esc(time(data.archive?.oldest_at))}.`}</p></section>
  <section class="lab-method"><h2>From source to decision</h2><ol><li>Scheduled source collection</li><li>Timestamp and schema validation</li><li>Raw gzip snapshots and hashes during collection</li><li>Atomic normalized writes</li><li>${snapshotMode?'Published JSON snapshots and retained chart history':'Forecast issue and later outcome matching'}</li><li>${snapshotMode?'Static charts and maps':'Read-only API and charts'}</li></ol><p><a href="https://svc.metrotransit.org/" target="_blank" rel="noopener">Metro Transit</a> publishes the source data. These are provider estimates, not independently observed arrival times. A changing mix of reporting trips can change the network mean. This prototype does not establish route-level service reliability or causal explanations for delays.</p><p>Empty feeds produce an empty current view. Stale or malformed feeds retain the last accepted snapshot and mark its age. Forecast matching requires the same route-direction within 90 seconds after the target; missing outcomes remain missing. Repeated snapshots do not duplicate observations. Raw feeds use a six-hour retention target and a 64 MiB cleanup budget, applied hourly; normalized history uses a seven-day retention target in the always-on edition. The free edition retains up to 24 hours of published chart observations and does not provide the raw replay API.</p></section></details>`;
  lineChart('delayChart',data.history.map(r=>({t:r.t,delay:r.delay_seconds/60})),[{key:'delay',label:'Delay (minutes)',color:'#d1a67d'}],'Published mean delay estimates by feed time',[Math.min(-1,...data.history.map(r=>r.delay_seconds/60)),Math.max(1,...data.history.map(r=>r.delay_seconds/60))],snapshotMode?45*60_000:3*60_000);

  renderVehicleMap(positions,selected,time,data.latest.vehicle_source_ts);
}

function render() {
  root.setAttribute('aria-busy','false');
  if(!data?.available) { disposeVehicleMap(); root.innerHTML='<p class="lab-empty">No accepted snapshot is available yet. The collector runs independently of this page; refresh again after its next successful run.</p>';freshness.textContent='Waiting for stored observations. No sample data are substituted.';return; }
  if(kind==='seismic') renderSeismic();else renderTransit();updateFreshness();
}
async function load() {
  const requestId=++generation;controller?.abort();controller=new AbortController();refresh.disabled=true;root.setAttribute('aria-busy','true');
  const requestSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)]);
  try {
    const query=kind==='transit'?`?route=${encodeURIComponent(selected)}&window=${windowValue}`:'';
    const response=await fetch(snapshotMode?`${API}/snapshots/${kind}.json`:`${API}/api/${kind}${query}`,{cache:'no-store',signal:requestSignal});
    if(!response.ok){const failure=await response.json().catch(()=>({}));throw new Error(failure.error||`HTTP ${response.status}`);}
    const result=await response.json();if(requestId!==generation)return;
    if(!result||typeof result.available!=='boolean')throw new Error('Unexpected response schema');
    if(snapshotMode&&kind==='transit'){result.selected=selected;result.history=(result.history_by_route?.[selected]||[]).filter(r=>r.t>Date.now()-(windowValue==='24h'?24:6)*3600_000);}
    data=result;lastError='';lastFetched=Date.now();cache.set(`${selected}|${windowValue}`,{data,fetched:lastFetched});render();
  } catch(error) {
    if(error.name==='AbortError'||requestId!==generation)return;lastError=error.message;
    const previous=cache.get(`${selected}|${windowValue}`);if(previous){data=previous.data;lastFetched=previous.fetched;render();}
    else {disposeVehicleMap();root.setAttribute('aria-busy','false');root.innerHTML='<p class="lab-empty">Stored data could not be loaded. Use the update button to retry. No substitute values are displayed.</p>';freshness.dataset.stale='true';freshness.textContent=`Data connection unavailable. ${lastError}`;}
  } finally {if(requestId===generation)refresh.disabled=false;}
}
function changeSelection() {
  selected=routeSelect.value;windowValue=windowSelect.value;const url=new URL(location.href);
  if(selected==='all')url.searchParams.delete('route');else url.searchParams.set('route',selected);
  if(windowValue==='6h')url.searchParams.delete('window');else url.searchParams.set('window',windowValue);
  history.replaceState({},'',url);load();
}
if(windowSelect)windowSelect.value=windowValue;
routeSelect?.addEventListener('change',changeSelection);windowSelect?.addEventListener('change',changeSelection);
refresh.addEventListener('click',load);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
setInterval(()=>{if(!document.hidden&&!refresh.disabled)load();},60_000);
setInterval(updateFreshness,15_000);
load();
