import { esc } from './ui-util.js';

// ============================================================
// Design system — enterprise SaaS theme (Layerworks / deep-indigo)
// ============================================================
export const UI_CSS = `
:root{
  --bg:#0a0d16; --bg2:#0d111d; --panel:#121726; --panel2:#182032; --panel3:#20293e;
  --line:#232c42; --line2:#2e3a58; --text:#eaeef7; --text2:#aab4c9; --mut:#74809c;
  --acc:#6d5cff; --acc-b:#4f7dff; --acc2:#9a8bff; --acc-grad:linear-gradient(135deg,#6d5cff,#4f7dff);
  --acc-soft:rgba(109,92,255,.14); --acc-line:rgba(109,92,255,.4);
  --ok:#2fd68f; --ok-soft:rgba(47,214,143,.13);
  --err:#ff6b7a; --err-soft:rgba(255,107,122,.12);
  --warn:#ffb547; --warn-soft:rgba(255,181,71,.13);
  --cyan:#4fd8e0;
  --shadow:0 12px 32px rgba(3,6,16,.5); --shadow-sm:0 2px 10px rgba(3,6,16,.35);
  --r-lg:14px; --r-md:10px; --r-sm:8px;
  --mono:ui-monospace,'Cascadia Code','JetBrains Mono',Consolas,monospace;
  --sans:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;font:14px/1.6 var(--sans);background:var(--bg);color:var(--text);min-height:100%;-webkit-font-smoothing:antialiased}
body{background:
  radial-gradient(900px 420px at 85% -10%, rgba(109,92,255,.09), transparent 60%),
  radial-gradient(700px 380px at -10% 20%, rgba(79,125,255,.06), transparent 55%),
  var(--bg)}
::selection{background:var(--acc-line)}
a{color:var(--acc2);text-decoration:none}a:hover{color:#b9aeff;text-decoration:none}
code{font-family:var(--mono);font-size:.9em}
code.inline{background:var(--panel2);border:1px solid var(--line);padding:.08em .4em;border-radius:5px}
pre{background:#0a0e18;border:1px solid var(--line);border-radius:var(--r-md);padding:.9rem 1rem;overflow:auto;font:12.5px/1.55 var(--mono);margin:.5rem 0;color:#c9d3e8}
pre::-webkit-scrollbar,.scroll::-webkit-scrollbar{height:8px;width:8px}
pre::-webkit-scrollbar-thumb,.scroll::-webkit-scrollbar-thumb{background:var(--line2);border-radius:4px}
pre::-webkit-scrollbar-track,.scroll::-webkit-scrollbar-track{background:transparent}

/* ---------- layout ---------- */
.shell{display:grid;grid-template-columns:244px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;background:linear-gradient(180deg,#0d1220,#0a0d16);border-right:1px solid var(--line);display:flex;flex-direction:column;z-index:20}
.sb-brand{display:flex;align-items:center;gap:.7rem;padding:1.15rem 1.2rem;border-bottom:1px solid var(--line)}
.sb-logo{width:34px;height:34px;border-radius:10px;background:var(--acc-grad);display:grid;place-items:center;font-weight:800;color:#fff;font-size:15px;flex:none;box-shadow:0 4px 14px rgba(109,92,255,.4)}
.sb-brand-t{font-weight:700;font-size:.95rem;letter-spacing:.2px}.sb-brand-t small{display:block;font-size:.66rem;color:var(--mut);font-weight:500;letter-spacing:.6px;text-transform:uppercase}
.sb-nav{flex:1;overflow-y:auto;padding:.8rem .75rem;display:flex;flex-direction:column;gap:.18rem}
.sb-label{font-size:.63rem;text-transform:uppercase;letter-spacing:1.4px;color:var(--mut);margin:.95rem .55rem .35rem;font-weight:700}
.sb-nav a{display:flex;align-items:center;gap:.65rem;padding:.5rem .75rem;border-radius:var(--r-sm);color:var(--text2);font-size:.885rem;font-weight:500;position:relative;transition:background .15s,color .15s}
.sb-nav a svg{width:16px;height:16px;flex:none;opacity:.75}
.sb-nav a:hover{background:var(--panel);color:var(--text)}
.sb-nav a.on{background:var(--acc-soft);color:#c3baff;font-weight:600}
.sb-nav a.on::before{content:'';position:absolute;left:-0.75rem;top:22%;bottom:22%;width:3px;border-radius:0 3px 3px 0;background:var(--acc-grad)}
.sb-nav .cnt{margin-left:auto;font-size:.7rem;color:var(--text2);background:var(--panel3);border-radius:99px;padding:0 .5rem;min-width:23px;text-align:center;font-variant-numeric:tabular-nums}
.sb-foot{padding:.85rem 1.2rem;border-top:1px solid var(--line);font-size:.74rem;color:var(--mut);display:flex;align-items:center;gap:.45rem}
.sb-dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 6px rgba(47,214,143,.8);flex:none}
.main{min-width:0;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;gap:1rem;padding:.8rem 2rem;border-bottom:1px solid var(--line);background:rgba(10,13,22,.75);backdrop-filter:blur(10px);position:sticky;top:0;z-index:15}
.crumb{font-size:.8rem;color:var(--mut)}.crumb b{color:var(--text);font-weight:600}
.tb-actions{margin-left:auto;display:flex;gap:.55rem;align-items:center}
.page{padding:1.7rem 2.25rem 3.5rem;width:100%;min-width:0}
@media(min-width:2000px){.page{max-width:1920px;margin:0 auto}}
.page-head{display:flex;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
.page-head h1{font-size:1.45rem;margin:0;font-weight:800;letter-spacing:-.3px}
.page-head .sub{color:var(--mut);font-size:.9rem;margin-top:.25rem;max-width:64ch}
.page-head .head-actions{margin-left:auto;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
h2.sec{font-size:.7rem;text-transform:uppercase;letter-spacing:1.3px;color:var(--mut);margin:1.8rem 0 .75rem;font-weight:700}

/* ---------- cards / grid ---------- */
.card{background:linear-gradient(180deg,rgba(255,255,255,.015),transparent 40%),var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:1.2rem 1.35rem;box-shadow:var(--shadow-sm)}
.card.flush{padding:0}.card .card-body{padding:1.2rem 1.35rem}
.card h3{font-size:.68rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--mut);margin:0 0 .85rem;font-weight:700;display:flex;align-items:center;gap:.5rem}
.grid{display:grid;gap:1rem}
.grid.c2{grid-template-columns:repeat(auto-fit,minmax(400px,1fr))}
.grid.c3{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.grid.c4{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.split{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:1rem;align-items:start}

/* ---------- stat tiles ---------- */
.stat{position:relative;background:linear-gradient(180deg,rgba(255,255,255,.018),transparent 45%),var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:1.05rem 1.15rem;overflow:hidden}
.stat::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--acc-grad);opacity:0;transition:opacity .2s}
.stat:hover::after{opacity:1}
.stat .k{font-size:.67rem;text-transform:uppercase;letter-spacing:1.1px;color:var(--mut);font-weight:700}
.stat .v{font-size:1.7rem;font-weight:800;margin:.3rem 0 .1rem;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.stat .d{font-size:.76rem;color:var(--mut)}
.stat.acc{border-color:var(--acc-line)} .stat.acc .v{background:var(--acc-grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.stat.ok .v{color:var(--ok)} .stat.err .v{color:var(--err)}

/* ---------- buttons ---------- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;background:var(--acc-grad);color:#fff;border:0;border-radius:var(--r-sm);padding:.52rem 1.05rem;font:600 .85rem var(--sans);cursor:pointer;transition:filter .15s,box-shadow .15s,transform .05s;box-shadow:0 2px 10px rgba(109,92,255,.25)}
.btn:hover{filter:brightness(1.12);color:#fff;box-shadow:0 4px 16px rgba(109,92,255,.35)}
.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.45;cursor:not-allowed;filter:none;box-shadow:none}
.btn.ghost{background:transparent;color:var(--text2);border:1px solid var(--line2);box-shadow:none}
.btn.ghost:hover{color:var(--text);border-color:var(--mut)}
.btn.danger{background:transparent;color:var(--err);border:1px solid rgba(255,107,122,.35);box-shadow:none}
.btn.danger:hover{background:var(--err-soft)}
.btn.sm{padding:.32rem .7rem;font-size:.78rem}
.btn .spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}

/* ---------- forms (full width, responsive) ---------- */
.field{margin-bottom:1rem}
.field label{display:block;font-size:.8rem;font-weight:600;margin-bottom:.35rem;color:var(--text2)}
.field label .req{color:var(--err)}
.field .hint{font-size:.74rem;color:var(--mut);margin-top:.3rem;display:block;line-height:1.5}
input[type=text],input[type=number],select,textarea{width:100%;background:#0a0e18;border:1px solid var(--line2);border-radius:var(--r-sm);color:var(--text);padding:.6rem .75rem;font:inherit;font-size:.88rem;transition:border-color .15s,box-shadow .15s}
input::placeholder,textarea::placeholder{color:#525e78}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-soft)}
input.bad,textarea.bad,select.bad{border-color:var(--err);box-shadow:0 0 0 3px var(--err-soft)}
textarea{min-height:300px;font-family:var(--mono);font-size:.82rem;resize:vertical;line-height:1.55}
textarea.sm{min-height:140px}
input[type=checkbox]{accent-color:var(--acc);width:auto;margin-right:.4rem;vertical-align:-2px}
.field-err{font-size:.76rem;color:var(--err);margin-top:.3rem;display:none}
.field-err.show{display:block}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:.8rem 1rem}
@media(max-width:760px){.form-grid{grid-template-columns:1fr}}

/* ---------- badges/pills ---------- */
.badge{display:inline-block;padding:.14rem .62rem;border-radius:99px;font-size:.67rem;font-weight:700;text-transform:uppercase;letter-spacing:.6px}
.badge.ok{background:var(--ok-soft);color:var(--ok)}.badge.err{background:var(--err-soft);color:var(--err)}
.badge.run{background:var(--acc-soft);color:var(--acc2)}.badge.idle,.badge.queued{background:rgba(116,128,156,.16);color:var(--mut)}
.badge.warn{background:var(--warn-soft);color:var(--warn)}
.pill{font-size:.74rem;color:var(--text2);background:var(--panel2);border:1px solid var(--line);padding:.14rem .6rem;border-radius:99px;display:inline-flex;gap:.4rem;align-items:center}
.pill.tool-pill{background:var(--acc-soft);border-color:var(--acc-line);color:#c3baff;font-weight:600}
.pill.ok-pill{background:var(--ok-soft);border-color:rgba(47,214,143,.3);color:var(--ok);font-weight:600}
.pill.err-pill{background:var(--err-soft);border-color:rgba(255,107,122,.3);color:var(--err);font-weight:600}
.pill.perm-pill{background:var(--warn-soft);border-color:rgba(255,181,71,.3);color:var(--warn);font-weight:600}
.pill code{color:var(--mut);font-size:.8em}

/* ---------- tables ---------- */
table{width:100%;border-collapse:collapse}
th{color:var(--mut);font-size:.65rem;text-transform:uppercase;letter-spacing:1.1px;text-align:left;padding:.6rem .9rem;border-bottom:1px solid var(--line);font-weight:700;background:#0d1220;position:sticky;top:0;z-index:1}
td{padding:.65rem .9rem;border-bottom:1px solid var(--line);font-size:.85rem;vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tr.rowlink{cursor:pointer;transition:background .12s}
tr.rowlink:hover td{background:var(--panel2)}
.tbl-wrap{overflow:auto;max-height:520px;border-radius:0 0 var(--r-lg) var(--r-lg)}

/* ---------- misc ---------- */
.mut{color:var(--mut)} .t2{color:var(--text2)} .ok-t{color:var(--ok)} .err-t{color:var(--err)} .warn-t{color:var(--warn)}
.bar{height:6px;border-radius:3px;background:var(--panel3);overflow:hidden}
.bar i{display:block;height:100%;background:var(--acc-grad);border-radius:3px}
.empty{padding:2.4rem 1rem;text-align:center;color:var(--mut);font-size:.88rem;line-height:1.7}
.empty .big{font-size:1.7rem;display:block;margin-bottom:.4rem;opacity:.7}
.divider{height:1px;background:var(--line);margin:1rem 0}
details>summary{cursor:pointer;color:var(--text2);font-size:.8rem;padding:.25rem 0}
details>summary:hover{color:var(--text)}
.kv{font-size:.85rem}.kv td{padding:.42rem .8rem}.kv td:first-child{color:var(--mut);width:150px}

/* ---------- toast ---------- */
#toasts{position:fixed;bottom:1.4rem;right:1.4rem;display:flex;flex-direction:column;gap:.6rem;z-index:100;max-width:410px}
.toast{background:var(--panel);border:1px solid var(--line2);border-left:3px solid var(--acc);border-radius:var(--r-md);padding:.75rem 1rem;box-shadow:var(--shadow);font-size:.85rem;display:flex;gap:.7rem;align-items:flex-start;animation:tin .25s ease}
.toast.ok{border-left-color:var(--ok)}.toast.err{border-left-color:var(--err)}.toast.warn{border-left-color:var(--warn)}
.toast .ti{flex:none;font-weight:700}
.toast.ok .ti{color:var(--ok)}.toast.err .ti{color:var(--err)}.toast.warn .ti{color:var(--warn)}.toast.info .ti{color:var(--acc)}
.toast .tx{flex:1;min-width:0}.toast .tx code{font-size:.8em}.toast .tx .sub{display:block;color:var(--mut);font-size:.76rem;margin-top:.15rem}
.toast .tclose{flex:none;background:none;border:0;color:var(--mut);cursor:pointer;font-size:1rem;padding:0 0 0 .2rem}
.toast .tclose:hover{color:var(--text)}
.toast.out{opacity:0;transform:translateX(12px);transition:all .3s}
@keyframes tin{from{opacity:0;transform:translateY(8px)}}

/* ---------- inline alert ---------- */
.alert{border-radius:var(--r-md);padding:.7rem .95rem;font-size:.84rem;border:1px solid;display:flex;gap:.6rem;align-items:flex-start;margin:.4rem 0}
.alert.ok{background:var(--ok-soft);border-color:rgba(47,214,143,.3);color:var(--ok)}
.alert.err{background:var(--err-soft);border-color:rgba(255,107,122,.3);color:var(--err)}
.alert.warn{background:var(--warn-soft);border-color:rgba(255,181,71,.3);color:var(--warn)}
.alert.info{background:var(--acc-soft);border-color:var(--acc-line);color:#b9aeff}
.alert p{margin:0}.alert b{font-weight:700}

/* ---------- event timeline ---------- */
.tl{position:relative;padding-left:1rem}
.tl::before{content:'';position:absolute;left:4px;top:6px;bottom:6px;width:1px;background:var(--line)}
.tl-item{position:relative;padding:.45rem 0 .45rem .6rem;font-size:.85rem}
.tl-item::before{content:'';position:absolute;left:-1rem;top:.9rem;width:9px;height:9px;border-radius:50%;background:var(--panel3);border:2px solid var(--line2)}
.tl-item.t-run::before{background:var(--acc);border-color:var(--acc)}
.tl-item.t-tool::before{background:var(--acc-b);border-color:var(--acc-b)}
.tl-item.t-result::before{background:var(--cyan);border-color:var(--cyan)}
.tl-item.t-perm::before{background:var(--warn);border-color:var(--warn)}
.tl-item.t-err::before{background:var(--err);border-color:var(--err)}
.tl-item.t-ok::before{background:var(--ok);border-color:var(--ok)}
.tl-item .tt{font-size:.7rem;color:var(--mut);font-family:var(--mono);margin-right:.6rem}
.tl-item .tn{font-weight:600;font-size:.84rem}
.tl-item .td{color:var(--mut);font-size:.8rem}
.tl-item pre{margin:.35rem 0 0;max-height:220px}
@media(max-width:720px){.page{padding:1rem .9rem 2rem}.topbar{padding:.7rem 1rem}.page-head .head-actions{margin-left:0;width:100%}}
`;

