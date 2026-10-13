import { esc, statusBadge, fmtDuration, fmtNum } from './ui-util.js';
import { pageShell, TOAST_JS } from './ui-kit.js';
import type { SqliteAdapter } from './store/sqlite.js';

function shell(o: { title: string; crumb: string; path: string; body: string; db: SqliteAdapter }): string {
  return pageShell({
    title: o.title, crumb: o.crumb, path: o.path, body: o.body,
    agents: o.db.listAgents().length,
    runs: o.db.listRuns().length,
    mcp: o.db.listMcpServers().length,
  });
}

// ============================================================
// Dashboard
// ============================================================
export function dashboardPage(db: SqliteAdapter): string {
  const body = `
  <div class="page-head">
    <div><h1>Dashboard</h1><div class="sub">Live metrics across every registered agent, run, and integration.</div></div>
    <div class="head-actions"><a href="/ui" class="btn" style="text-decoration:none">+ New definition</a></div>
  </div>
  <div class="grid c4" id="statRow">
    <div class="stat"><div class="k">Agents</div><div class="v" id="m-agents">–</div><div class="d" id="m-agents-d">registered definitions</div></div>
    <div class="stat acc"><div class="k">Runs (24h)</div><div class="v" id="m-runs24">–</div><div class="d" id="m-runs24-d">&nbsp;</div></div>
    <div class="stat ok"><div class="k">Success rate</div><div class="v" id="m-success">–</div><div class="d">of finished runs</div></div>
    <div class="stat"><div class="k">Tokens</div><div class="v" id="m-tokens">–</div><div class="d" id="m-tokens-d">in / out (usage rows)</div></div>
  </div>
  <h2 class="sec">Performance</h2>
  <div class="grid c3">
    <div class="stat"><div class="k">Avg duration</div><div class="v" id="m-avgdur">–</div><div class="d">measured runs</div></div>
    <div class="stat"><div class="k">Credits burned</div><div class="v" id="m-credits">–</div><div class="d">cost units across runs</div></div>
    <div class="stat"><div class="k">MCP servers</div><div class="v" id="m-mcp">–</div><div class="d">registered integrations</div></div>
  </div>
  <div class="grid c2" style="margin-top:1rem">
    <div class="card flush"><div class="card-body" style="padding-bottom:.4rem"><h3>Runs by status</h3><div id="statusBreakdown" class="mut" style="font-size:.85rem">loading…</div></div></div>
    <div class="card flush"><div class="card-body" style="padding-bottom:.4rem"><h3>Most-used agents</h3><div id="topAgents" class="mut" style="font-size:.85rem">loading…</div></div></div>
  </div>
  <h2 class="sec">Workspace &amp; audit logs</h2>
  <div class="grid c2">
    <div class="card"><h3>Workspace</h3>
      <table class="kv" id="wsBox"><tr><td class="mut">workspace</td><td>loading…</td></tr></table>
    </div>
    <div class="card"><h3>Audit log (structured JSONL)</h3>
      <div id="logBox" class="mut" style="font-size:.85rem">loading…</div>
      <div class="toolbar" style="display:flex;gap:.55rem;margin-top:.7rem;flex-wrap:wrap">
        <button class="btn ghost sm" id="logsRefresh" type="button">↻ Refresh</button>
        <button class="btn ghost sm" id="logsErrors" type="button">Errors only</button>
        <a class="btn ghost sm" href="/api/logs" target="_blank">Raw JSONL ↗</a>
      </div>
    </div>
  </div>
  <h2 class="sec">Recent activity</h2>
  <div class="card flush"><div class="tbl-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Duration</th><th>Created</th></tr></thead><tbody id="recentRuns"><tr><td colspan="5" class="mut">loading…</td></tr></tbody></table></div></div>
  <div class="card" style="margin-top:1rem"><h3>Quick API tour</h3>
    <pre>curl -s http://localhost:3100/api/status

# Register a definition (server-side path — or send inline JSON instead)
curl -s -X POST http://localhost:3100/api/agents \\
  -H 'Content-Type: application/json' \\
  -d '{"definitionPath":"./fixtures/mimo-smoke-test.agent.json"}'

# Run it (URL-encode the @ as %40)
curl -s -X POST http://localhost:3100/api/agents/mimo-smoke-test%401.0.0/runs \\
  -H 'Content-Type: application/json' \\
  -d '{"taskOverride":"Reply with exactly: SERVE-API-OK"}'

# Poll the audit trail incrementally
curl -s "http://localhost:3100/api/runs/&lt;runId&gt;/events?afterSeq=0"</pre>
    <p class="mut">Interactive docs: <a href="/docs">/docs</a> · raw contract: <a href="/openapi.json">/openapi.json</a></p>
  </div>
  <script>${TOAST_JS}
  async function load(){
    try{
      var m=await api('/api/metrics');
      set('m-agents',m.agents.total); set('m-agents-d',m.agents.latest?('latest: '+m.agents.latest):'no definitions yet');
      set('m-runs24',m.runs.last24h); set('m-runs24-d',(m.runs.total)+' total runs');
      set('m-success', m.runs.finished? (Math.round(m.runs.succeeded/m.runs.finished*100)+'%') : '—');
      set('m-tokens', m.usage.tokensIn!=null||m.usage.tokensOut!=null ? fmt(m.usage.tokensIn)+' / '+fmt(m.usage.tokensOut) : '—');
      set('m-tokens-d', m.usage.rows+' usage row'+(m.usage.rows===1?'':'s'));
      set('m-avgdur', m.usage.avgDurationMs!=null? dur(m.usage.avgDurationMs):'—');
      set('m-credits', m.usage.credits!=null? m.usage.credits.toFixed(2):'—');
      set('m-mcp', m.mcp.total);
      // status breakdown bars
      var total=m.runs.total||1;
      var sb=m.runs.byStatus||{}; var keys=['done','running','failed','aborted','idle','queued'];
      document.getElementById('statusBreakdown').innerHTML=keys.filter(function(k){return sb[k]}).map(function(k){
        var pct=Math.round(sb[k]/total*100);
        var cls=k==='done'?'ok':(k==='running'?'acc':'err2');
        return '<div style="margin-bottom:.55rem"><div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:.25rem"><span>'+k+'</span><span class="mut">'+sb[k]+' · '+pct+'%</span></div><div class="bar"><i style="width:'+pct+'%;'+(k==='done'?'background:var(--ok)':(k==='running'?'':'background:var(--err)'))+'"></i></div></div>';
      }).join('')||'<span class="mut">no runs yet</span>';
      // top agents
      document.getElementById('topAgents').innerHTML=(m.agents.byRuns||[]).slice(0,5).map(function(a){
        var pct=a.runs&&m.runs.total? Math.round(a.runs/Math.max(1,m.runs.total)*100):0;
        return '<div style="margin-bottom:.55rem"><div style="display:flex;justify-content:space-between;font-size:.8rem"><code class="inline">'+esc(a.id)+'</code><span class="mut">'+a.runs+' run'+(a.runs===1?'':'s')+'</span></div><div class="bar" style="margin-top:.25rem"><i style="width:'+pct+'%"></i></div></div>';
      }).join('')||'<span class="mut">no runs yet</span>';
      // recent runs table (delegated clicks — no inline onclick quoting issues)
      var rows=(m.recentRuns||[]).map(function(r){
        return '<tr class="rowlink" data-run="'+r.id+'"><td><code class="inline">'+r.id+'</code></td><td class="t2">'+esc(r.agent_id||'—')+'</td><td>'+statusBadge(r.status)+'</td><td class="mut">'+dur(r.durationMs)+'</td><td class="mut">'+when(r.created_at)+'</td></tr>';
      }).join('');
      document.getElementById('recentRuns').innerHTML=rows||'<tr><td colspan="5" class="mut">No runs yet — <a href="/ui/agents">run an agent</a>.</td></tr>';
      document.getElementById('recentRuns').addEventListener('click',function(e){
        var tr=e.target.closest('tr[data-run]'); if(tr) location.href='/ui/runs/'+tr.getAttribute('data-run');
      });
    }catch(e){
      document.querySelectorAll('#statRow .v').forEach(function(el){el.textContent='—'});
      toast('err','Dashboard metrics failed',e.message);
    }
  }
  function set(id,v){document.getElementById(id).textContent=v}
  function fmt(n){return n==null?'—':Number(n).toLocaleString()}
  function dur(ms){return ms==null?'—':(ms<1000?Math.round(ms)+' ms':(ms/1000).toFixed(1)+' s')}
  function when(iso){return iso?new Date(iso).toLocaleString():'—'}
  function statusBadge(s){var c={done:'ok',running:'run',failed:'err',aborted:'err',idle:'idle',queued:'idle'}[s]||'idle';return '<span class="badge '+c+'">'+s+'</span>'}
  // Workspace + audit logs
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  var logFilter=null;
  async function loadLogs(){
    try{
      var url='/api/logs?limit=12'+(logFilter?'&level=error':'');
      var j=await api(url);
      var box=document.getElementById('logBox');
      if(!j.entries.length){box.innerHTML='<span class="mut">Log file is empty (or not yet created) — make an API call or run an agent to populate it.</span>';return}
      box.innerHTML=j.entries.map(function(e){
        var lc={info:'var(--acc2)',audit:'var(--text2)',warn:'var(--warn)',error:'var(--err)'}[e.level]||'var(--text2)';
        return '<div style="display:flex;gap:.6rem;padding:.35rem 0;border-bottom:1px solid var(--line);font-size:.8rem;align-items:baseline"><span class="mut" style="font-family:var(--mono);font-size:.7rem;flex:none">'+new Date(e.ts).toLocaleTimeString()+'</span><b style="color:'+lc+';flex:none;min-width:44px">'+esc(e.level)+'</b><span class="t2" style="flex:none">'+esc(e.event)+'</span><span class="mut" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(JSON.stringify(e).slice(0,150))+'</span></div>';
      }).join('');
    }catch(e){document.getElementById('logBox').innerHTML='<span class="err-t">'+esc(e.message)+'</span>'}
  }
  async function loadStatus(){
    try{
      var s=await api('/api/status');
      var src={definition:'definition override',env:'MINION_WORKSPACE env',cwd:'current working directory'}[s.workspaceSource]||s.workspaceSource;
      document.getElementById('wsBox').innerHTML=
        '<tr><td class="mut">root</td><td style="word-break:break-all"><code class="inline">'+esc(s.workspace)+'</code></td></tr>'+
        '<tr><td class="mut">resolved from</td><td class="t2">'+esc(src)+'</td></tr>'+
        '<tr><td class="mut">log file</td><td style="word-break:break-all"><code class="inline">'+esc(s.logFile||'—')+'</code></td></tr>'+
        '<tr><td class="mut">database</td><td><code class="inline">'+esc(s.db)+'</code></td></tr>';
    }catch(e){document.getElementById('wsBox').innerHTML='<tr><td class="mut">failed</td><td class="err-t">'+esc(e.message)+'</td></tr>'}
  }
  document.getElementById('logsRefresh').addEventListener('click',function(){logFilter=null;loadLogs()});
  document.getElementById('logsErrors').addEventListener('click',function(){logFilter='error';loadLogs()});
  load(); loadStatus(); loadLogs();
  </script>`;
  return shell({ title: 'Dashboard', crumb: 'Dashboard', path: '/', body, db });
}

