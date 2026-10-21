import { esc, statusBadge } from './ui-util.js';
import { pageShell, TOAST_JS } from './ui-kit.js';
import { agentColor } from '../core/agent-colors.js';
import { agentsAndWizardPage } from './ui-wizard.js';
import type { DbAdapter } from '../store/adapter.js';
import { fileURLToPath } from 'node:url';

/** Absolute path of the bundled echo MCP server used by the 'Load echo template' button. */
const MCP_ECHO_SERVER_PATH = fileURLToPath(new URL('../../scripts/mcp-echo-server.mjs', import.meta.url));

function shell(o: { title: string; crumb: string; path: string; body: string; db: DbAdapter }): string {
  return pageShell({
    title: o.title, crumb: o.crumb, path: o.path, body: o.body,
    agents: o.db.listAgents().length,
    runs: o.db.listRuns().length,
    mcp: o.db.listMcpServers().length,
  });
}

// ============================================================
// Dashboard — realtime request/response + model effectiveness charts
// ============================================================
export function dashboardPage(db: DbAdapter): string {
  const body = `
  <div class="page-head">
    <div><h1>Minions Cockpit</h1><div class="sub">Realtime agent request/response traffic and model effectiveness.</div></div>
    <div class="head-actions"><a href="/ui/agents?tab=define" class="btn" style="text-decoration:none">+ Define Agent</a></div>
  </div>
  <div class="grid c4" id="statRow">
    <div class="stat acc"><div class="k">Agent requests</div><div class="v" id="m-requests">–</div><div class="d" id="m-requests-d">cumulative runs started</div></div>
    <div class="stat ok"><div class="k">Responses</div><div class="v" id="m-responses">–</div><div class="d" id="m-responses-d">finished turns</div></div>
    <div class="stat"><div class="k">Success rate</div><div class="v" id="m-success">–</div><div class="d">of finished runs</div></div>
    <div class="stat"><div class="k">Agents</div><div class="v" id="m-agents">–</div><div class="d" id="m-agents-d">registered definitions</div></div>
  </div>

  <h2 class="sec">Traffic — last 24 hours</h2>
  <div class="card"><h3>Requests &amp; responses per hour</h3>
    <div class="mut" style="font-size:.8rem;margin-bottom:.6rem">Blue = requests started · green = succeeded · red = failed. Auto-refreshes every 5 s.</div>
    <div id="trafficChart" style="width:100%;overflow-x:auto"></div>
    <div id="trafficLegend" style="display:flex;gap:1.1rem;flex-wrap:wrap;margin-top:.7rem;font-size:.78rem"></div>
  </div>

  <div class="grid c2" style="margin-top:1rem">
    <div class="card"><h3>Request / response volume</h3>
      <div class="grid c2" style="gap:.8rem">
        <div class="stat"><div class="k">Requests (24h)</div><div class="v" id="m-req24">–</div><div class="d">runs started</div></div>
        <div class="stat"><div class="k">Success (24h)</div><div class="v" id="m-succ24">–</div><div class="d">done runs</div></div>
      </div>
      <div style="margin-top:1rem">
        <div class="mut" style="font-size:.78rem;margin-bottom:.45rem">Cumulative totals (all-time)</div>
        <div style="display:flex;gap:1.4rem;flex-wrap:wrap">
          <div><div class="mut" style="font-size:.72rem">REQUESTS</div><div style="font-size:1.55rem;font-weight:700;font-variant-numeric:tabular-nums" id="m-reqAll">–</div></div>
          <div><div class="mut" style="font-size:.72rem">RESPONSES</div><div style="font-size:1.55rem;font-weight:700;font-variant-numeric:tabular-nums" id="m-respAll">–</div></div>
          <div><div class="mut" style="font-size:.72rem">FAILED</div><div style="font-size:1.55rem;font-weight:700;font-variant-numeric:tabular-nums;color:var(--err)" id="m-failAll">–</div></div>
        </div>
      </div>
    </div>
    <div class="card"><h3>Runs by status</h3><div id="statusBreakdown" class="mut" style="font-size:.85rem">loading…</div></div>
  </div>

  <h2 class="sec">Model effectiveness</h2>
  <div class="card"><h3>Per-model request volume &amp; success rate</h3>
    <div class="mut" style="font-size:.8rem;margin-bottom:.7rem">Bar length = request volume · the trailing percentage is success rate (done / finished).</div>
    <div id="modelChart" class="mut" style="font-size:.85rem">loading…</div>
  </div>
  <div class="card" style="margin-top:1rem"><h3>Model comparison</h3>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Model</th><th>Requests</th><th>Succeeded</th><th>Failed</th><th>Success rate</th><th>Avg duration</th><th>Tokens in</th><th>Tokens out</th></tr></thead>
      <tbody id="modelTable"><tr><td colspan="8" class="mut">loading…</td></tr></tbody>
    </table></div>
  </div>

  <h2 class="sec">Most-used agents</h2>
  <div class="card"><div id="topAgents" class="mut" style="font-size:.85rem">loading…</div></div>

  <h2 class="sec">Recent activity</h2>
  <div class="card flush"><div class="tbl-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Duration</th><th>Created</th></tr></thead><tbody id="recentRuns"><tr><td colspan="5" class="mut">loading…</td></tr></tbody></table></div></div>
  <script>${TOAST_JS}
  function set(id,v){var el=document.getElementById(id); if(el) el.textContent=v}
  function fmt(n){return n==null?'—':Number(n).toLocaleString()}
  function fmtK(n){ // thousands-scale compact form for axis labels
    n=Number(n)||0;
    if(n>=1e6) return (n/1e6).toFixed(n>=1e7?0:1)+'M';
    if(n>=1e3) return (n/1e3).toFixed(n>=1e4?0:1)+'k';
    return String(n);
  }
  function dur(ms){return ms==null?'—':(ms<1000?Math.round(ms)+' ms':(ms/1000).toFixed(1)+' s')}
  function when(iso){return iso?new Date(iso).toLocaleString():'—'}
  function statusBadge(s){var c={done:'ok',running:'run',failed:'err',aborted:'err',idle:'idle',queued:'idle'}[s]||'idle';return '<span class="badge '+c+'">'+s+'</span>'}
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

  function drawTraffic(timeline){
    var W=920,H=220,padL=44,padR=12,padT=14,padB=32;
    var iw=W-padL-padR, ih=H-padT-padB;
    var max=1;
    timeline.forEach(function(b){ max=Math.max(max,b.requests||0,b.succeeded||0,b.failed||0); });
    // round up to a nice thousands-scale tick
    var step=Math.pow(10,Math.max(0,String(Math.round(max)).length-1));
    var top=Math.ceil(max/step)*step;
    if(top<5) top=5;
    var n=timeline.length;
    var bw=Math.max(2, iw/n - 3);
    var svg=['<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="'+H+'" role="img" aria-label="Requests and responses per hour">'];
    // gridlines + y labels
    for(var t=0;t<=4;t++){
      var y=padT+ih-(t/4)*ih;
      var val=Math.round(top*t/4);
      svg.push('<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="var(--line)" stroke-width="1"/>');
      svg.push('<text x="'+(padL-6)+'" y="'+(y+3)+'" text-anchor="end" font-size="10" fill="var(--mut)">'+fmtK(val)+'</text>');
    }
    timeline.forEach(function(b,i){
      var x=padL+(i/n)*iw+1.5;
      var rh=(b.requests/top)*ih;
      var sh=(b.succeeded/top)*ih;
      var fh=(b.failed/top)*ih;
      // stacked-ish: request bar (faint), success overlaid, failure on top of success
      svg.push('<rect x="'+x+'" y="'+(padT+ih-rh)+'" width="'+bw+'" height="'+Math.max(0,rh)+'" fill="var(--acc)" opacity="0.35" rx="2"><title>'+b.hour+' · '+(b.requests||0)+' requests</title></rect>');
      if(sh>0) svg.push('<rect x="'+x+'" y="'+(padT+ih-sh)+'" width="'+bw+'" height="'+sh+'" fill="var(--ok)" opacity="0.9" rx="2"><title>'+b.hour+' · '+(b.succeeded||0)+' succeeded</title></rect>');
      if(fh>0) svg.push('<rect x="'+x+'" y="'+(padT+ih-sh-fh)+'" width="'+bw+'" height="'+fh+'" fill="var(--err)" opacity="0.9" rx="2"><title>'+b.hour+' · '+(b.failed||0)+' failed</title></rect>');
      // x label every 3 hours
      if(i%3===0){
        var lbl=(b.hour||'').slice(11)+':00';
        svg.push('<text x="'+(x+bw/2)+'" y="'+(H-10)+'" text-anchor="middle" font-size="9" fill="var(--mut)">'+lbl+'</text>');
      }
    });
    svg.push('</svg>');
    document.getElementById('trafficChart').innerHTML=svg.join('');
    document.getElementById('trafficLegend').innerHTML=
      '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--acc);opacity:.45;margin-right:.35rem"></span>Requests</span>'+
      '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--ok);margin-right:.35rem"></span>Succeeded</span>'+
      '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--err);margin-right:.35rem"></span>Failed</span>'+
      '<span class="mut">Peak '+fmtK(top)+' / hour</span>';
  }

  function drawModels(byModel){
    if(!byModel||!byModel.length){
      document.getElementById('modelChart').innerHTML='<span class="mut">No runs yet — run an agent to populate model metrics.</span>';
      document.getElementById('modelTable').innerHTML='<tr><td colspan="8" class="mut">No runs yet.</td></tr>';
      return;
    }
    var max=1; byModel.forEach(function(m){ max=Math.max(max,m.requests||0); });
    document.getElementById('modelChart').innerHTML=byModel.map(function(m){
      var finished=(m.succeeded||0)+(m.failed||0);
      // Only report a rate once runs have actually finished — an unfinished model
      // must never render as "0% success" (that reads as a failure, not a pending state).
      var rate=finished?Math.round((m.succeeded||0)/finished*100):null;
      var rateLabel=rate==null?'<span class="mut">pending</span>':'<b style="color:'+(rate>=80?'var(--ok)':rate>=50?'var(--warn)':'var(--err)')+'">'+rate+'%</b> success';
      var barColor=rate==null?'':(';background:'+(rate>=80?'var(--ok)':rate>=50?'var(--warn)':'var(--err)'));
      var pct=Math.round((m.requests||0)/max*100);
      return '<div style="margin-bottom:.75rem">'+
        '<div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:.3rem">'+
          '<code class="inline">'+esc(m.model)+'</code>'+
          '<span class="mut">'+fmt(m.requests)+' req · '+rateLabel+' · <b style="color:var(--ok)">'+fmt(m.succeeded)+'</b> succeeded · <b style="color:var(--err)">'+fmt(m.failed)+'</b> failed</span>'+
        '</div>'+
        '<div class="bar" style="height:10px"><i style="width:'+pct+'%'+barColor+'"></i></div>'+
        '<div class="mut" style="font-size:.72rem;margin-top:.25rem"><b style="color:var(--ok)" title="runs completed with status done">'+fmt(m.succeeded)+'</b> succeeded · <b style="color:var(--err)" title="runs completed with status failed">'+fmt(m.failed)+'</b> failed'+(m.avgDurationMs!=null?' · avg '+dur(m.avgDurationMs):'')+(!finished?' · no finished runs yet':'')+'</div>'+
      '</div>';
    }).join('');
    document.getElementById('modelTable').innerHTML=byModel.map(function(m){
      var finished=(m.succeeded||0)+(m.failed||0);
      var rate=finished?Math.round((m.succeeded||0)/finished*100)+'%':'—';
      return '<tr><td><code class="inline">'+esc(m.model)+'</code></td><td>'+fmt(m.requests)+'</td><td>'+fmt(m.succeeded)+'</td><td>'+fmt(m.failed)+'</td><td>'+rate+'</td><td class="mut">'+dur(m.avgDurationMs)+'</td><td class="mut">'+fmt(m.tokensIn)+'</td><td class="mut">'+fmt(m.tokensOut)+'</td></tr>';
    }).join('');
  }

  var loadedOnce=false;
  async function load(){
    try{
      var m=await api('/api/metrics');
      var t=m.totals||{};
      set('m-requests',fmtK(t.requests)); set('m-requests-d',fmt(t.requests)+' cumulative');
      set('m-responses',fmtK(t.responses)); set('m-responses-d',fmt(t.responses)+' finished turns');
      set('m-success', m.runs.finished? (Math.round(m.runs.succeeded/m.runs.finished*100)+'%') : '—');
      set('m-agents',m.agents.total); set('m-agents-d',m.agents.latest?('latest: '+m.agents.latest):'no definitions yet');
      set('m-req24',fmt(m.runs.last24h));
      set('m-succ24',fmt(m.runs.succeeded));
      set('m-reqAll',fmt(t.requests));
      set('m-respAll',fmt(t.responses));
      set('m-failAll',fmt(t.failed));
      // status breakdown bars
      var total=m.runs.total||1;
      var sb=m.runs.byStatus||{}; var keys=['done','running','failed','aborted','idle','queued'];
      document.getElementById('statusBreakdown').innerHTML=keys.filter(function(k){return sb[k]}).map(function(k){
        var pct=Math.round(sb[k]/total*100);
        return '<div style="margin-bottom:.55rem"><div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:.25rem"><span>'+k+'</span><span class="mut">'+sb[k]+' · '+pct+'%</span></div><div class="bar"><i style="width:'+pct+'%;'+(k==='done'?'background:var(--ok)':(k==='running'?'':'background:var(--err)'))+'"></i></div></div>';
      }).join('')||'<span class="mut">no runs yet</span>';
      // top agents
      document.getElementById('topAgents').innerHTML=(m.agents.byRuns||[]).slice(0,5).map(function(a){
        var pct=a.runs&&m.runs.total? Math.round(a.runs/Math.max(1,m.runs.total)*100):0;
        return '<div style="margin-bottom:.55rem"><div style="display:flex;justify-content:space-between;font-size:.8rem"><code class="inline">'+esc(a.id)+'</code><span class="mut">'+a.runs+' run'+(a.runs===1?'':'s')+'</span></div><div class="bar" style="margin-top:.25rem"><i style="width:'+pct+'%"></i></div></div>';
      }).join('')||'<span class="mut">no runs yet</span>';
      drawTraffic(m.timeline||[]);
      drawModels(m.byModel||[]);
      // recent runs
      var rows=(m.recentRuns||[]).map(function(r){
        return '<tr class="rowlink" data-run="'+esc(r.id)+'"><td><code class="inline">'+esc(r.id)+'</code></td><td class="t2">'+esc(r.agent_id||'—')+'</td><td>'+statusBadge(r.status)+'</td><td class="mut">'+dur(r.durationMs)+'</td><td class="mut">'+when(r.created_at)+'</td></tr>';
      }).join('');
      document.getElementById('recentRuns').innerHTML=rows||'<tr><td colspan="5" class="mut">No runs yet — <a href="/ui/agents">run an agent</a>.</td></tr>';
      if(!loadedOnce){
        loadedOnce=true;
        document.getElementById('recentRuns').addEventListener('click',function(e){
          var tr=e.target.closest('tr[data-run]'); if(tr) location.href='/ui/runs/'+encodeURIComponent(tr.getAttribute('data-run'));
        });
      }
    }catch(e){
      document.querySelectorAll('#statRow .v').forEach(function(el){el.textContent='—'});
      if(!loadedOnce) toast('err','Dashboard metrics failed',e.message);
    }
  }
  load();
  setInterval(load, 5000);
  </script>`;
  return shell({ title: 'Dashboard', crumb: 'Dashboard', path: '/', body, db });
}