// ---------- icons (inline SVG) ----------
const I = {
  grid: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',
  bot: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="4" width="12" height="9" rx="2"/><circle cx="5.5" cy="8" r="1.2" fill="var(--bg2)"/><circle cx="10.5" cy="8" r="1.2" fill="var(--bg2)"/><path d="M8 1v3" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="1.5" r="1.3"/></svg>',
  edit: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 1.5l3 3-9 9-3.6.6.6-3.6 9-9z"/><path d="M2 14h12v.8H2z" opacity=".6"/></svg>',
  play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l9 6-9 6V2z"/></svg>',
  list: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="3" height="3" rx="1"/><rect x="6" y="3" width="9" height="2"/><rect x="1" y="7" width="3" height="3" rx="1"/><rect x="6" y="8" width="9" height="2"/><rect x="1" y="12" width="3" height="3" rx="1"/><rect x="6" y="13" width="9" height="2"/></svg>',
  plug: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 1v4M11 1v4" stroke="currentColor" stroke-width="2"/><path d="M3 5h10v3a5 5 0 01-4 5v2H7v-2a5 5 0 01-4-5V5z"/></svg>',
  doc: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h7l3 3v11H3V1z" opacity=".5"/><path d="M10 1v3h3" opacity=".8"/></svg>',
};