// ============================================================
// Define (editor)
// ============================================================
const EDITOR_JS = `
  const $=id=>document.getElementById(id);
  let editorTimer=null, lastValid=null;
  $('def').addEventListener('input',()=>{clearTimeout(editorTimer);editorTimer=setTimeout(()=>validate(false),500)});
  $('tpl').addEventListener('click',async()=>{
    busyBtn($('tpl'),'Loading…');
    try{
      const tmpl=await api('/api/templates/default');
      $('def').value=JSON.stringify(tmpl,null,2);
      toast('ok','Template loaded','Working example filled into the editor — validate, adjust, register.');
      validate(false);
    }catch(e){toast('err','Could not load template',e.message)}
    resetBtn($('tpl'));
  });
  $('fmt').addEventListener('click',()=>{
    try{$('def').value=JSON.stringify(JSON.parse($('def').value),null,2);toast('ok','Formatted','JSON re-formatted with 2-space indent')}
    catch(e){toast('err','Cannot format','Invalid JSON: '+e.message)}
  });
  $('download').addEventListener('click',()=>{
    const blob=new Blob([$('def').value],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='agent-definition.json';a.click();URL.revokeObjectURL(a.href);
    toast('info','Downloaded','agent-definition.json saved to your downloads folder');
  });
  async function validate(persist){
    let body;
    clearFieldErrs();
    try{body={definition:JSON.parse($('def').value)}}
    catch(e){
      $('save').disabled=true;setStatus('err','Invalid JSON','Fix the syntax error before validation can run: '+e.message);
      toast('warn','Invalid JSON','Editor content is not parseable JSON yet');
      setResult('');return null;
    }
    try{
      const r=await fetch(persist?'/api/agents':'/api/agents/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const j=await r.json().catch(()=>({error:'unparseable response'}));
      if(!r.ok){
        $('save').disabled=true;setStatus('err','Validation failed',j.error||'HTTP '+r.status);
        markKnownErrors(j.error);
        return null;
      }
      lastValid=body.definition;
      const warns=(j.warnings||[]);
      setStatus('ok','Definition is valid','content hash <code class="inline">'+j.hash+'</code>'+(warns.length?' · '+warns.length+' warning'+(warns.length>1?'s':''):''));
      $('warnbox').innerHTML=warns.map(w=>'<div class="alert warn"><b>▲</b><div>'+escHtml(w)+'</div></div>').join('');
      $('save').disabled=!persist;
      return j;
    }catch(err){
      $('save').disabled=true;setStatus('err','Request failed',err.message);return null;
    }
  }
  function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  function setStatus(kind,title,subHtml){
    $('status').innerHTML=kind==='ok'
      ?'<div class="alert ok"><b>✓</b><div><b>'+title+'</b><br><span style="font-size:.8rem">'+(subHtml||'')+'</span></div></div>'
      :'<div class="alert err"><b>✕</b><div><b>'+title+'</b><br><span style="font-size:.8rem" class="err-t">'+(subHtml||'')+'</span></div></div>';
  }
  function setResult(html){$('result').innerHTML=html}
  function markKnownErrors(msg){ if(msg&&msg.indexOf('schemaVersion')>=0){$('status').innerHTML+='<div class="field-err show mut" style="margin-top:.4rem">Hint: a v1.0 definition needs schemaVersion "1.0" plus metadata, persona, task and provider sections.</div>'} }
  function clearFieldErrs(){document.querySelectorAll('.field-err.show').forEach(el=>el.classList.remove('show'))}
  $('def').addEventListener('input',function(){ if(this.classList.contains('bad')){try{JSON.parse(this.value);this.classList.remove('bad')}catch{}} });
  $('save').addEventListener('click',async()=>{
    busyBtn($('save'),'Registering…');
    const j=await validate(true);
    resetBtn($('save'));
    if(!j){toast('err','Registration blocked','Definition did not pass validation');return}
    setResult('<div class="alert ok" style="margin-top:.6rem"><b>✓</b><div>Registered <b class="inline"><code>'+escHtml(j.id)+'</code></b> — <a href="/ui/agents/'+encodeURIComponent(j.id)+'">open agent page →</a></div></div>');
    toast('ok','Agent registered',j.id+' is now live — run it from its agent page');
  });`;

