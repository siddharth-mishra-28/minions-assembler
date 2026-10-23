import { pageShell, TOAST_JS } from './ui-kit.js';
import { esc } from './ui-util.js';
import { agentColor, USER_COLOR, textColorOn } from '../core/agent-colors.js';
import type { DbAdapter } from '../store/adapter.js';

/**
 * Chat UI (enterprise layout): persistent agent conversations ChatGPT-style.
 * A thread is 1:1 with one registered agent (fixed identity color) or a general
 * thread where each message @mentions the agent that should answer; the user is
 * always the indigo accent.
 *
 * Layout = standard chat app: app nav (pageShell) → thread rail → full-height
 * conversation pane; the header row and New-chat bar use the same page-head /
 * component classes as every other screen, so the page aligns with Agents,
 * Runs (no floating misaligned card).
 */
export function chatPage(db: DbAdapter, opts?: { threadId?: string }): string {
  const threads = db.listChatThreads();
  const agents = db.listAgents();
  const isNew = opts?.threadId === '_new';
  const activeId = opts?.threadId && !isNew ? opts.threadId : undefined;
  const active = activeId ? db.getChatThread(activeId) : undefined;
  const activeMsgs = active ? db.getChatMessages(String(active.id)) : [];

  /** color lookup: explicit metadata.color wins, else deterministic palette hash */
  const defColor = new Map<string, string | null>(agents.map((a) => {
    try {
      const def = JSON.parse(String(db.getAgent(a.id)?.definition_json ?? '{}')) as { metadata?: { color?: string } };
      return [a.id, def.metadata?.color ? def.metadata.color.toLowerCase() : null] as const;
    } catch { return [a.id, null] as const; }
  }));
  const colorOf = (agentId: string | null | undefined): string => {
    if (!agentId) return '#74809c';
    const explicit = defColor.get(agentId) ?? null;
    if (explicit && /^#[0-9a-f]{6}$/.test(explicit)) return explicit;
    return agentColor(agentId);
  };

  const threadRows = threads.length
    ? threads.map((t) => {
        const tid = String(t.id);
        const c = colorOf(t.agent_id ? String(t.agent_id) : null);
        return `<a class="chat-thr${tid === activeId ? ' on' : ''}" href="/ui/chat/${encodeURIComponent(tid)}">
          <span class="chip" style="background:${c};color:${textColorOn(c)}">${t.agent_id ? 'AI' : '@'}</span>
          <span class="thr-t">${esc(String(t.title).length > 42 ? String(t.title).slice(0, 41) + '…' : String(t.title))}</span>
          <span class="mut" style="margin-left:auto;font-size:.66rem;flex:none">${esc(String((t as { updated_at: string }).updated_at).slice(5, 10))}</span>
        </a>`;
      }).join('')
    : '<div class="empty" style="padding:.9rem .8rem;font-size:.8rem">No threads yet</div>';

  /** Per-run extras (reasoning + tool calls) hydrated from the run event log. */
  interface RunExtra { reasoning: string; tools: { callId: string; name: string; args?: unknown; result?: string; success?: boolean }[] }
  const runExtras = new Map<string, RunExtra>();
  for (const m of activeMsgs) {
    const runId = m.run_id ? String(m.run_id) : '';
    if (!runId || runExtras.has(runId)) continue;
    const ex: RunExtra = { reasoning: '', tools: [] };
    const byCall = new Map<string, { callId: string; name: string; args?: unknown; result?: string; success?: boolean }>();
    try {
      for (const ev of db.getEvents(runId)) {
        if (ev.type === 'chat.reasoning') {
          try { ex.reasoning += (JSON.parse(ev.payload_json) as { content?: string }).content ?? ''; } catch { /* skip */ }
        } else if (ev.type === 'tool.call') {
          const d = (JSON.parse(ev.payload_json) as { data?: { toolCallId?: string; toolName?: string; arguments?: unknown } }).data;
          if (d?.toolCallId) byCall.set(String(d.toolCallId), { callId: String(d.toolCallId), name: String(d.toolName ?? ''), args: d.arguments });
        } else if (ev.type === 'tool.result') {
          const d = (JSON.parse(ev.payload_json) as { data?: { toolCallId?: string; toolName?: string; success?: boolean; result?: { content?: string; detailedContent?: string } } }).data;
          if (d?.toolCallId) {
            const cur = byCall.get(String(d.toolCallId)) ?? { callId: String(d.toolCallId), name: String(d.toolName ?? ''), args: undefined as unknown };
            byCall.set(String(d.toolCallId), { ...cur, result: d.result?.content ?? d.result?.detailedContent ?? '', success: d.success });
          }
        }
      }
    } catch { /* best-effort hydration */ }
    ex.tools = [...byCall.values()];
    runExtras.set(runId, ex);
  }

  const bubbleHtml = (m: Record<string, unknown>): string => {
    const isUser = m.role === 'user';
    if (isUser) {
      return `<div class="row user"><div class="avatar" style="background:${USER_COLOR};color:${textColorOn(USER_COLOR)}">YOU</div><div class="bubble user"><span class="who">You</span>${esc(String(m.content ?? ''))}</div></div>`;
    }
    const author = String(m.author ?? 'agent');
    const c = colorOf(author);
    const extras = m.run_id ? runExtras.get(String(m.run_id)) : undefined;
    const reasoning = (m.reasoning ? String(m.reasoning) : extras?.reasoning) ?? '';
    const tools = (Array.isArray(m.tools) ? m.tools as RunExtra['tools'] : extras?.tools) ?? [];
    const runLink = m.run_id ? ` · <a href="/ui/runs/${encodeURIComponent(String(m.run_id))}" style="color:inherit;text-decoration:underline">run</a>` : '';
    const thinkHtml = reasoning.trim()
      ? `<details class="think"><summary>💭 View reasoning</summary><div class="think-body">${esc(reasoning)}</div></details>`
      : '';
    const toolsHtml = tools.length
      ? `<details class="think"><summary>🛠 ${tools.length} tool call${tools.length === 1 ? '' : 's'} this turn</summary><div class="think-body">${tools.map((t) => `<div class="tool-line"><code class="inline">${esc(t.name)}</code>${t.success === false ? ' <span style="color:var(--err)">✕ failed</span>' : ' ✓'}</div>`).join('')}</div></details>`
      : '';
    return `<div class="row agent"><div class="avatar" style="background:${c};color:${textColorOn(c)}">${esc(author.split('@')[0].replace(/^day-planner-|^fullstack-/, '').slice(0, 3).toUpperCase())}</div><div class="bubble agent" style="border-left:3px solid ${c}"><span class="who" style="color:${c}">${esc(author)}${runLink}</span>${thinkHtml}${toolsHtml}${esc(String(m.content ?? ''))}</div></div>`;
  };

  const transcript = activeMsgs.length
    ? activeMsgs.map(bubbleHtml).join('')
    : `<div class="chat-hero">
        <div class="hero-icon">💬</div>
        <h2>${isNew ? 'New chat' : active ? String(active.title) : 'Welcome to Chat'}</h2>
        <p>${isNew ? 'Pick an agent above and say hello — conversation memory persists across turns.' : active ? 'No messages yet — say something below.' : 'Start a New chat, or pick a saved thread from the rail.'}</p>
      </div>`;


  return pageShell({
    title: 'Chat', crumb: 'Chat', path: '/ui/chat',
    body: `
    <div class="page-head chatp-head">
      <div><h1>Chat</h1><div class="sub">Persistent multi-turn agent conversations · colored agent identities · @mention routing.</div></div>
      <div class="head-actions" id="newChatBar">
        <label class="nc-label">Type</label>
        <select id="ncType" class="nc-select">
          <option value="">— choose —</option>
          <option value="agent">Agent</option>
          <option value="general">General (@mention)</option>
        </select>
        <select id="ncEntity" class="nc-select" disabled>>
        <option value="">— pick —</option>
        </select>
        <button id="ncGo" class="btn sm" disabled>Start chat ➤</button>
      </div>
    </div>

    <div class="chat-layout">
      <aside class="chat-side">
        <div class="side-label">THREADS <span class="mut">(${threads.length})</span> <a href="/ui/chat/_new" style="margin-left:auto;font-weight:700;color:var(--acc2);text-decoration:none">＋ New</a></div>
        ${threadRows}
      </aside>

      <section class="chat-main">
        ${active ? `<div class="chat-head">
            <div class="ch-t">
              ${active.agent_id ? `<span class="chip" style="background:${colorOf(String(active.agent_id))};color:${textColorOn(colorOf(String(active.agent_id)))}">AI</span>` : `<span class="chip" style="background:#74809c;color:#14171f">@</span>`}
              <b>${esc(String(active.title))}</b>
              ${active.agent_id ? `<a class="btn ghost sm" href="/ui/agents/${encodeURIComponent(String(active.agent_id))}">🤖 agent page</a>` : ''}
            </div>
            <span class="thread-actions">
              <button class="btn ghost sm" id="chatReload" title="Refresh transcript">⟳</button>
              <button class="btn ghost sm danger" id="chatDelete" title="Delete this thread">🗑</button>
            </span>
          </div>` : ''}
        <div id="chatTranscript" class="chat-transcript">${transcript}</div>
        ${active ? `<div class="composer">
            <textarea id="chatInput" rows="2" placeholder="${active.agent_id ? 'Message ' + esc(String(active.agent_id).split('@')[0]) + '… (Enter to send)' : '@agent your message — @mention picks the responder (Enter to send)'}"></textarea>
            <button id="chatSend" class="btn">Send ➤</button>
          </div>` : ''}
      </section>
    </div>

    <style>
      .chatp-head{margin-bottom:1.1rem}
      .nc-label{font-size:.74rem;text-transform:uppercase;letter-spacing:1px;color:var(--mut);font-weight:700}
      .nc-select{width:auto;min-width:170px;background:var(--bg2,#0a0e18);border:1px solid var(--line2);border-radius:var(--r-sm);color:var(--text);padding:.45rem .65rem;font:600 .84rem var(--sans)}
      .nc-select:disabled{opacity:.45}
      .chat-layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:1.1rem;height:calc(100vh - 190px);min-height:520px}
      .chat-side{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);overflow-y:auto}
      .side-label{display:flex;align-items:center;gap:.4rem;font-size:.66rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--mut);padding:.6rem .8rem;border-bottom:1px solid var(--line);font-weight:700;position:sticky;top:0;background:var(--panel);z-index:2}
      .chat-thr{display:flex;align-items:center;gap:.6rem;padding:.6rem .8rem;border-bottom:1px solid var(--line);color:var(--text2);font-size:.84rem}
      .chat-thr:hover{background:var(--panel2);color:var(--text)}
      .chat-thr.on{background:var(--acc-soft);color:#c3baff}
      .chip{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;font-size:.68rem;font-weight:800;flex:none;letter-spacing:.3px}
      .thr-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .chat-main{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;min-height:0}
      .chat-head{display:flex;align-items:center;gap:.8rem;padding:.7rem 1.1rem;border-bottom:1px solid var(--line);flex:none}
      .ch-t{display:flex;align-items:center;gap:.65rem;min-width:0}
      .ch-t b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .roster{display:flex;gap:.45rem;flex-wrap:wrap;padding:.55rem 1.1rem;border-bottom:1px solid var(--line);flex:none}
      .pchip{display:inline-flex;align-items:center;gap:.35rem;font-size:.72rem;padding:.15rem .6rem;border:1px solid var(--line);border-radius:99px;color:var(--text2)}
      .pdot{width:8px;height:8px;border-radius:50%;flex:none}
      .chat-transcript{flex:1;overflow-y:auto;padding:1.1rem 1.3rem;display:flex;flex-direction:column;gap:.75rem;min-height:0}
      .chat-hero{margin:auto;text-align:center;max-width:46ch}
      .chat-hero .hero-icon{font-size:2.2rem;margin-bottom:.4rem}
      .chat-hero h2{margin:0 0 .3rem;font-size:1.15rem}
      .chat-hero p{margin:0;color:var(--mut);font-size:.88rem;line-height:1.6}
      .row{display:flex;gap:.6rem;align-items:flex-end}
      .row.user{flex-direction:row-reverse}
      .avatar{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-size:.62rem;font-weight:800;flex:none;letter-spacing:.4px}
      .bubble{max-width:76%;padding:.55rem .85rem;border-radius:13px;font-size:.87rem;line-height:1.55;white-space:pre-wrap;word-break:break-word}
      .row.user .bubble{background:var(--acc);color:#fff;border-bottom-right-radius:4px}
      .bubble.agent{background:var(--panel2);border:1px solid var(--line);border-bottom-left-radius:4px}
      .bubble .who{display:block;font-size:.66rem;margin-bottom:.2rem;font-weight:700}
      .row.user .bubble .who{color:rgba(255,255,255,.8)}
      .bubble.agent .who{opacity:.95}
      .think{margin:.15rem 0 .35rem;font-size:.78em}
      .think>summary{cursor:pointer;color:var(--mut);user-select:none;font-size:.92em}
      .think>summary:hover{color:var(--text2)}
      .think .think-body{margin-top:.25rem;padding:.5rem .65rem;background:var(--bg2,#0a0e18);border:1px solid var(--line);border-radius:8px;white-space:pre-wrap;color:var(--mut);max-height:16em;overflow-y:auto;font-size:.95em}
      .tool-line{padding:.12rem 0}
      .composer{display:flex;gap:.6rem;padding:.8rem 1.1rem;border-top:1px solid var(--line);align-items:flex-end;flex:none;background:var(--bg2,#0a0e18)}
      .composer textarea{flex:1;resize:none;min-height:46px;max-height:9rem;background:var(--panel2);border:1px solid var(--line);border-radius:var(--r-md);color:var(--text);padding:.6rem .8rem;font:inherit}
      .composer .btn{flex:none}
      @media(max-width:900px){.chat-layout{grid-template-columns:1fr;height:auto}.chat-main{min-height:65vh}}
    </style>
    <script>${TOAST_JS}
    var activeId=${activeId ? JSON.stringify(String(activeId)) : 'null'};
    var ncType=document.getElementById('ncType'), ncEntity=document.getElementById('ncEntity'), ncGo=document.getElementById('ncGo');
    var AGENT_OPTS=${JSON.stringify(agents.map((a) => a.id))};
    ncType?.addEventListener('change',function(){
      var t=ncType.value;
      ncEntity.innerHTML='<option value="">— pick —</option>' + (t==='agent'?AGENT_OPTS:[]).map(function(o){return '<option value="'+o+'">'+o+'</option>'}).join('');
      ncEntity.disabled=t!=='agent'; ncGo.disabled=t!=='general' && !ncEntity.value;
    });
    ncEntity?.addEventListener('change',function(){ ncGo.disabled=!ncEntity.value; });
    ncGo?.addEventListener('click',async function(){
      var body={}; if(ncType.value==='agent') body.agentId=ncEntity.value;
      try{ var j=await api('/api/chat/threads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        location.href='/ui/chat/'+encodeURIComponent(j.id);
      }catch(e){ toast('err','Create failed',e.message); }
    });
    document.getElementById('chatDelete')?.addEventListener('click',async function(){
      if(!confirm('Delete this thread and its transcript?'))return;
      try{ await api('/api/chat/threads/'+encodeURIComponent(activeId),{method:'DELETE'}); location.href='/ui/chat/_new'; }
      catch(e){ toast('err','Delete failed',e.message); }
    });
    document.getElementById('chatReload')?.addEventListener('click',function(){ location.reload(); });
    var sendBtn=document.getElementById('chatSend');
    function agentColorOf(id){ return colOf(id); }
    function shortName(id){ return String(id||'agent').split('@')[0].replace(/^(day-planner|fullstack)-/,''); }
    function initialsOf(id){ return shortName(id).slice(0,3).toUpperCase(); }
    
    // ---------- persistent live feed (SSE): turns, reasoning, tools ----------
    var tr=document.getElementById('chatTranscript');
    var es=null; var livePane=null; // {row, agentId, reasoning, tools[], turnSeq}
    function newLivePane(agentId){
      var row=document.createElement('div'); row.className='row agent';
      var c=agentColorOf(agentId||'');
      row.innerHTML='<div class="avatar" style="background:'+c+';color:'+textOn(c)+'">'+escHtml(initialsOf(agentId))+'</div>'+
        '<div class="bubble agent liveTurn" style="border-left:3px solid '+c+'">'+
          '<span class="who" style="color:'+c+'">'+escHtml(agentId||'agent')+' <span class="mut">is working…</span></span>'+
          '<details class="think" open><summary>💭 Thinking <span class="mut">(live)</span></summary><div class="think-body thinkBody mut">…</div></details>'+
          '<details class="think liveTools" style="display:none"><summary>🛠 Tools <span class="toolCount"></span></summary><div class="think-body toolsBody"></div></details>'+
          '<div class="liveText"></div>'+
        '</div>';
      tr.appendChild(row); tr.scrollTop=tr.scrollHeight;
      livePane={row:row,agentId:agentId||'',reasoning:'',tools:[],seq:0};
      return livePane;
    }
    function styleLivePane(){
      if(!livePane) return;
      var c=agentColorOf(livePane.agentId);
      var av=livePane.row.querySelector('.avatar'), bu=livePane.row.querySelector('.bubble'), who=livePane.row.querySelector('.who');
      av.style.background=c; av.style.color=textOn(c); av.textContent=escHtml(initialsOf(livePane.agentId));
      bu.style.borderLeft='3px solid '+c; who.style.color=c; who.innerHTML=escHtml(livePane.agentId)+' <span class="mut">is working…</span>';
    }
    function finalizeLivePane(finalHtml){
      if(!livePane) return;
      livePane.row.querySelector('.bubble').classList.remove('liveTurn');
      if(finalHtml!==undefined){ var bu=livePane.row.querySelector('.bubble'); var who=bu.querySelector('.who'); bu.innerHTML=who.outerHTML+finalHtml; }
      livePane=null;
    }
    function toolLines(tools){
      return tools.map(function(t){ return '<div class="tool-line"><code class="inline">'+escHtml(t.name||'tool')+'</code>'+(t.ok===undefined?' <span class="mut">…</span>':(t.ok?' ✓':' <span style="color:var(--err)">✕ failed</span>'))+'</div>'; }).join('');
    }
    function refreshPaneTools(){
      if(!livePane) return;
      var toolsEl=livePane.row.querySelector('.liveTools'); var body=livePane.row.querySelector('.toolsBody');
      toolsEl.style.display=livePane.tools.length?'':'none';
      livePane.row.querySelector('.toolCount').textContent='('+livePane.tools.length+')';
      body.innerHTML=toolLines(livePane.tools);
    }
    function handleActivity(d){
      // reasoning / tool-start / tool-complete route into the current live pane
      if(!livePane && (d.type==='reasoning'||d.type==='tool-start')){ newLivePane(''); }
      if(!livePane) return;
      if(d.type==='reasoning' && d.reasoning){
        livePane.reasoning=d.reasoning;
        var b=livePane.row.querySelector('.thinkBody'); b.className='think-body thinkBody'; b.textContent=livePane.reasoning;
        tr.scrollTop=tr.scrollHeight;
      }else if(d.type==='tool-start'){
        livePane.tools.push({name:d.name||'tool',callId:d.callId,ok:undefined}); refreshPaneTools(); tr.scrollTop=tr.scrollHeight;
      }else if(d.type==='tool-complete'){
        var hit=livePane.tools.filter(function(t){return t.callId===d.callId})[0]||livePane.tools[livePane.tools.length-1];
        if(hit){ hit.ok=d.success!==false; if(!hit.name||hit.name==='tool') hit.name=d.name||hit.name; }
        refreshPaneTools();
      }
    }
    function connectStream(){
      if(es){ try{ es.close(); }catch(err){} }
      try{ es=new EventSource('/api/chat/threads/'+encodeURIComponent(activeId)+'/stream'); }catch(err){ return; }
      es.addEventListener('activity',function(ev){ try{ handleActivity(JSON.parse(ev.data)); }catch(err){} });
      es.addEventListener('reply',function(ev){ // direct 1:1 turn finished — final persist happens via POST response
        try{ var d=JSON.parse(ev.data); if(d.agentId && livePane && !livePane.agentId){ livePane.agentId=d.agentId; styleLivePane(); } }catch(err){}
      });
    }
    if(activeId) connectStream();

    sendBtn?.addEventListener('click',async function(){
      if(!activeId) return;
      var ta=document.getElementById('chatInput');
      var text=(ta.value||'').trim(); if(!text) return;
      ta.value=''; sendBtn.disabled=true;
      var hero=tr.querySelector('.chat-hero'); if(hero) hero.remove();
      var row=document.createElement('div'); row.className='row user';
      row.innerHTML='<div class="avatar" style="background:${USER_COLOR};color:${textColorOn(USER_COLOR)}">YOU</div><div class="bubble user"><span class="who">You</span>'+escHtml(text)+'</div>';
      tr.appendChild(row); tr.scrollTop=tr.scrollHeight;
      newLivePane(''); var whoEl=livePane.row.querySelector('.who'); whoEl.innerHTML='<span class="mut">working…</span>';
      try{
        var j=await api('/api/chat/threads/'+encodeURIComponent(activeId)+'/messages?wait=true',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:text}),timeoutMs:${15 * 60 * 1000}});
        // direct 1:1 turn: finalize with persisted reasoning + tool sections
        var pid=livePane.agentId||(j.agentId||'agent');
        livePane.agentId=pid; styleLivePane();
        var c=agentColorOf(pid);
        var thinkHtml=j.reasoning?'<details class="think"><summary>💭 View reasoning</summary><div class="think-body">'+escHtml(j.reasoning)+'</div></details>':'';
        var toolsHtml=(j.tools&&j.tools.length)?'<details class="think"><summary>🛠 '+j.tools.length+' tool call'+(j.tools.length===1?'':'s')+' this turn</summary><div class="think-body">'+toolLines(j.tools.map(function(t){return {name:t.name,ok:t.success!==false}}))+'</div></details>':'';
        finalizeLivePane('<span class="who" style="color:'+c+'">'+escHtml(pid)+'</span>'+thinkHtml+toolsHtml+escHtml(j.text||'(empty reply)'));
        sendBtn.disabled=false;
      }catch(e){
        if(livePane){
          var c=agentColorOf(livePane.agentId);
          var rp=livePane.reasoning?'<details class="think"><summary>💭 show streaming reasoning so far</summary><div class="think-body">'+escHtml(livePane.reasoning)+'</div></details>':'';
          livePane.row.querySelector('.bubble').classList.remove('liveTurn');
          livePane.row.innerHTML='<div class="avatar" style="background:var(--err);color:#fff">!</div><div class="bubble agent err" style="border-left:3px solid var(--err)"><span class="who" style="color:var(--err)">error</span>'+rp+escHtml(e.message)+'</div>';
          livePane=null;
        }
        sendBtn.disabled=false;
      }
      tr.scrollTop=tr.scrollHeight; ta.focus();
    });
    document.getElementById('chatInput')?.addEventListener('keydown',function(ev){
      if(ev.key==='Enter'&&!ev.shiftKey&&activeId){ ev.preventDefault(); document.getElementById('chatSend').click(); }
    });
    function colOf(id){ return colorMap[id] || '#74809c'; }
    function textOn(c){ var m=/^#([0-9a-f]{6})$/.exec(c||''); if(!m) return '#f5f6f8'; var n=parseInt(c.slice(1),16); var r=(n>>16)&255,g=(n>>8)&255,b=n&255; var lin=function(x){x=x/255;return x<=0.03928?x/12.92:Math.pow((x+0.055)/1.055,2.4)}; var L=0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b); return L>0.45?'#14171f':'#f5f6f8'; }
    var colorMap=${JSON.stringify(Object.fromEntries(agents.map((a) => [a.id, colorOf(a.id)])))};
    function escHtml(s){ return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]}) }
    document.getElementById('chatTranscript')?.scrollTo(0,1e9);
    </script>`,
    chat: threads.length,
  });
}