// ============================================================
// Agents + Define wizard (tabbed view on the Agents screen)
// ============================================================
export function agentsPage(db: DbAdapter, initialTab: 'agents' | 'define' = 'agents'): string {
  return agentsAndWizardPage(db, initialTab);
}

// ============================================================
// Agent detail + runner
// ============================================================
export function agentDetailPage(agent: { id: string; name: string; version: string; definition_json: string; created_at: string }, db: DbAdapter): string {
  let defText = '';
  try { defText = esc(JSON.stringify(JSON.parse(agent.definition_json), null, 2)).slice(0, 20000); } catch { defText = esc(agent.definition_json); }
  // Identity color (chat UI): explicit metadata.color swatch, fallback derivation noted.
  let colorChip = '';
  try {
    const meta = (JSON.parse(agent.definition_json) as { metadata?: { color?: string } }).metadata;
    const explicit = meta?.color && /^#[0-9a-fA-F]{6}$/.test(meta.color) ? meta.color : null;
    const c = explicit ?? agentColor(agent.id);
    colorChip = `<span class="pill" style="display:inline-flex;align-items:center;gap:.4rem"><span style="width:12px;height:12px;border-radius:3px;background:${c};display:inline-block"></span>${explicit ? esc(c) : '<span class="mut">auto ' + c + '</span>'}</span>`;
  } catch { colorChip = ''; }
  const runs = (db.listRuns(agent.id) as { id: string; status: string; created_at: string; model: string }[]).slice(0, 8);
  const runRows = runs.map((r) => `<tr class="rowlink" onclick="location.href='/ui/runs/${esc(r.id)}'"><td><code class="inline">${esc(r.id)}</code></td><td>${statusBadge(r.status)}</td><td class="mut">${esc(r.model)}</td><td class="mut">${esc(r.created_at)}</td></tr>`).join('');
  const body = `
  <div class="page-head">
    <div><h1><span style="font-weight:700">${esc(agent.name)}</span> <span class="pill">v${esc(agent.version)}</span> ${colorChip}</h1>
    <div class="sub"><code class="inline">${esc(agent.id)}</code> · registered ${esc(agent.created_at)}</div></div>
    <div class="head-actions" style="display:flex;gap:.5rem;flex-wrap:wrap">
      <a href="/ui/agents" class="btn ghost" style="text-decoration:none">← All agents</a>
      <a href="/api/agents/${esc(encodeURIComponent(agent.id))}/definition?download=1" class="btn ghost" style="text-decoration:none" download="${esc(agent.name)}-definition.json">⇩ Export</a>
      <button class="btn ghost" id="btnEditAgent" type="button">✎ Edit</button>
      <button class="btn ghost danger" id="btnDeleteAgent" type="button">Delete</button>
    </div>
  </div>
  <div id="agentActionMsg" style="margin-bottom:.8rem"></div>
  <div class="split">
    <div class="card"><h3>Run this agent</h3>
      <div class="field">
        <label>Task override <span class="mut t2" style="font-weight:400">(optional)</span></label>
        <input type="text" id="task" placeholder="Leave empty to use the definition's task.prompt" />
        <span class="hint">Overrides <code class="inline">task.prompt</code> from the definition for this run only.</span>
      </div>
      <div class="field">
        <label>Turn timeout (ms) <span class="mut t2" style="font-weight:400">(optional)</span></label>
        <input type="number" id="turnTimeoutMs" min="1000" max="21600000" step="1000" placeholder="2700000" />
        <span class="hint">Per-turn budget for <code class="inline">sendAndWait</code>. Default 45 min — multi-file coding builds need the headroom.</span>
      </div>
      <div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
        <button id="run" class="btn">▶ Run agent</button>
        <span class="mut" id="runhint" style="font-size:.78rem">calls the live model — coding builds can take minutes</span>
      </div>
      <div id="runmsg" style="margin-top:.6rem"></div>
      <div class="divider"></div>
      <h3>Recent runs</h3>
      <table>${runRows || '<tr><td class="mut">No runs yet for this agent.</td></tr>'}</table>
    </div>
    <div class="card"><h3>Definition (stored)</h3><pre style="max-height:520px">${defText}</pre></div>
  </div>
  <script>${TOAST_JS}
  const aid=encodeURIComponent('${esc(agent.id)}');
  let busy=false;
  document.getElementById('btnEditAgent').addEventListener('click',function(){
    location.href='/ui/agents?tab=define&edit='+aid;
  });
  document.getElementById('btnDeleteAgent').addEventListener('click',async function(){
    if(!confirm('Delete this agent definition?\\n\\n${esc(agent.id)}\\n\\nHistorical runs stay in the audit trail. This cannot be undone.')) return;
    const msg=document.getElementById('agentActionMsg');
    msg.innerHTML='';
    try{
      const res=await fetch('/api/agents/'+aid,{method:'DELETE'});
      const j=await res.json().catch(function(){return {}});
      if(res.status===409){
        var bits=[];
        if(j.activeRuns)bits.push(j.activeRuns+' active run'+(j.activeRuns===1?'':'s'));
        if(j.activeSessions)bits.push(j.activeSessions+' active session'+(j.activeSessions===1?'':'s'));
        var detail=bits.join(' and ')||'active work still running';
        msg.innerHTML='<div class="alert warn"><b>▲ Delete blocked</b><div>'+escHtml(j.error||('Cannot delete — '+detail+'.'))+'<br><span style="font-size:.78rem">Wait for them to finish, or abort the runs, then try again.</span></div></div>';
        toast('warn','Delete Blocked',detail);
        return;
      }
      if(!res.ok) throw new Error(j.error||('HTTP '+res.status));
      toast('ok','Agent deleted',aid);
      msg.innerHTML='<div class="alert ok"><b>✓</b><div>Agent deleted. <a href="/ui/agents">Back to agents →</a></div></div>';
      setTimeout(function(){location.href='/ui/agents'},700);
    }catch(e){
      msg.innerHTML='<div class="alert err"><b>✕</b><div>'+escHtml(e.message)+'</div></div>';
      toast('err','Delete Failed',e.message);
    }
  });
  document.getElementById('run').addEventListener('click',async function(){
    if(busy)return; busy=true;
    const btn=this,msg=document.getElementById('runmsg'),hint=document.getElementById('runhint');
    busyBtn(btn,'Running…'); msg.innerHTML=''; hint.textContent='live model call in progress — multi-turn coding builds can take up to 45 min';
    const body={};
    const t=document.getElementById('task').value.trim();
    if(t)body.taskOverride=t;
    const tt=parseInt(document.getElementById('turnTimeoutMs')?.value,10);
    if(Number.isFinite(tt)&&tt>0)body.turnTimeoutMs=tt;
    try{
      const j=await api('/api/agents/'+aid+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      toast('ok','Run completed',j.runId+' · session '+j.sessionId);
      msg.innerHTML='<div class="alert ok"><b>✓</b><div><b>Run finished</b> — <a href="/ui/runs/'+j.runId+'">open run detail →</a><pre style="white-space:pre-wrap;margin:.5rem 0 0;max-height:260px">'+escHtml(j.text||'')+'</pre></div></div>';
      if(t)hint.textContent='run started with task override';
    }catch(e){
      toast('err','Run failed',e.message);
      msg.innerHTML='<div class="alert err"><b>✕</b><div><b>Run failed.</b> '+escHtml(e.message)+(String(e.message).indexOf('credential')>=0?'<br><span style="font-size:.78rem">Hint: open the agent in the Define wizard and paste the provider API key — it is stored encrypted in the local database under the credential name.</span>':'')+'</div></div>';
    }
    resetBtn(btn); busy=false;
  });
  function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  </script>`;
  return shell({ title: agent.name, crumb: `Agents / ${agent.name}`, path: `/ui/agents/${agent.id}`, body, db });
}