export function editorPage(db: SqliteAdapter): string {
  const body = `
  <div class="page-head">
    <div><h1>Define an Agent</h1><div class="sub">Paste or edit a versioned <b>AgentDefinition v1.0</b> JSON. Validation runs as you type; register only when every check passes.</div></div>
  </div>
  <div class="split">
    <div class="card">
      <h3>Definition JSON</h3>
      <textarea id="def" spellcheck="false" style="min-height:420px" placeholder='{"schemaVersion":"1.0", "metadata":{…}, "persona":{…}, "task":{…}, "provider":{…}}'></textarea>
      <div style="margin-top:.8rem;display:flex;gap:.55rem;align-items:center;flex-wrap:wrap">
        <button id="save" class="btn" disabled>Validate &amp; register</button>
        <button id="tpl" class="btn ghost" type="button">Load working template</button>
        <button id="fmt" class="btn ghost" type="button">Format JSON</button>
        <button id="download" class="btn ghost" type="button">Download</button>
      </div>
      <div id="status" style="margin-top:.6rem"><div class="alert info"><b>ℹ</b><div>Begin typing — schema validation starts automatically after each pause.</div></div></div>
      <div id="warnbox"></div>
      <div id="result" style="margin-top:.3rem"></div>
    </div>
    <div>
      <div class="card" style="margin-bottom:1rem"><h3>What validation checks</h3>
        <ul class="mut" style="padding-left:1.2rem;margin:0;font-size:.84rem;line-height:1.9">
          <li><code class="inline">schemaVersion</code> "1.0" with required <b>metadata, persona, task, provider</b> sections</li>
          <li>Unique agent names; <code class="inline">defaultAgent</code> must exist in <code class="inline">agents[]</code></li>
          <li><code class="inline">replace</code> persona mode requires <code class="inline">acknowledgeReplaceRisks</code></li>
          <li>Known system-prompt sections; no literal secrets in MCP env/headers</li>
          <li>Server-side warnings: missing paths, unset credential env var</li>
        </ul>
      </div>
      <div class="card"><h3>Minimal starter</h3>
      <pre>{
  "schemaVersion": "1.0",
  "metadata": { "name": "my-agent",
    "version": "1.0.0" },
  "persona": { "systemMessage": {
    "mode": "append",
    "content": "Be concise." } },
  "task": { "prompt": "Hello" },
  "provider": { "type": "openai",
    "baseUrl": "https://…/v1",
    "model": "my-model",
    "credentialEnv": "MY_API_KEY" }
}</pre></div>
    </div>
  </div>
  <script>${TOAST_JS}${EDITOR_JS}</script>`;
  return shell({ title: 'Define', crumb: 'Define', path: '/ui', body, db });
}