export interface NavItem { href: string; label: string; icon: keyof typeof I; count?: number }
export interface NavGroup { label: string; items: NavItem[] }

function navHtml(groups: NavGroup[]): string {
  const icon = (k: keyof typeof I) => I[k] ?? '';
  return groups.map((g) => `<div class="sb-label">${esc(g.label)}</div>` + g.items
    .map((it) => `<a href="${esc(it.href)}" data-nav="${esc(it.href)}">${icon(it.icon)}${esc(it.label)}${it.count !== undefined ? `<span class="cnt">${it.count}</span>` : ''}</a>`)
    .join('')).join('');
}

function activeScript(path: string): string {
  return `<script>(function(){var p=${JSON.stringify(path)};document.querySelectorAll('.sb-nav a').forEach(function(a){var h=a.getAttribute('data-nav');if(h===p||p.startsWith(h+'/'))a.classList.add('on');});})();</script>`;
}

export function pageShell(opts: { title: string; crumb: string; path: string; body: string; agents?: number; runs?: number; mcp?: number }): string {
  const nav: NavGroup[] = [
    { label: 'Overview', items: [{ href: '/', label: 'Dashboard', icon: 'grid' }] },
    {
      label: 'Agents', items: [
        { href: '/ui/agents', label: 'Agents', icon: 'bot', count: opts.agents },
        { href: '/ui', label: 'Define', icon: 'edit' },
      ],
    },
    { label: 'Operations', items: [{ href: '/ui/runs', label: 'Runs', icon: 'play', count: opts.runs }, { href: '/ui/sessions', label: 'Sessions', icon: 'list' }] },
    { label: 'Integrations', items: [{ href: '/ui/mcp', label: 'MCP Registry', icon: 'plug', count: opts.mcp }] },
    { label: 'Developer', items: [{ href: '/docs', label: 'API Docs', icon: 'doc' }] },
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)} · Minion Assembler</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${UI_CSS}</style></head>
<body><div id="toasts"></div>
<div class="shell">
  <aside class="sidebar">
    <div class="sb-brand"><div class="sb-logo">M</div><div class="sb-brand-t">Minion Assembler<small>Agent Control Plane</small></div></div>
    <nav class="sb-nav">${navHtml(nav)}</nav>
    <div class="sb-foot"><span class="sb-dot"></span> API online · loopback</div>
  </aside>
  <div class="main">
    <div class="topbar"><div class="crumb">Control Plane${opts.crumb ? ' / <b>' + esc(opts.crumb) + '</b>' : ''}</div><div class="tb-actions"><a href="/ui" class="btn sm" style="text-decoration:none">+ New Definition</a></div></div>
    <div class="page">${opts.body}</div>
  </div>