// ============================================================
// Runs list — the single tracking screen (runs + session lifecycle)
// ============================================================
export function runsPage(db: DbAdapter): string {
  const runs = db.listRuns() as { id: string; trace_id: string; session_id: string; status: string; model: string; created_at: string; agent_id: string; task_prompt: string; finished_at?: string | null; error?: string | null }[];
  const sessionsByRun = new Map<string, { status: string; summary: string | null }>();
  for (const s of db.listSessions() as { run_id: string; status: string; summary: string | null }[]) {
    if (s.run_id) sessionsByRun.set(s.run_id, { status: s.status, summary: s.summary });
  }
  const rows = runs.map((r) => {
    const task = (r.task_prompt || '').replace(/\s+/g, ' ').trim();
    const sess = sessionsByRun.get(r.id);
    return `<tr class="rowlink" data-run="${esc(r.id)}" onclick="location.href='/ui/runs/${esc(r.id)}'">
    <td><code class="inline">${esc(r.id)}</code></td>
    <td class="t2">${esc(r.agent_id ?? '—')}</td>
    <td>${statusBadge(r.status)}</td>
    <td class="t2" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(task)}">${esc(task || '—')}</td>
    <td class="mut">${esc(r.model)}</td>
    <td class="mut" style="font-size:.78rem">${r.session_id ? `<code>${esc(r.session_id)}</code>${sess?.status ? ` <span class="pill" style="font-size:.68rem">${esc(sess.status)}</span>` : ''}` : '—'}</td>
    <td class="mut">${esc(r.created_at)}</td></tr>`;
  }).join('');
  const body = `
  <div class="page-head">
    <div><h1>Runs</h1><div class="sub">Individual runs per agent definition — task, status, model, session, and full event chain. This is the single tracking screen for all execution history.</div></div>
    <div class="head-actions">
      <input type="text" id="runFilter" placeholder="Filter by agent, task, status, run id…" style="width:280px">
    </div>
  </div>
  <div class="card flush"><div class="tbl-wrap"><table>
    <thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Task</th><th>Model</th><th>Session</th><th>Created</th></tr></thead>
    <tbody id="runRows">${rows || '<tr><td colspan="7"><div class="empty"><span class="big">⚡</span>No runs yet.<br>Run an agent from its <a href="/ui/agents">agent page</a> or via the API.</div></td></tr>'}</tbody>
  </table></div></div>
  <script>
  document.getElementById('runFilter').addEventListener('input',function(){
    var q=this.value.toLowerCase();
    document.querySelectorAll('#runRows tr.rowlink').forEach(function(tr){
      tr.style.display=tr.textContent.toLowerCase().indexOf(q)>=0?'':'none';
    });
  });
  </script>`;
  return shell({ title: 'Runs', crumb: 'Runs', path: '/ui/runs', body, db });
}

