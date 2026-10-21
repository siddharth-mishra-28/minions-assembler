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
input[type=text],input[type=password],input[type=number],select,textarea{width:100%;background:#0a0e18;border:1px solid var(--line2);border-radius:var(--r-sm);color:var(--text);padding:.6rem .75rem;font:inherit;font-size:.88rem;transition:border-color .15s,box-shadow .15s}
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

/* ---------- Light Mode Color Theme ---------- */
[data-theme="light"]{
  --bg:#f8fafc; --bg2:#ffffff; --panel:#ffffff; --panel2:#f1f5f9; --panel3:#e2e8f0;
  --line:#e2e8f0; --line2:#cbd5e1; --text:#0f172a; --text2:#334155; --mut:#64748b;
  --acc:#6366f1; --acc-b:#3b82f6; --acc2:#4f46e5; --acc-grad:linear-gradient(135deg,#6366f1,#3b82f6);
  --acc-soft:rgba(99,102,241,.1); --acc-line:rgba(99,102,241,.35);
  --ok:#10b981; --ok-soft:rgba(16,185,129,.12);
  --err:#ef4444; --err-soft:rgba(239,68,68,.12);
  --warn:#f59e0b; --warn-soft:rgba(245,158,11,.12);
  --cyan:#06b6d4;
  --shadow:0 12px 32px rgba(15,23,42,.08); --shadow-sm:0 2px 8px rgba(15,23,42,.04);
}
[data-theme="light"] body{
  background:
    radial-gradient(900px 420px at 85% -10%, rgba(99,102,241,.05), transparent 60%),
    radial-gradient(700px 380px at -10% 20%, rgba(59,130,246,.04), transparent 55%),
    var(--bg);
}
[data-theme="light"] .sidebar{
  background:linear-gradient(180deg,#ffffff,#f8fafc);
  border-right:1px solid var(--line);
}
[data-theme="light"] .topbar{
  background:rgba(255,255,255,.88);
  border-bottom:1px solid var(--line);
}
[data-theme="light"] input[type=text],
[data-theme="light"] input[type=password],
[data-theme="light"] input[type=number],
[data-theme="light"] select,
[data-theme="light"] textarea{
  background:#ffffff;
  color:var(--text);
  border-color:var(--line2);
}
[data-theme="light"] th{
  background:#f1f5f9;
  border-bottom:1px solid var(--line);
}
[data-theme="light"] pre{
  background:#f8fafc;
  color:#1e293b;
  border-color:var(--line);
}
[data-theme="light"] .md-box{
  background:#ffffff;
}

/* Theme Toggle Button */
.btn-theme-toggle{
  display:inline-flex;align-items:center;justify-content:center;
  width:36px;height:36px;border-radius:10px;
  background:var(--panel2);border:1px solid var(--line2);
  color:var(--text2);cursor:pointer;
  transition:background .2s ease,border-color .2s ease,color .2s ease,transform .35s cubic-bezier(.4,0,.2,1);
}
.btn-theme-toggle:hover{
  background:var(--panel3);border-color:var(--acc);color:var(--acc2);
  transform:rotate(18deg) scale(1.06);
}
.btn-theme-toggle:active{transform:rotate(180deg) scale(.96)}
.btn-theme-toggle svg{width:18px;height:18px;display:block}
.theme-icon-sun,.theme-icon-moon{display:inline-flex;align-items:center;justify-content:center}
[data-theme="light"] .theme-icon-sun{display:none}
[data-theme="light"] .theme-icon-moon{display:inline-flex}
:root:not([data-theme="light"]) .theme-icon-sun{display:inline-flex}
:root:not([data-theme="light"]) .theme-icon-moon{display:none}

/* ---------- Material 3 Inspired Tabs & Progress Indicators ---------- */
.m3-tabs-nav{
  display:flex;gap:.5rem;border-bottom:1px solid var(--line);margin-bottom:1.4rem;position:relative;
}
.m3-tab-btn{
  background:none;border:0;color:var(--text2);font:600 .92rem var(--sans);
  padding:.75rem 1.2rem;cursor:pointer;position:relative;display:inline-flex;align-items:center;gap:.5rem;
  transition:all .18s ease;border-radius:var(--r-sm) var(--r-sm) 0 0;
}
.m3-tab-btn:hover{color:var(--text);background:var(--panel2)}
.m3-tab-btn.active{color:var(--acc2);font-weight:700}
.m3-tab-btn.active::after{
  content:'';position:absolute;bottom:-1px;left:0;right:0;height:3px;
  background:var(--acc-grad);border-radius:3px 3px 0 0;
}

.m3-progress-container{
  background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);
  padding:1.25rem 1.4rem;margin-bottom:1.4rem;box-shadow:var(--shadow-sm);
}
.m3-progress-header{
  display:flex;justify-content:space-between;align-items:center;margin-bottom:.7rem;
}
.m3-progress-title{font-size:.9rem;font-weight:700;display:flex;align-items:center;gap:.5rem}
.m3-progress-pct{font-size:.8rem;font-weight:700;color:var(--acc2);font-variant-numeric:tabular-nums}
.m3-progress-track{
  height:7px;background:var(--panel3);border-radius:99px;overflow:hidden;position:relative;margin-bottom:1rem;
}
.m3-progress-fill{
  height:100%;background:var(--acc-grad);border-radius:99px;
  transition:width .35s cubic-bezier(0.4, 0, 0.2, 1);
}

.m3-stepper-grid{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:.6rem;
}
.m3-step-chip{
  background:var(--panel2);border:1px solid var(--line);border-radius:var(--r-md);
  padding:.65rem .85rem;cursor:pointer;display:flex;align-items:center;gap:.65rem;
  transition:all .18s;
}
.m3-step-chip:hover{border-color:var(--acc-line);background:var(--panel3);transform:translateY(-1px)}
.m3-step-chip.active{border-color:var(--acc);background:var(--acc-soft);box-shadow:0 0 0 2px var(--acc-soft)}
.m3-step-chip .m3-step-dot{
  width:24px;height:24px;border-radius:50%;background:var(--panel3);
  display:grid;place-items:center;font-size:.72rem;font-weight:800;color:var(--text2);flex:none;
}
.m3-step-chip.active .m3-step-dot{background:var(--acc);color:#fff}
.m3-step-chip.done .m3-step-dot{background:var(--ok);color:#fff}
.m3-step-chip .m3-step-info{min-width:0;flex:1}
.m3-step-chip .m3-step-title{font-size:.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m3-step-chip .m3-step-desc{font-size:.7rem;color:var(--mut)}

.m3-hero-card{
  background:linear-gradient(135deg,rgba(109,92,255,.08),rgba(79,125,255,.04)),var(--panel);
  border:1px solid var(--line2);border-radius:var(--r-lg);padding:1.4rem 1.6rem;
  display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;margin-bottom:1.4rem;
}
.m3-hero-card h2{margin:0 0 .3rem;font-size:1.18rem;font-weight:800;letter-spacing:-.2px}
.m3-hero-card p{margin:0;color:var(--mut);font-size:.84rem;max-width:55ch}

.wiz-stepper{display:flex;gap:.4rem;align-items:center;padding:.65rem .9rem;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);overflow-x:auto;margin-bottom:1.2rem}
.wiz-step-pill{display:inline-flex;align-items:center;gap:.45rem;padding:.32rem .65rem;border-radius:var(--r-sm);font-size:.78rem;font-weight:600;color:var(--text2);cursor:pointer;white-space:nowrap;transition:all .15s;border:1px solid transparent}
.wiz-step-pill:hover{background:var(--panel2);color:var(--text)}
.wiz-step-pill.active{background:var(--acc-soft);color:#c3baff;border-color:var(--acc-line)}
.wiz-step-pill.done{color:var(--ok)}
.wiz-step-pill .dot{width:7px;height:7px;border-radius:50%;background:var(--line2)}
.wiz-step-pill.active .dot{background:var(--acc);box-shadow:0 0 6px var(--acc)}
.wiz-step-pill.done .dot{background:var(--ok)}

.wiz-pane{display:none}.wiz-pane.active{display:block;animation:fadein .2s ease}
@keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.wiz-foot{display:flex;justify-content:space-between;align-items:center;margin-top:1.6rem;padding-top:1.1rem;border-top:1px solid var(--line);flex-wrap:wrap;gap:.8rem}

/* ---------- Markdown Preview Editor ---------- */
.md-box{border:1px solid var(--line2);border-radius:var(--r-md);overflow:hidden;background:#0a0e18;display:flex;flex-direction:column}
.md-bar{display:flex;align-items:center;justify-content:space-between;padding:.4rem .7rem;background:var(--panel2);border-bottom:1px solid var(--line);flex-wrap:wrap;gap:.5rem}
.md-tabs{display:inline-flex;gap:.25rem}
.md-tab{background:none;border:0;color:var(--text2);font-size:.75rem;font-weight:600;padding:.22rem .55rem;border-radius:4px;cursor:pointer}
.md-tab:hover{color:var(--text);background:var(--panel3)}
.md-tab.active{background:var(--panel);color:var(--acc2);box-shadow:0 1px 4px rgba(0,0,0,.3)}
.md-actions{display:inline-flex;align-items:center;gap:.4rem}
.md-body{display:grid;grid-template-columns:1fr 1fr;min-height:220px}
.md-body.mode-edit{grid-template-columns:1fr}.md-body.mode-edit .md-preview{display:none}
.md-body.mode-preview{grid-template-columns:1fr}.md-body.mode-preview textarea{display:none}
.md-body textarea{border:0;border-radius:0;background:transparent;padding:.75rem;min-height:220px;resize:vertical;font-family:var(--mono);font-size:.83rem;outline:none;border-right:1px solid var(--line)}
.md-body.mode-edit textarea{border-right:0}
.md-preview{padding:.8rem 1.1rem;background:transparent;overflow-y:auto;max-height:420px;font-size:.85rem;line-height:1.6;color:var(--text)}
.md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4{color:var(--text);margin:.7rem 0 .3rem;font-weight:700}
.md-preview h1{font-size:1.2rem}.md-preview h2{font-size:1.05rem}.md-preview h3{font-size:.95rem}
.md-preview p{margin:.4rem 0}
.md-preview ul,.md-preview ol{padding-left:1.4rem;margin:.4rem 0}
.md-preview code{background:var(--panel2);padding:.1em .35em;border-radius:4px;font-family:var(--mono);font-size:.85em}
.md-preview pre{background:var(--bg2);border:1px solid var(--line);border-radius:var(--r-sm);padding:.6rem .8rem;margin:.5rem 0;overflow-x:auto}
.md-preview pre code{background:none;padding:0}
.md-preview blockquote{border-left:3px solid var(--acc);margin:.5rem 0;padding:.3rem .8rem;color:var(--text2);background:var(--acc-soft);border-radius:0 var(--r-sm) var(--r-sm) 0}

/* ---------- MCP multi-select & cards ---------- */
.mcp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:.7rem;margin:.8rem 0}
.mcp-card-select{border:1px solid var(--line2);background:var(--panel2);border-radius:var(--r-sm);padding:.65rem .85rem;display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;transition:all .15s}
.mcp-card-select:hover{border-color:var(--acc-line);background:var(--panel3)}
.mcp-card-select.selected{border-color:var(--acc);background:var(--acc-soft)}
.mcp-card-select input[type=checkbox]{margin-top:.2rem}

/* ---------- MCP searchable multi-select dropdown ---------- */
.mcp-ms{position:relative;max-width:640px}
.mcp-ms-toggle{width:100%;display:flex;align-items:center;gap:.5rem;padding:.55rem .75rem;border:1px solid var(--line2);border-radius:var(--r-sm);background:var(--panel2);cursor:pointer;font:inherit;font-size:.87rem;color:var(--text);transition:all .15s}
.mcp-ms-toggle:hover{border-color:var(--acc-line)}
.mcp-ms.open .mcp-ms-toggle{border-color:var(--acc)}
.mcp-mssummary{flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)}
.mcp-mssummary.has-selection{color:var(--text)}
.mcp-mscaret{flex:none;color:var(--text2);transition:transform .15s;font-size:.7rem}
.mcp-ms.open .mcp-mscaret{transform:rotate(180deg)}
.mcp-ms-menu{display:none;position:absolute;top:calc(100% + .3rem);left:0;right:0;z-index:50;background:var(--panel);border:1px solid var(--line2);border-radius:var(--r-sm);box-shadow:0 8px 30px rgba(0,0,0,.35);overflow:hidden}
.mcp-ms.open .mcp-ms-menu{display:block}
.mcp-ms-search{width:100%;border:0;border-bottom:1px solid var(--line);background:var(--panel2);padding:.55rem .75rem;font:inherit;font-size:.85rem;color:var(--text);outline:none}
.mcp-ms-search::placeholder{color:var(--text2)}
.mcp-ms-list{max-height:280px;overflow-y:auto}
.mcp-ms-item{display:flex;align-items:flex-start;gap:.6rem;padding:.55rem .75rem;cursor:pointer;border-top:1px solid transparent}
.mcp-ms-item:hover{background:var(--panel3)}
.mcp-ms-item.hidden{display:none}
.mcp-ms-item input[type=checkbox]{margin-top:.2rem;flex:none}
.mcp-ms-item .mcp-ms-name{font-size:.85rem;font-weight:600;color:var(--text)}
.mcp-ms-item .mcp-ms-desc{font-size:.76rem;color:var(--text2);margin-top:.1rem}
.mcp-ms-empty{padding:.9rem .75rem;font-size:.8rem;color:var(--text2);text-align:center}
.mcp-ms-actions{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:.4rem .75rem;background:var(--panel2)}
.mcp-ms-clear{font-size:.74rem;color:var(--acc2);background:none;border:0;cursor:pointer;padding:.15rem 0;font:inherit}
.mcp-ms-clear:hover{text-decoration:underline}
.mcp-ms-count{font-size:.74rem;color:var(--text2)}
.mcp-ms-badges{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.55rem}
.mcp-ms-badge{display:inline-flex;align-items:center;gap:.35rem;border:1px solid var(--acc-line);background:var(--acc-soft);color:var(--text);border-radius:999px;padding:.18rem .55rem;font-size:.75rem;font-weight:600}
.mcp-ms-badge button{background:none;border:0;color:var(--text2);cursor:pointer;font:inherit;font-size:.9rem;line-height:1;padding:0}
.mcp-ms-badge button:hover{color:var(--err,#e5484d)}
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
  flow: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="3" r="2"/><circle cx="13" cy="8" r="2"/><circle cx="3" cy="13" r="2"/><path d="M4.6 4.2l6 3M4.6 11.8l6-3" stroke="currentColor" stroke-width="1.4"/></svg>',
  chat: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h12a1 1 0 011 1v8a1 1 0 01-1 1H6l-3.6 3V3a1 1 0 011-1z"/><circle cx="5.5" cy="7" r="1"/><circle cx="8" cy="7" r="1"/><circle cx="10.5" cy="7" r="1"/></svg>',
};

export interface NavItem { href: string; label: string; icon: keyof typeof I; count?: number }
export interface NavGroup { label?: string; items: NavItem[] }

function navHtml(groups: NavGroup[]): string {
  const icon = (k: keyof typeof I) => I[k] ?? '';
  return groups.map((g) => (g.label ? `<div class="sb-label">${esc(g.label)}</div>` : '') + g.items
    .map((it) => `<a href="${esc(it.href)}" data-nav="${esc(it.href)}">${icon(it.icon)}${esc(it.label)}${it.count !== undefined ? `<span class="cnt">${it.count}</span>` : ''}</a>`)
    .join('')).join('');
}

function activeScript(path: string): string {
  return `<script>(function(){var p=${JSON.stringify(path)};document.querySelectorAll('.sb-nav a').forEach(function(a){var h=a.getAttribute('data-nav');if(h===p||p.startsWith(h+'/'))a.classList.add('on');});})();</script>`;
}

export function pageShell(opts: { title: string; crumb: string; path: string; body: string; agents?: number; runs?: number; mcp?: number; chat?: number }): string {
  const nav: NavGroup[] = [
    {
      items: [
        { href: '/', label: 'Dashboard', icon: 'grid' },
        { href: '/ui/agents', label: 'Agents', icon: 'bot', count: opts.agents },
        { href: '/ui/chat', label: 'Chat', icon: 'chat', count: opts.chat },
        { href: '/ui/runs', label: 'Runs', icon: 'play', count: opts.runs },
        { href: '/ui/mcp', label: 'MCP Registry', icon: 'plug', count: opts.mcp },
      ],
    },
    {
      label: 'DEVELOPERS',
      items: [
        { href: '/docs', label: 'API Docs', icon: 'doc' },
      ],
    },
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)} · Minions Cockpit</title>
<script>
  (function(){
    // Light is the product default: only a stored preference overrides it.
    var t = localStorage.getItem('minions_theme') || 'light';
    document.documentElement.setAttribute('data-theme', t);
  })();
  // Theme flip toggle handler — lives in the shared head bootstrap so it is wired
  // on EVERY page (some pages, e.g. /ui/runs, do not embed the TOAST_JS block).
  document.addEventListener('DOMContentLoaded', function(){
    var btn = document.getElementById('themeToggleBtn');
    if (btn && !btn.dataset.init) {
      btn.dataset.init = '1';
      btn.addEventListener('click', function(){
        var current = document.documentElement.getAttribute('data-theme') || 'light';
        var next = current === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('minions_theme', next);
      });
    }
  });
</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>${UI_CSS}</style></head>
<body><div id="toasts"></div>
<div class="shell">
  <aside class="sidebar">
    <div class="sb-brand"><div class="sb-logo">M</div><div class="sb-brand-t">Minions Cockpit</div></div>
    <nav class="sb-nav">${navHtml(nav)}</nav>
    <div class="sb-foot"><span class="sb-dot"></span> API online · loopback</div>
  </aside>
  <div class="main">
    <div class="topbar">
      <div class="crumb">Minions Cockpit${opts.crumb ? ' / <b>' + esc(opts.crumb) + '</b>' : ''}</div>
      <div class="tb-actions">
        <button id="themeToggleBtn" class="btn-theme-toggle" type="button" aria-label="Toggle light/dark mode" title="Toggle light/dark mode">
          <span class="theme-icon-sun" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg></span>
          <span class="theme-icon-moon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></span>
        </button>
      </div>
    </div>
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
    opts=opts||{};
    var timeoutMs=opts.timeoutMs;
    var ctl;
    if(timeoutMs && typeof AbortController!=='undefined'){
      ctl=new AbortController();
      opts.signal=ctl.signal;
      var timer=setTimeout(function(){ctl.abort()},timeoutMs);
    }
    var r;
    try{r=await fetch(path,opts)}
    catch(e){
      if(ctl)clearTimeout(timer);
      if(e && (e.name==='AbortError'||e.name==='TimeoutError'))throw new Error('Request timed out after '+Math.round(timeoutMs/1000)+'s — the provider may be slow. Raise the timeout and retry.');
      throw new Error('network error — is the server running?');
    }
    if(ctl)clearTimeout(timer);
    var j;
    try{j=await r.json()}catch{var txt=await r.text();j={error:txt||('HTTP '+r.status)}}
    if(!r.ok){
      var e=new Error(j.error||('HTTP '+r.status));
      if(j.authHint)e.authHint=j.authHint;
      throw e;
    }
    return j;
  }
  function busyBtn(btn,html){btn.disabled=true;btn.dataset.html=btn.innerHTML;btn.innerHTML='<span class="spin"></span> '+(html||'Working…')}
  function resetBtn(btn){btn.disabled=false;btn.innerHTML=btn.dataset.html}
`;