</div>
${activeScript(opts.path)}</body></html>`;
}

/** Shared client JS: toast() + api() helper. Injected into pages that need it. */
export const TOAST_JS = `
  function toast(type,msg,sub){
    var box=document.getElementById('toasts');if(!box){box=document.createElement('div');box.id='toasts';document.body.appendChild(box)}
    var t=document.createElement('div');t.className='toast '+type;
    var ic={ok:'✓',err:'✕',warn:'▲',info:'ℹ'}[type]||'ℹ';
    t.innerHTML='<span class="ti">'+ic+'</span><div class="tx"><div>'+msg+(sub?'<span class="sub">'+sub+'</span>':'')+'</div></div><button class="tclose" aria-label="dismiss">×</button>';
    t.querySelector('.tclose').onclick=function(){dismiss(t)};
    box.appendChild(t);
    setTimeout(function(){dismiss(t)},type==='err'?9000:4500);
    function dismiss(el){el.classList.add('out');setTimeout(function(){el.remove()},320)}
  }
  async function api(path,opts){
    var r;
    try{r=await fetch(path,opts)}
    catch(e){throw new Error('network error — is the server running?')}
    var j;
    try{j=await r.json()}catch{var txt=await r.text();j={error:txt||('HTTP '+r.status)}}
    if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
    return j;
  }
  function busyBtn(btn,html){btn.disabled=true;btn.dataset.html=btn.innerHTML;btn.innerHTML='<span class="spin"></span> '+(html||'Working…')}
  function resetBtn(btn){btn.disabled=false;btn.innerHTML=btn.dataset.html}
`;