// ============================================================
// Run detail — audit hub
// ============================================================
export function runDetailPage(run: Record<string, unknown>, db: DbAdapter): string {
  const r = run as { id: string; agent_id: string; trace_id: string; session_id: string; status: string; model: string; provider_type: string; created_at: string; finished_at: string | null; error: string | null; task_prompt: string; definition_hash: string };
  const body = `
  <div class="page-head">
    <div><h1><code class="inline">${esc(r.id)}</code> ${statusBadge(r.status)}</h1>
      <div class="sub">Full audit chain for this execution — trace, session, events, usage.</div></div>
    <div class="head-actions"><a href="/ui/runs" class="btn ghost" style="text-decoration:none">← All runs</a></div>
  </div>
  <div class="grid c4" style="margin-bottom:1rem">
    <div class="stat"><div class="k">Agent</div><div class="v" style="font-size:.95rem;word-break:break-all">${esc(r.agent_id ?? '—')}</div><div class="d"><a href="/ui/agents/${encodeURIComponent(String(r.agent_id ?? ''))}">open agent →</a></div></div>
    <div class="stat"><div class="k">Model</div><div class="v" style="font-size:.95rem">${esc(r.model)}</div><div class="d">${esc(r.provider_type ?? '')}</div></div>
    <div class="stat"><div class="k">Started / finished</div><div class="v" style="font-size:.95rem" id="times">${esc(r.created_at)}</div><div class="d">${r.finished_at ? 'finished ' + esc(r.finished_at) : 'no finish time'}</div></div>
    <div class="stat"><div class="k">Definition hash</div><div class="v" style="font-size:.95rem;word-break:break-all"><code>${esc(r.definition_hash ?? '—')}</code></div><div class="d">content integrity</div></div>
  </div>
  <div class="card" style="margin-bottom:1rem"><h3>Trace</h3>
    <span class="pill">trace <code>${esc(r.trace_id)}</code></span>
    <span class="pill">session <code>${esc(r.session_id)}</code></span>
    <a class="pill" href="/ui/sessions/${encodeURIComponent(r.session_id)}">inspect session →</a>
    ${r.error ? `<div class="alert err" style="margin-top:.6rem"><b>✕</b><div><b>Run error.</b> ${esc(r.error)}</div></div>` : ''}
  </div>
  <div class="card" style="margin-bottom:1rem"><h3>Task</h3><pre style="white-space:pre-wrap;max-height:150px">${esc(r.task_prompt)}</pre></div>
  <div class="split">
    <div class="card flush"><div class="card-body" style="padding-bottom:.3rem"><h3>Event stream — ordered audit chain</h3>
      <div id="events" class="tl mut" style="max-height:560px;overflow:auto;padding-left:1.4rem">loading…</div>
      <div class="card-body" style="padding:.7rem 1.3rem;border-top:1px solid var(--line);display:flex;gap:.6rem;align-items:center">
        <button id="rs" class="btn ghost sm">↻ Reload full chain</button>
        <span class="mut" style="font-size:.76rem">${r.status === 'running' ? 'auto-refreshing every 2 s while running' : 'final state — run is no longer active'}</span>
      </div></div></div>
    <div>
      <div class="card" style="margin-bottom:1rem"><h3>Usage</h3><div id="usageBox" class="mut">aggregate from event stream…</div></div>
      <div class="card"><h3>API links</h3>
        <pre>GET /api/runs/${esc(r.id)}
GET /api/runs/${esc(r.id)}/events?afterSeq=0
GET /api/runs/${esc(r.id)}/stream   (SSE)</pre>
      </div>
    </div>
  </div>
  <script>${TOAST_JS}
  const rid='${esc(r.id)}';let last=0;
  async function poll(full){
    try{
      const j=await api('/api/runs/'+rid+'/events'+(full?'':'?afterSeq='+last));
      const box=document.getElementById('events');
      if(full){box.innerHTML='';last=0}
      if(!j.events||!j.events.length){ if(full) box.innerHTML='<div class="empty">No events recorded for this run.</div>'; return; }
      for(const e of j.events){
        last=Math.max(last,e.seq);
        const d=document.createElement('div');d.className='tl-item '+tlClass(e.type);
        d.innerHTML='<span class="tt">#'+e.seq+'</span><span class="tn">'+escHtml(e.type)+'</span> '+tlBody(e);
        box.appendChild(d);
      }
      box.scrollTop=box.scrollHeight;
      renderUsage(j.events);
    }catch(e){toast('err','Event load failed',e.message)}
  }
  function tlClass(t){
    if(t.indexOf('error')>=0||t==='run.error'||t==='session.error')return 't-err';
    if(t==='run.complete'||t==='permission.decision')return 't-ok';
    if(t==='run.start')return 't-run';
    if(t==='tool.call')return 't-tool';
    if(t==='tool.result')return 't-result';
    if(t==='permission.ask_denied'||t==='permission.destructive_denied')return 't-perm';
    if(t.indexOf('permission')>=0)return 't-perm';
    return '';
  }
  function parse(e){try{return JSON.parse(e.payload_json)}catch{return {}}}
  function truncated_json_blocks(obj){
    return '<details><summary class="mut" style="cursor:pointer;font-size:.74rem">full JSON payload</summary><pre style="white-space:pre-wrap">'+escHtml(JSON.stringify(obj,null,1).slice(0,8000))+'</pre></details>';
  }
  function tlBody(e){
    const o=parse(e);
    if(e.type==='tool.call'){
      const data=o.data||{}; const name=data.toolName||data.tool_title||data.toolTitle||data.mcpToolName||'(unknown tool)';
      let args=data.arguments||data.args||{};
      if(typeof args==='string'){try{args=JSON.parse(args)}catch{}}
      let argStr; try{argStr=JSON.stringify(args,null,1)}catch{argStr=String(args)}
      return '<span class="pill tool-pill">🔧 '+escHtml(name)+'</span>'+(argStr&&argStr!=='{}'?'<pre style="white-space:pre-wrap;margin:.25rem 0 0">'+escHtml(argStr.slice(0,3000))+'</pre>':'')+truncated_json_blocks(o);
    }
    if(e.type==='tool.result'){
      const data=o.data||{};
      const ok=data.resultType?String(data.resultType):'complete';
      const out=data.content||data.output||data.result||data.text;
      let outStr; if(out===undefined){try{outStr=JSON.stringify(data,null,1)}catch{outStr=''}}else{outStr=typeof out==='string'?out:(function(){try{return JSON.stringify(out)}catch{return String(out)}})()}
      const err=o.data&&o.data.error;
      return '<span class="pill '+(err||/fail/i.test(ok)?'err-pill':'ok-pill')+'">'+(err||/fail/i.test(ok)?'✕ ':'✓ ')+escHtml(ok)+'</span>'+(outStr?'<pre style="white-space:pre-wrap;margin:.25rem 0 0">'+escHtml(outStr.slice(0,4000))+'</pre>':'')+truncated_json_blocks(o);
    }
    if(e.type==='persona.resolved'){
      const replaced = !!(o.systemMessage && o.defaultPromptIncluded === false) || o.defaultPromptIncluded === false;
      const label = o.systemMessage ? (replaced ? 'default prompt REPLACED' : 'default prompt kept + custom appended') : 'default Copilot prompt only';
      return '<span class="pill '+(replaced?'warn-pill':'ok-pill')+'">'+escHtml(label)+'</span>'+(o.summary?'<span class="mut" style="font-size:.78rem"> '+escHtml(String(o.summary))+'</span>':'');
    }
    if(e.type==='tools.resolved'){
      const s=o.summary||'';
      return '<span class="pill tool-pill">🧰 tools policy</span><span class="mut" style="font-size:.78rem"> '+escHtml(s)+'</span>';
    }
    if(e.type==='permission.ask_denied'){
      return '<span class="pill err-pill">✕ ask deferred → denied</span><b> '+escHtml(String(o.tool||''))+'</b><span class="mut" style="font-size:.78rem"> ('+escHtml(String(o.source||''))+')</span><pre style="white-space:pre-wrap;margin:.25rem 0 0">'+escHtml(String(o.reason||''))+'</pre>';
    }
    if(e.type==='permission.destructive_denied'){
      return '<span class="pill err-pill">✕ destructive gate</span><b> '+escHtml(String(o.tool||''))+'</b><pre style="white-space:pre-wrap;margin:.25rem 0 0">'+escHtml(String(o.reason||''))+'</pre>';
    }
    if(e.type==='permission.request'||e.type==='permission.decision'){
      const data=o.data||{};
      let detail; try{detail=JSON.stringify(data,null,1).slice(0,1500)}catch{detail=''}
      return '<span class="pill perm-pill">🛡 permission</span>'+(e.type==='permission.decision'&&data.decision?'<b> '+escHtml(String(data.decision))+'</b>':'')+(detail&&detail!=='{}'?'<pre style="white-space:pre-wrap;margin:.25rem 0 0">'+escHtml(detail)+'</pre>':'');
    }
    if(e.type==='prompt.send'||e.type==='assistant.message'||e.type==='run.error'||e.type==='run.complete'){
      return '<pre style="white-space:pre-wrap">'+escHtml(JSON.stringify(o,null,1).slice(0,4000))+'</pre>';
    }
    if(e.payload_json&&e.payload_json!=='{}'&&e.payload_json!=='""'){
      return '<details><summary class="mut" style="cursor:pointer;font-size:.74rem">payload</summary><pre style="white-space:pre-wrap">'+escHtml(JSON.stringify(o,null,1).slice(0,4000))+'</pre></details>';
    }
    return '';
  }
  function renderUsage(events){
    const caps=[];
    let totals=null;
    for(const e of events){
      if(e.type==='usage.capture'){try{caps.push(JSON.parse(e.payload_json))}catch{}}
      if(e.type==='usage.totals'){try{totals=JSON.parse(e.payload_json)}catch{}}
    }
    if(caps.length||totals){
      const pick=function(c,seed){if(c[seed]!=null)return c[seed];if(seed==='tokIn')return c.tokenIn??c.tokensIn;if(seed==='tokOut')return c.tokenOut??c.tokensOut;if(seed==='tokReasoning')return c.tokenReasoning??c.reasoningTokens;return null};
      const sumIn=caps.reduce(function(a,c){return a+(pick(c,'tokIn')||0)},0);
      const sumOut=caps.reduce(function(a,c){return a+(pick(c,'tokOut')||0)},0);
      const sumReason=caps.reduce(function(a,c){return a+(pick(c,'tokReasoning')||0)},0);
      const calls=(totals&&(totals.calls??totals.APIcalls))||caps.length;
      const inT=(totals&&(totals.tokIn??totals.tokensIn))||sumIn;
      const outT=(totals&&(totals.tokOut??totals.tokensOut))||sumOut;
      const last=caps[caps.length-1]||{};
      const row=function(k,v){return '<div style="display:flex;justify-content:space-between;font-size:.84rem;padding:.3rem 0;border-bottom:1px solid var(--line)"><span class="mut">'+k+'</span><b>'+v+'</b></div>'};
      const fmt=function(v){return v==null?'—':Number(v).toLocaleString()};
      document.getElementById('usageBox').innerHTML=
        row('API calls',fmt(calls))
        +row('tokens in (total)',fmt(inT))
        +row('tokens out (total)',fmt(outT))
        +(sumReason?row('  of which reasoning',fmt(sumReason)):'')
        +(caps.length?row('last call  in / out',fmt(pick(last,'tokIn'))+' / '+fmt(pick(last,'tokOut'))):'')
        +'<div class="mut" style="font-size:.72rem;margin-top:.4rem">captured at the wire (usage.proxy) — exact per-call numbers, not the masked SDK values</div>';
      return;
    }
    let usage=null;
    for(const e of events){ if(e.type==='assistant.usage'){try{usage=JSON.parse(e.payload_json)}catch{}} }
    const u=(usage&&usage.event)||{}; const s=u.usage||u;
    const masked=s&&typeof s.inputTokens==='string';
    const rows=[['tokens in',masked?'masked by runtime':(s.inputTokens??s.tokensIn)],['tokens out',masked?'masked by runtime':(s.outputTokens??s.tokensOut)],['credits',s.cost??'—']]
      .map(function(x){return '<div style="display:flex;justify-content:space-between;font-size:.84rem;padding:.3rem 0;border-bottom:1px solid var(--line)"><span class="mut">'+x[0]+'</span><b>'+(x[1]??'—')+'</b></div>'}).join('');
    document.getElementById('usageBox').innerHTML=(masked?'<div class="mut" style="font-size:.76rem;margin-bottom:.35rem">SDK event values are masked for BYOK providers; wire capture (usage.capture) not available for this run.</div>'+rows:(rows||'<span class="mut">No assistant.usage event in this run.</span>'));
  }
  function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  poll(true);
  ${r.status === 'running' ? 'const iv=setInterval(()=>poll(false),2000);' : ''}
  document.getElementById('rs').addEventListener('click',()=>poll(true));
  </script>`;
  return shell({ title: `Run ${r.id}`, crumb: `Runs / ${r.id}`, path: `/ui/runs/${r.id}`, body, db });
}