// ============================================================
// Agents list
// ============================================================
export function agentsPage(db: SqliteAdapter): string {
  const agents = db.listAgents();
  const runsByAgent = new Map<string, number>();
  for (const r of db.listRuns() as { agent_id: string }[]) runsByAgent.set(r.agent_id, (runsByAgent.get(r.agent_id) ?? 0) + 1);
  const rows = agents.map((a) => {
    const rc = runsByAgent.get(a.id) ?? 0;
    return `<tr class="rowlink" onclick="location.href='/ui/agents/${encodeURIComponent(a.id)}'">
      <td><span style="font-weight:600">${esc(a.name)}</span><div class="mut" style="font-size:.78rem">${esc(a.id)}</div></td>
      <td><span class="pill">v${esc(a.version)}</span></td>
      <td class="mut">${fmtNum(rc)}</td>
      <td class="mut">${esc(a.created_at)}</td>
      <td style="text-align:right">→</td></tr>`;
  }).join('');
  const body = `
  <div class="page-head">
    <div><h1>Agents</h1><div class="sub">${agents.length} registered definition${agents.length === 1 ? '' : 's'}. Click any row to inspect or run.</div></div>
    <div class="head-actions"><a href="/ui" class="btn" style="text-decoration:none">+ Define new</a></div>
  </div>
  <div class="card flush"><div class="tbl-wrap"><table>
    <thead><tr><th>Agent</th><th>Version</th><th>Runs</th><th>Registered</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5"><div class="empty"><span class="big">🤖</span>No agents registered yet.<br><a href="/ui">Define one in the editor</a> or <code class="inline">POST /api/agents</code>.</div></td></tr>'}</tbody>
  </table></div></div>`;
  return shell({ title: 'Agents', crumb: 'Agents', path: '/ui/agents', body, db });
}