// ============================================================
// Sessions list + detail (audit)
// ============================================================
export function sessionsPage(db: DbAdapter): string {
  const sessions = db.listSessions() as { session_id: string; run_id: string; agent_id: string; trace_id: string; status: string; summary: string; updated_at: string }[];
  const rows = sessions.map((s) => `<tr class="rowlink" onclick="location.href='/ui/sessions/${encodeURIComponent(s.session_id)}'">
    <td><code class="inline">${esc(s.session_id)}</code></td><td>${esc(s.agent_id ?? '')}</td><td>${s.run_id ? `<a href="/ui/runs/${esc(s.run_id)}" onclick="event.stopPropagation()">${esc(s.run_id)}</a>` : '—'}</td>
    <td>${esc(s.status)}</td><td class="mut" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.summary ?? '')}</td>
    <td class="mut">${esc(s.updated_at)}</td></tr>`).join('');
  const body = `
  <div class="page-head"><div><h1>Sessions</h1><div class="sub">Every SDK session created by runs — auditable end to end with final summaries.</div></div></div>
  <div class="card flush"><div class="tbl-wrap"><table>
    <thead><tr><th>Session</th><th>Agent</th><th>Run</th><th>Status</th><th>Final summary</th><th>Updated</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6"><div class="empty"><span class="big">🗂</span>No sessions yet.</div></td></tr>'}</tbody>
  </table></div></div>`;
  return shell({ title: 'Sessions', crumb: 'Sessions', path: '/ui/sessions', body, db });
}

export function sessionDetailPage(s: Record<string, unknown>, db: DbAdapter): string {
  const row = s as { session_id: string; run_id: string; agent_id: string; trace_id: string; status: string; summary: string; created_at: string; updated_at: string };
  const body = `
  <div class="page-head">
    <div><h1><code class="inline">${esc(row.session_id)}</code></h1><div class="sub">SDK session lifecycle record.</div></div>
    <div class="head-actions"><a href="/ui/runs" class="btn ghost" style="text-decoration:none">← All runs</a></div>
  </div>
  <div class="card"><h3>Session facts</h3>
    <table>
      <tr><td class="mut" style="width:140px">status</td><td class="t2">${esc(row.status)}</td></tr>
      <tr><td class="mut">agent</td><td class="t2">${row.agent_id ? `<a href="/ui/agents/${encodeURIComponent(row.agent_id)}">${esc(row.agent_id)}</a>` : '—'}</td></tr>
      <tr><td class="mut">run</td><td class="t2">${row.run_id ? `<a href="/ui/runs/${esc(row.run_id)}">${esc(row.run_id)}</a>` : '—'}</td></tr>
      <tr><td class="mut">trace</td><td class="t2"><code>${esc(row.trace_id ?? '—')}</code></td></tr>
      <tr><td class="mut">created</td><td class="t2">${esc(row.created_at)}</td></tr>
      <tr><td class="mut">updated</td><td class="t2">${esc(row.updated_at)}</td></tr>
      <tr><td class="mut">final summary</td><td class="t2">${esc(row.summary ?? '—')}</td></tr>
    </table>
  </div>`;
  return shell({ title: `Session ${row.session_id}`, crumb: `Sessions / ${row.session_id}`, path: `/ui/sessions/${row.session_id}`, body, db });
}

// ============================================================
// MCP list + detail
// ============================================================
const MCP_SAMPLE_CONFIG = { type: 'local', command: 'node', args: [MCP_ECHO_SERVER_PATH], tools: ['*'], timeoutMs: 10000 };

const MCP_PAGE_JS = `
  const $=id=>document.getElementById(id);
  $('cfg').addEventListener('input',()=>{clearTimeout(window._mt);window._mt=setTimeout(refreshTools,700)});
  $('name').addEventListener('input',function(){$('nameErr').classList.toggle('show',!this.value.trim())});
  $('tpl').addEventListener('click',()=>{$('cfg').value=JSON.stringify(${JSON.stringify(MCP_SAMPLE_CONFIG)},null,2);toast('info','Template loaded','Echo-server config filled in — edit then probe');refreshTools()});
  function cfg(){try{return JSON.parse($('cfg').value)}catch(e){return null}}
  async function refreshTools(){
    const c=cfg();
    if(!c){setMsg('warn','Config is not valid JSON yet','Paste a complete MCP server config to enable the live probe');renderNone();return}
    busyBtn($('probeBtn'),'Probing…');setMsg('info','Connecting to MCP server…','live stdio/HTTP handshake in progress');
    try{
      const j=await api('/api/mcp/probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:c})});
      renderTools(j.tools);setMsg('ok','Probe succeeded',j.tools.length+' tool(s) discovered live');
    }catch(e){
      renderNone();renderProbeError(e);
    }
    resetBtn($('probeBtn'));
  }
  function renderNone(){$('toolsRow').innerHTML='<div class="empty" style="padding:1.2rem">— paste config (or load template) to probe —</div>'}
  /* Harness-style OAuth authentication card: shown on 401/403 from an http/sse MCP server. */
  window.renderAuthCard = function(hint, serverUrl, cbUrl, extraPayload){
    if(!hint || !hint.issuer || !serverUrl) return false;
    const scopes=(hint.scopes_supported||[]).slice(0,12);
    const wrap=document.createElement('div');
    wrap.className='card';
    wrap.style.cssText='margin-top:.8rem;padding:.85rem 1rem;border-left:3px solid var(--accent, #6366f1)';
    wrap.innerHTML=
      '<h3 style="margin:0 0 .4rem">🔐 Sign in required — '+escHtml(hint.resource_name||'this MCP server')+'</h3>'+
      '<div class="mut" style="font-size:.78rem;margin-bottom:.6rem">Authorization server: <code>'+escHtml(hint.issuer)+'</code>'+
      (scopes.length?'<br>Scopes: '+escHtml(scopes.join(', ')):'')+'</div>'+
      '<div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center">'+
        '<label class="mut" style="font-size:.78rem">OAuth client ID <input id="afClientId" type="text" placeholder="from GitHub OAuth App" style="margin-left:.35rem" size="34"/></label>'+
        '<button id="afOpenSignin" class="btn">Open browser sign-in →</button>'+
        '<button id="afRepoll" class="btn ghost">I signed in — re-probe</button>'+
      '</div>'+
      '<div class="mut" style="font-size:.72rem;margin-top:.5rem">Authorize URL appears here after you click. After completing GitHub sign-in the token is stored sealed &amp; the probe re-runs automatically.</div>'+
      '<div id="afAuthorizeUrl" style="margin-top:.5rem;font-size:.75rem;word-break:break-all"></div>'+
      '<div id="afStatus" style="margin-top:.5rem;font-size:.78rem"></div>';
    $('msg').appendChild(wrap);
    if(!localStorage.getItem('mcp_oauth_client_id')) localStorage.setItem('mcp_oauth_client_id','');
    $('afClientId').value=localStorage.getItem('mcp_oauth_client_id')||'';
    const start=async function(){
      const clientId=$('afClientId').value.trim();
      if(!clientId){ $('afStatus').innerHTML='<span style="color:#b91c1c">Enter an OAuth client ID first (GitHub → Settings → Developer settings → OAuth Apps).</span>'; return; }
      localStorage.setItem('mcp_oauth_client_id',clientId);
      const regName = cbUrl || (($('name') && $('name').value.trim()) || serverUrl.replace(/[^a-z0-9]+/gi,'-').replace(/^-+|-+$/g,'').toLowerCase());
      try{
        const j=await api('/api/mcp/oauth/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:serverUrl,clientId,registerAs:regName})});
        window.open(j.authorizeUrl,'_blank');
        $('afAuthorizeUrl').innerHTML='Authorize URL: <a href="'+escHtml(j.authorizeUrl)+'" target="_blank" rel="noopener">'+escHtml(j.authorizeUrl)+'</a>';
        $('afStatus').innerHTML='<span style="color:#2563eb">Sign-in page opened — completing it stores the token sealed as "'+escHtml(regName)+'" and the probe re-runs automatically.</span>';
        // Poll the registered server's tools while the browser sign-in completes.
        let tries=0;
        const t=setInterval(async()=>{
          tries++;
          if(tries>60){ clearInterval(t); $('afStatus').innerHTML='<span style="color:#92400e">Still waiting for sign-in — finish it and click "I signed in — re-probe".</span>'; return; }
          try{
            const st=await api('/api/mcp/'+encodeURIComponent(regName)+'/tools',{method:'POST',timeoutMs:90000});
            if(st && st.count!==undefined){ clearInterval(t); $('afStatus').innerHTML='<span style="color:#047857">✓ Authorized — '+escHtml(String(st.count))+' tools discovered.</span>'; toast('ok','Auth complete',st.count+' tools discovered'); setTimeout(()=>location.reload(),1200); }
          }catch(_){ /* still pending */ }
        },2000);
      }catch(err){ $('afStatus').innerHTML='<span style="color:#b91c1c">'+escHtml(err.message)+'</span>'; }
    };
    $('afOpenSignin').onclick=start;
    $('afRepoll').onclick=()=>{ refreshTools(); };
    return true;
  };
  /* Render probe failure; structured auth hint + LLM diagnosis when present. */
  window.renderProbeError = function(e){
    let hint=null;
    try{ hint = e.authHint || null; }catch(_){}
    setMsg('err','Probe failed',e.message);
    toast('err','MCP probe failed',e.message);
    let authCardShown=false;
    if(hint){
      const scopes=(hint.scopes_supported||[]).slice(0,10);
      $('msg').insertAdjacentHTML('beforeend',
        '<div class="alert info" style="margin-top:.5rem"><b>ℹ</b><div><b>Authentication required ('+(hint.status)+')</b>'+
        '<br><span style="font-size:.78rem">'+escHtml(hint.guidance||'')+'</span>'+
        (scopes.length?'<br><span style="font-size:.78rem">Scopes: '+escHtml(scopes.join(', '))+'</span>':'')+
        '</div></div>');
    }
    let url=null;
    try{
      const c=cfg()||{};
      url = c.url || (c.servers ? Object.values(c.servers)[0]?.url : null) || (c.mcpServers ? Object.values(c.mcpServers)[0]?.url : null) || null;
    }catch(_){}
    authCardShown = hint ? window.renderAuthCard(hint, url, null) : false;
    if(e.diagnosis){
      $('msg').insertAdjacentHTML('beforeend',
        '<div class="card" style="margin-top:.6rem;padding:.7rem .9rem"><h3 style="margin:0 0 .3rem">🔍 AI diagnosis</h3><div style="font-size:.82rem;white-space:pre-wrap">'+escHtml(e.diagnosis)+'</div></div>');
    }
    if(e.autoFix && e.autoFix.config){
      const fixed=JSON.stringify(e.autoFix.config,null,2);
      $('cfg').value=fixed;
      const label=e.autoFix.probed
        ? '✓ repaired config re-probed successfully ('+e.autoFix.count+' tool(s), via '+escHtml(e.autoFix.model||'LLM')+') — config below is fixed; click Register to save it.'
        : 'repaired config suggested ('+escHtml(e.autoFix.model||'LLM')+') but re-probe still failed: '+escHtml(e.autoFix.error||'unknown');
      $('msg').insertAdjacentHTML('beforeend',
        '<div class="alert '+(e.autoFix.probed?'ok':'warn')+'" style="margin-top:.5rem"><b>'+(e.autoFix.probed?'✓':'▲')+'</b><div><b>AI auto-fix</b><br><span style="font-size:.78rem">'+escHtml(label)+'</span></div></div>');
      if(e.autoFix.probed){ refreshTools(); }
    }
  };
  function renderTools(tools){
    $('toolsRow').innerHTML=tools.length?tools.map(t=>'<div class="ev" style="padding:.55rem .2rem;border-bottom:1px solid var(--line)"><b style="font-size:.85rem">'+escHtml(t.name)+'</b><div class="mut" style="font-size:.78rem">'+escHtml(t.description||'')+'</div>'+(t.inputSchema?'<details><summary>input schema</summary><pre>'+escHtml(JSON.stringify(t.inputSchema,null,1))+'</pre></details>':'')+'</div>').join(''):'<div class="empty" style="padding:1.2rem">server connected but exposes 0 tools</div>';
  }
  function setMsg(kind,title,sub){$('msg').innerHTML='<div class="alert '+kind+'"><b>'+({ok:'✓',err:'✕',warn:'▲',info:'ℹ'}[kind])+'</b><div><b>'+escHtml(title)+'</b><br><span style="font-size:.78rem">'+escHtml(sub||'')+'</span></div></div>'}
  function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  $('probeBtn').addEventListener('click',refreshTools);
  $('reg').addEventListener('click',async function(){
    const c=cfg();
    const name=$('name').value.trim();
    let bad=false;
    if(!name){$('name').classList.add('bad');$('nameErr').classList.add('show');bad=true}
    else $('name').classList.remove('bad');
    if(!c){$('cfg').classList.add('bad');setMsg('err','Config is not valid JSON','Fix the JSON before registering');bad=true}
    else $('cfg').classList.remove('bad');
    if(bad){toast('warn','Cannot register','Fix the highlighted fields first');return}
    busyBtn($('reg'),'Registering…');
    try{
      const j=await api('/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,description:$('desc').value.trim()||undefined,config:c,probe:$('probe').checked})});
      setMsg('ok','Registered '+escHtml(j.name),j.status+' — reference it from a definition with mcp.use');
      toast('ok','MCP server registered',j.name+' ('+j.status+')');
      // Refresh the registered-servers table (same pattern as delete/probe rows).
      setTimeout(()=>location.reload(),900);
    }catch(e){
      setMsg('err','Registration failed',e.message);
      toast('err','Registration failed',e.message);
    }
    resetBtn($('reg'));
  });
  async function refetch(name){
    if(!confirm('Probe tools for "'+name+'" now (live connection)?'))return;
    toast('info','Probing '+name+'…','live handshake in progress');
    try{
      const j=await api('/api/mcp/'+encodeURIComponent(name)+'/tools',{method:'POST'});
      toast('ok','Probe succeeded',j.count+' tool(s) discovered — reload to inspect schemas');
      setTimeout(()=>location.reload(),1200);
    }catch(e){
      toast('err','Probe failed for '+name,e.message);
      if(e.authHint) toast('info','Authentication required ('+e.authHint.status+')',e.authHint.guidance.slice(0,180));
      if(e.diagnosis) toast('info','AI diagnosis available','Open the server detail page to read it');
    }
  }
  async function del(name){
    if(!confirm('Delete MCP server "'+name+'"? Definitions referencing it via mcp.use will fail at run time.'))return;
    try{await api('/api/mcp/'+encodeURIComponent(name),{method:'DELETE'});toast('ok','Deleted',name+' removed from the registry');setTimeout(()=>location.reload(),800)}
    catch(e){toast('err','Delete failed',e.message)}
  }
`;