// ============================================================
// Agent detail + runner
// ============================================================
export function agentDetailPage(agent: { id: string; name: string; version: string; definition_json: string; created_at: string }, db: SqliteAdapter): string {
  let defText = '';
  try { defText = esc(JSON.stringify(JSON.parse(agent.definition_json), null, 2)).slice(0, 20000); } catch { defText = esc(agent.definition_json); }
  const runs = (db.listRuns(agent.id) as { id: string; status: string; created_at: string; model: string }[]).slice(0, 8);
  const runRows = runs.map((r) => `<tr class="rowlink" onclick="location.href='/ui/runs/${esc(r.id)}'"><td><code class="inline">${esc(r.id)}</code></td><td>${statusBadge(r.status)}</td><td class="mut">${esc(r.model)}</td><td class="mut">${esc(r.created_at)}</td></tr>`).join('');
  const body = `
  <div class="page-head">
    <div><h1><span style="font-weight:700">${esc(agent.name)}</span> <span class="pill">v${esc(agent.version)}</span></h1>
    <div class="sub"><code class="inline">${esc(agent.id)}</code> · registered ${esc(agent.created_at)}</div></div>
    <div class="head-actions"><a href="/ui/agents" class="btn ghost" style="text-decoration:none">← All agents</a></div>
  </div>
  <div class="split">
    <div class="card"><h3>Run this agent</h3>
      <div class="field">
        <label>Task override <span class="mut t2" style="font-weight:400">(optional)</span></label>
        <input type="text" id="task" placeholder="Leave empty to use the definition's task.prompt" />
        <span class="hint">Overrides <code class="inline">task.prompt</code> from the definition for this run only.</span>
      </div>
      <div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
        <button id="run" class="btn">▶ Run agent</button>
        <span class="mut" id="runhint" style="font-size:.78rem">calls the live model — typically 5–15 s</span>
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
  document.getElementById('run').addEventListener('click',async function(){
    if(busy)return; busy=true;
    const btn=this,msg=document.getElementById('runmsg'),hint=document.getElementById('runhint');
    busyBtn(btn,'Running…'); msg.innerHTML=''; hint.textContent='live model call in progress — this can take up to 10 min for multi-turn builds';
    const body={};
    const t=document.getElementById('task').value.trim();
    if(t)body.taskOverride=t;
    try{
      const j=await api('/api/agents/'+aid+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      toast('ok','Run completed',j.runId+' · session '+j.sessionId);
      msg.innerHTML='<div class="alert ok"><b>✓</b><div><b>Run finished</b> — <a href="/ui/runs/'+j.runId+'">open run detail →</a><pre style="white-space:pre-wrap;margin:.5rem 0 0;max-height:260px">'+escHtml(j.text||'')+'</pre></div></div>';
      if(t)hint.textContent='run started with task override';
    }catch(e){
      toast('err','Run failed',e.message);
      msg.innerHTML='<div class="alert err"><b>✕</b><div><b>Run failed.</b> '+escHtml(e.message)+(String(e.message).indexOf('credential')>=0?'<br><span style="font-size:.78rem">Hint: put the provider API key in the server env — add it to the project .env (e.g. <code class="inline">LLM_API_KEY=…</code>) and restart the server.</span>':'')+'</div></div>';
    }
    resetBtn(btn); busy=false;
  });
  function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  </script>`;
  return shell({ title: agent.name, crumb: `Agents / ${agent.name}`, path: `/ui/agents/${agent.id}`, body, db });
}

// ============================================================
// Runs list
// ============================================================
export function runsPage(db: SqliteAdapter): string {
  const runs = db.listRuns() as { id: string; trace_id: string; status: string; model: string; created_at: string; agent_id: string; agent?: string }[];
  const rows = runs.map((r) => `<tr class="rowlink" onclick="location.href='/ui/runs/${esc(r.id)}'">
    <td><code class="inline">${esc(r.id)}</code></td>
    <td class="t2">${esc(r.agent_id ?? '—')}</td>
    <td>${statusBadge(r.status)}</td>
    <td class="mut">${esc(r.model)}</td>
    <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis"><code class="mut" style="font-size:.78em">${esc(r.trace_id)}</code></td>
    <td class="mut">${esc(r.created_at)}</td></tr>`).join('');
  const body = `
  <div class="page-head">
    <div><h1>Runs</h1><div class="sub">Every execution is audited — status, model, trace id, and full event chain.</div></div>
    <div class="head-actions">
      <input type="text" id="runFilter" placeholder="Filter by agent, status, run id…" style="width:230px">
    </div>
  </div>
  <div class="card flush"><div class="tbl-wrap"><table>
    <thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Model</th><th>Trace</th><th>Created</th></tr></thead>
    <tbody id="runRows">${rows || '<tr><td colspan="6"><div class="empty"><span class="big">⚡</span>No runs yet.<br>Run an agent from its <a href="/ui/agents">agent page</a> or via the API.</div></td></tr>'}</tbody>
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
export function runDetailPage(run: Record<string, unknown>, db: SqliteAdapter): string {
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
      <div class="card" style="margin-bottom:1rem"><h3>Usage (latest turn)</h3><div id="usageBox" class="mut">aggregate from event stream…</div></div>
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
    let usage=null;
    for(const e of events){ if(e.type==='assistant.usage'){try{usage=JSON.parse(e.payload_json)}catch{}} }
    const u=(usage&&usage.event)||{}; const s=u.usage||u;
    const rows=[['tokens in',s.inputTokens??s.tokensIn],['tokens out',s.outputTokens??s.tokensOut],['credits',s.cost??s.credits]]
      .map(function(x){return '<div style="display:flex;justify-content:space-between;font-size:.84rem;padding:.3rem 0;border-bottom:1px solid var(--line)"><span class="mut">'+x[0]+'</span><b>'+(x[1]??'—')+'</b></div>'}).join('');
    document.getElementById('usageBox').innerHTML=rows||'<span class="mut">No assistant.usage event in this run.</span>';
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
export function sessionsPage(db: SqliteAdapter): string {
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

export function sessionDetailPage(s: Record<string, unknown>, db: SqliteAdapter): string {
  const row = s as { session_id: string; run_id: string; agent_id: string; trace_id: string; status: string; summary: string; created_at: string; updated_at: string };
  const body = `
  <div class="page-head">
    <div><h1><code class="inline">${esc(row.session_id)}</code></h1><div class="sub">SDK session lifecycle record.</div></div>
    <div class="head-actions"><a href="/ui/sessions" class="btn ghost" style="text-decoration:none">← All sessions</a></div>
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
const MCP_SAMPLE_CONFIG = { type: 'local', command: 'node', args: ['-e', "console.log('ok')"], tools: ['*'], timeoutMs: 10000 };

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
      renderNone();setMsg('err','Probe failed',e.message);
      toast('err','MCP probe failed',e.message);
    }
    resetBtn($('probeBtn'));
  }
  function renderNone(){$('toolsRow').innerHTML='<div class="empty" style="padding:1.2rem">— paste config (or load template) to probe —</div>'}
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
    }catch(e){toast('err','Probe failed for '+name,e.message)}
  }
  async function del(name){
    if(!confirm('Delete MCP server "'+name+'"? Definitions referencing it via mcp.use will fail at run time.'))return;
    try{await api('/api/mcp/'+encodeURIComponent(name),{method:'DELETE'});toast('ok','Deleted',name+' removed from the registry');setTimeout(()=>location.reload(),800)}
    catch(e){toast('err','Delete failed',e.message)}
  }
`;

export function mcpPage(db: SqliteAdapter): string {
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

export function mcpDetailPage(name: string, srv: { config_json: string; description: string | null; tools_json: string | null; created_at: string }, db: SqliteAdapter): string {
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
    <div class="card flush"><div class="card-body" style="padding-bottom:.4rem"><h3>Config (stored)</h3></div><div class="card-body"><pre>${esc(JSON.stringify(JSON.parse(srv.config_json), null, 2))}</pre></div></div>
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
      document.getElementById('probe-out').innerHTML='<div class="alert err"><b>✕</b><div><b>Probe failed.</b> '+escHtml(e.message)+'</div></div>';
      toast('err','Probe failed',e.message);
    }
    resetBtn(btn);
  });
  function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  </script>`;
  return shell({ title: name, crumb: `MCP / ${name}`, path: `/ui/mcp/${name}`, body, db });
}