export function mcpPage(db: DbAdapter): string {
  const servers = db.listMcpServers();
  const rows = servers.map((s) => {
    let count = '—';
    try { count = String(JSON.parse(s.tools_json ?? '[]').length); } catch { /* keep */ }
    return `<tr class="rowlink" onclick="location.href='/ui/mcp/${encodeURIComponent(s.name)}'">
      <td><span style="font-weight:600">${esc(s.name)}</span></td>
      <td class="mut">${esc(s.description || '')}</td>
      <td id="probing_${Buffer.from(s.name).toString('base64')}" title="click row to inspect">${count} tool(s)</td>
      <td class="mut">${esc(s.created_at)}</td>
      <td><button class="btn ghost sm" onclick="event.stopPropagation();refetch('${esc(s.name)}')">Re-probe</button></td>
      <td><button class="btn danger sm" onclick="event.stopPropagation();del('${esc(s.name)}')">Delete</button></td></tr>`;
  }).join('');
  const body = `
  <div class="page-head">
    <div><h1>MCP Registry</h1><div class="sub">Model Context Protocol servers available to agent definitions via <code class="inline">mcp.use</code>.</div></div>
  </div>
  <div class="split">
    <div class="card">
      <h3>Register a server</h3>
      <div class="field"><label>Name <span class="req">*</span></label>
        <input type="text" id="name" placeholder="e.g. inventory-echo" />
        <span class="field-err" id="nameErr">Name is required — it becomes the mcp.use key.</span>
        <span class="hint">This key is how definitions reference the server: <code class="inline">"mcp":{"use":["name"]}</code></span>
      </div>
      <div class="field"><label>Description <span class="mut t2" style="font-weight:400">(optional)</span></label><input type="text" id="desc" placeholder="What is this server for?" /></div>
      <div class="field"><label>Config JSON <span class="req">*</span></label>
        <textarea id="cfg" class="sm" spellcheck="false" placeholder='{"type":"local","command":"node","args":["-e","console.log(&apos;ok&apos;)"],"tools":["*"]}'></textarea>
        <span class="hint">Types: local/stdio (command), http/sse (url). Validate shape live by clicking Probe.</span>
      </div>
      <div style="display:flex;gap:.55rem;flex-wrap:wrap;align-items:center">
        <button id="reg" class="btn">Register</button>
        <button id="tpl" class="btn ghost" type="button">Load echo template</button>
        <button id="probeBtn" class="btn ghost" type="button">Probe tools now</button>
        <label class="mut" style="font-size:.78rem;display:flex;align-items:center"><input type="checkbox" id="probe"> probe on register</label>
      </div>
      <div id="msg" style="margin-top:.6rem"></div>
    </div>
    <div class="card"><h3>Live-discovered tools <span class="mut" style="font-weight:400;text-transform:none;letter-spacing:0">(probe preview)</span></h3><div id="toolsRow" class="empty" style="padding:1.2rem">— paste config (or load template) to probe —</div></div>
  </div>
  <div class="card flush" style="margin-top:1rem"><div class="card-body" style="padding-bottom:.4rem"><h3>Registered servers (${servers.length})</h3></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Name</th><th>Description</th><th>Tools</th><th>Registered</th><th>Probe</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6"><div class="empty"><span class="big">🔌</span>No MCP servers registered yet.</div></td></tr>'}</tbody>
    </table></div></div>
  <div class="card" style="margin-top:1rem"><h3>How to use in a definition</h3>
  <pre>"mcp": {
  "use": [ "inventory-echo" ]
  // scoped:
  // "use": [ { "name": "inventory-echo", "allow": ["echo"], "disabled": false } ]
  // inline alongside:
  // "servers": { "local-thing": { "type": "local", "command": "…" } }
}</pre></div>
  <script>${TOAST_JS}${MCP_PAGE_JS}</script>`;
  return shell({ title: 'MCP Registry', crumb: 'MCP Registry', path: '/ui/mcp', body, db });
}

export function mcpDetailPage(name: string, srv: { config_json: string; description: string | null; tools_json: string | null; created_at: string }, db: DbAdapter): string {
  let tools: { name: string; description: string; inputSchema?: object }[] = [];
  try { tools = JSON.parse(srv.tools_json ?? '[]'); } catch { /* empty */ }
  const toolRows = tools.map((t) => `<div class="ev" style="padding:.55rem .2rem;border-bottom:1px solid var(--line)"><b style="font-size:.85rem">${esc(t.name)}</b><div class="mut" style="font-size:.78rem">${esc(t.description || '')}</div>${t.inputSchema ? `<details><summary>input schema</summary><pre>${esc(JSON.stringify(t.inputSchema, null, 2))}</pre></details>` : ''}</div>`).join('');
  const body = `
  <div class="page-head">
    <div><h1>${esc(name)}</h1><div class="sub">Registered ${esc(srv.created_at)}${srv.description ? ' · ' + esc(srv.description) : ''}</div></div>
    <div class="head-actions">
      <button class="btn" id="probe-btn">Re-probe tools</button>
      <a href="/ui/mcp" class="btn ghost" style="text-decoration:none">← All servers</a>
    </div>
  </div>
  <div id="probe-out" style="margin-bottom:.8rem"></div>
  <div class="split">
    <div class="card flush"><div class="card-body" style="padding-bottom:.4rem"><h3>Config (stored)</h3></div><div class="card-body"><pre id="cfg-stored">${esc(srv.config_json)}</pre></div></div>
    <div class="card"><h3>Tools (${tools.length})</h3>${toolRows || '<div class="empty">No tools stored yet — probe the server to discover them.</div>'}</div>
  </div>
  <script>${TOAST_JS}
  document.getElementById('probe-btn').addEventListener('click',async function(){
    const btn=this; busyBtn(btn,'Probing…');
    try{
      const j=await api('/api/mcp/'+encodeURIComponent('${esc(name)}')+'/tools',{method:'POST'});
      toast('ok','Probe succeeded',j.count+' tool(s) discovered — reloading');
      setTimeout(()=>location.reload(),1000);
    }catch(e){
      let html='<div class="alert err"><b>✕</b><div><b>Probe failed.</b> '+escHtml(e.message);
      if(e.authHint) html+='<br><span style="font-size:.78rem">'+escHtml(e.authHint.guidance||'')+'</span>';
      html+='</div></div>';
      if(e.authHint && e.authHint.issuer){
        /* Harness-style sign-in card: shows issuer + scopes, opens browser OAuth, polls until authorized. */
        let srvUrl='';
        try{ srvUrl=(JSON.parse(document.getElementById('cfg-stored').textContent).url)||''; }catch(_){}
        html+='<div id="authcard" class="card" style="margin-top:.8rem;padding:.85rem 1rem"><h3 style="margin:0 0 .4rem">🔐 Sign in required — '+escHtml(e.authHint.resource_name||name)+'</h3>'+
          '<div class="mut" style="font-size:.78rem;margin-bottom:.6rem">Authorization server: <code>'+escHtml(e.authHint.issuer)+'</code>'+
          ((e.authHint.scopes_supported||[]).length?'<br>Scopes: '+escHtml(e.authHint.scopes_supported.slice(0,12).join(', ')):'')+'</div>'+
          '<div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center"><label class="mut" style="font-size:.78rem">OAuth client ID <input id="dcClientId" size="34" placeholder="from GitHub OAuth App"/></label>'+
          '<button id="dcOpen" class="btn">Open browser sign-in →</button><button id="dcRepoll" class="btn ghost">I signed in — re-probe</button></div>'+
          '<div id="dcUrl" style="margin-top:.5rem;font-size:.75rem;word-break:break-all"></div><div id="dcStatus" style="margin-top:.5rem;font-size:.78rem"></div></div>';
      }
      if(e.diagnosis) html+='<div class="card" style="margin-top:.6rem;padding:.7rem .9rem"><h3 style="margin:0 0 .3rem">🔍 AI diagnosis</h3><div style="font-size:.82rem;white-space:pre-wrap">'+escHtml(e.diagnosis)+'</div></div>';
      const pf=e;
      if(pf.authHint && pf.authHint.issuer){
        setTimeout(function(){
          const openBtn=document.getElementById('dcOpen');
          if(!openBtn) return;
          const stat=document.getElementById('dcStatus'), urlBox=document.getElementById('dcUrl');
          openBtn.onclick=async function(){
            const clientId=document.getElementById('dcClientId').value.trim();
            if(!clientId){ stat.innerHTML='<span style="color:#b91c1c">Enter an OAuth client ID first (GitHub → Settings → Developer settings → OAuth Apps).</span>'; return; }
            localStorage.setItem('mcp_oauth_client_id',clientId);
            let srvUrl='';
            try{ srvUrl=(JSON.parse(document.getElementById('cfg-stored').textContent).url)||''; }catch(_){}
            try{
              const j=await api('/api/mcp/oauth/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:srvUrl,clientId,registerAs:name})});
              window.open(j.authorizeUrl,'_blank');
              urlBox.innerHTML='Authorize URL: <a href="'+escHtml(j.authorizeUrl)+'" target="_blank" rel="noopener">'+escHtml(j.authorizeUrl)+'</a>';
              stat.innerHTML='<span style="color:#2563eb">Sign-in opened — completing it stores the token sealed and re-probes automatically.</span>';
              let tries=0;
              const t=setInterval(async function(){
                tries++;
                if(tries>60){ clearInterval(t); stat.innerHTML='<span style="color:#92400e">Still waiting — finish sign-in then click re-probe.</span>'; return; }
                try{
                  const st=await api('/api/mcp/'+encodeURIComponent('${esc(name)}')+'/tools',{method:'POST',timeoutMs:90000});
                  if(st && st.count!==undefined){ clearInterval(t); stat.innerHTML='<span style="color:#047857">✓ Authorized — '+escHtml(String(st.count))+' tools discovered.</span>'; setTimeout(()=>location.reload(),1200); }
                }catch(_){}
              },2000);
            }catch(err){ stat.innerHTML='<span style="color:#b91c1c">'+escHtml(err.message)+'</span>'; }
          };
          document.getElementById('dcRepoll').onclick=function(){ document.getElementById('probe-btn').click(); };
        },0);
      }
      if(e.autoFix){
        const af=e.autoFix;
        html+='<div class="alert '+(af.probed?'ok':'warn')+'" style="margin-top:.6rem"><b>'+(af.probed?'✓':'▲')+'</b><div><b>AI auto-fix'+(af.probed?' applied & saved':' suggested')+'</b><br><span style="font-size:.78rem">'
          +(af.probed? 'Repaired config re-probed successfully ('+escHtml(String(af.count))+' tool(s), via '+escHtml(af.model||'LLM')+'). Stored config updated'+(af.saved?'':' — re-register to persist')+'.'
            : 'Repaired config still failing: '+escHtml(af.error||'unknown'))
          +'</span>'+(af.config?'<details style="margin-top:.4rem"><summary>suggested config</summary><pre>'+escHtml(JSON.stringify(af.config,null,2))+'</pre></details>':'')+'</div></div>';
      }
      document.getElementById('probe-out').innerHTML=html;
      toast('err','Probe failed',e.message);
    }
    resetBtn(btn);
  });
  function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  </script>`;
  return shell({ title: name, crumb: `MCP / ${name}`, path: `/ui/mcp/${name}`, body, db });
}
