import { esc, fmtNum } from './ui-util.js';
import { pageShell, TOAST_JS } from './ui-kit.js';
import type { DbAdapter } from '../store/adapter.js';
import { BUILTIN_TOOLS, BUILTIN_TOOLS_SOURCE } from '../agents/tools-policy.js';
import { fileURLToPath } from 'node:url';

/** Absolute path of the bundled echo MCP server used by the 'Load echo template' button. */
const MCP_ECHO_SERVER_PATH = fileURLToPath(new URL('../../scripts/mcp-echo-server.mjs', import.meta.url));

export function agentsAndWizardPage(db: DbAdapter, initialTab: 'agents' | 'define' = 'agents'): string {
  const registeredMcp = db.listMcpServers();
  const existingDrafts = db.listAgents('draft');
  const registeredAgents = db.listAgents('published');

  const runsByAgent = new Map<string, number>();
  for (const r of db.listRuns() as { agent_id: string }[]) runsByAgent.set(r.agent_id, (runsByAgent.get(r.agent_id) ?? 0) + 1);

  const agentRows = registeredAgents.map((a) => {
    const rc = runsByAgent.get(a.id) ?? 0;
    return `<tr class="rowlink" data-agent-id="${esc(a.id)}" onclick="location.href='/ui/agents/${encodeURIComponent(a.id)}'">
      <td><span style="font-weight:600">${esc(a.name)}</span><div class="mut" style="font-size:.78rem">${esc(a.id)}</div></td>
      <td><span class="pill">v${esc(a.version)}</span></td>
      <td class="mut">${fmtNum(rc)}</td>
      <td class="mut">${esc(a.created_at)}</td>
      <td style="text-align:right;white-space:nowrap">
        <a class="btn sm ghost" href="/api/agents/${encodeURIComponent(a.id)}/definition?download=1" download="${esc(a.name)}-definition.json" onclick="event.stopPropagation()">⇩ Export</a>
        <button class="btn sm ghost" data-act="run" data-id="${esc(a.id)}">Run →</button>
        <button class="btn sm ghost" data-act="edit" data-id="${esc(a.id)}">Edit</button>
        <button class="btn sm ghost danger" data-act="delete" data-id="${esc(a.id)}">Delete</button>
      </td></tr>`;
  }).join('');

  const draftRows = existingDrafts.map((d) => {
    return `<tr data-draft-id="${esc(d.id)}">
      <td><b style="font-size:.88rem">${esc(d.name)}</b><div class="mut" style="font-size:.78rem">${esc(d.id)}</div></td>
      <td><span class="pill">v${esc(d.version)}</span></td>
      <td class="mut">${esc(d.created_at)}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn sm" data-act="resume" data-id="${esc(d.id)}">Resume in Wizard →</button>
        <button class="btn sm ghost danger" data-act="delete" data-id="${esc(d.id)}">Delete</button>
      </td></tr>`;
  }).join('');

  const body = `
  <div class="page-head">
    <div>
      <h1>Agents</h1>
      <div class="sub">Inspect registered custom agents, view execution runs, or assemble a new GitHub Copilot agent with our guided workflow.</div>
    </div>
    <div class="head-actions" id="defineHeaderActions" style="${initialTab === 'define' ? 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap' : 'display:none'}">
      <input type="file" id="fileImporter" accept=".json" style="display:none" />
      <input type="file" id="fileMdImporter" accept=".md,.markdown" style="display:none" />
      <button class="btn ghost sm" id="btnImportJson" type="button">📁 Upload Agent JSON</button>
      <button class="btn ghost sm" id="btnImportMd" type="button">📝 Import .md agent</button>
      <button class="btn ghost sm" id="btnLoadExample" type="button">📋 Load Example Template</button>
      <select id="draftsDropdown" style="width:auto;padding:.35rem .6rem;font-size:.78rem">
        <option value="">📂 Load Saved Draft (${existingDrafts.length})...</option>
        ${existingDrafts.map(d => `<option value="${esc(d.id)}">${esc(d.name)} (v${esc(d.version)})</option>`).join('')}
      </select>
      <button class="btn ghost sm" id="btnSaveDraftGlobal" type="button">💾 Save Draft</button>
      <button class="btn ghost sm" id="btnElaborateSettings" type="button">⚙ Elaborate</button>
    </div>
  </div>
  <div class="card" id="elaborateSettingsPanel" style="display:none;margin:.6rem 0 0;padding:.85rem 1rem">
    <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr">
      <div class="field" style="margin:0">
        <label for="elabMaxTokens">Max output tokens</label>
        <input type="number" id="elabMaxTokens" min="16" max="65536" step="64" value="4096" />
        <span class="hint">Upper bound on generated text. Env default: <code>ELABORATE_MAX_TOKENS</code>.</span>
      </div>
      <div class="field" style="margin:0">
        <label for="elabTimeoutMs">Timeout (ms)</label>
        <input type="number" id="elabTimeoutMs" min="1000" max="900000" step="1000" value="180000" />
        <span class="hint">Client + provider call budget. Env default: <code>ELABORATE_TIMEOUT_MS</code>.</span>
      </div>
      <div class="field" style="margin:0">
        <label for="elabTemperature">Temperature</label>
        <input type="number" id="elabTemperature" min="0" max="2" step="0.1" value="0.7" />
        <span class="hint">Sampling temperature. Env default: <code>ELABORATE_TEMPERATURE</code>.</span>
      </div>
    </div>
  </div>

  <!-- Material 3 Inspired Primary Tab Bar -->
  <div class="m3-tabs-nav">
    <button type="button" class="m3-tab-btn ${initialTab === 'agents' ? 'active' : ''}" id="tabBtnAgents" data-tab="agents">
      🤖 All Agents <span class="pill" style="font-size:.72rem;padding:0 .5rem">${registeredAgents.length}</span>
    </button>
    <button type="button" class="m3-tab-btn ${initialTab === 'define' ? 'active' : ''}" id="tabBtnDefine" data-tab="define">
      ✨ Define Agent <span class="pill tool-pill" style="font-size:.72rem;padding:0 .5rem">Wizard</span>
    </button>
  </div>

  <!-- ============================================================ -->
  <!-- TAB 1: ALL REGISTERED AGENTS                                  -->
  <!-- ============================================================ -->
  <div id="tabContentAgents" style="${initialTab === 'agents' ? 'display:block' : 'display:none'}">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;flex-wrap:wrap;gap:.8rem">
      <input type="text" id="agentFilterInput" placeholder="Filter agents by name, id, or version…" style="max-width:320px" />
      <button class="btn sm" id="btnSwitchToDefine" type="button">+ Define New Agent</button>
    </div>

    <div class="card flush"><div class="tbl-wrap"><table>
      <thead><tr><th>Agent</th><th>Version</th><th>Runs</th><th>Registered</th><th></th></tr></thead>
      <tbody id="registeredAgentsTableBody">${agentRows || '<tr><td colspan="5"><div class="empty"><span class="big">🤖</span>No published agents registered yet.<br><button class="btn sm" id="btnEmptyDefine" type="button" style="margin-top:.6rem">Define your first agent →</button></div></td></tr>'}</tbody>
    </table></div></div>

    ${draftRows ? `
    <h2 class="sec" style="margin-top:2.2rem">Saved Drafts (${existingDrafts.length})</h2>
    <div class="card flush"><div class="tbl-wrap"><table>
      <thead><tr><th>Draft Name</th><th>Version</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>${draftRows}</tbody>
    </table></div></div>
    ` : ''}
  </div>

  <!-- ============================================================ -->
  <!-- TAB 2: DEFINE / WIZARD VIEW                                  -->
  <!-- ============================================================ -->
  <div id="tabContentDefine" style="${initialTab === 'define' ? 'display:block' : 'display:none'}">
    <div id="wizardGlobalAlert" style="margin-bottom:1rem"></div>

    <!-- M3 Progress Indicators & Stepper Overview Component -->
    <div id="viewOverview">
      <div class="m3-hero-card">
        <div>
          <h2>Assemble Custom Agent</h2>
          <p>Follow our guided step-by-step workflow to configure workspace boundaries, LLM provider, persona instructions, tools, MCP integrations, and concurrent Fleet Mode.</p>
        </div>
        <div>
          <button class="btn" id="btnBeginWizard" type="button" style="padding:.65rem 1.4rem;font-size:.92rem">▶ Begin Wizard</button>
        </div>
      </div>

      <!-- Quick create: task-only path — everything else has working defaults -->
      <div class="card" style="margin:1.2rem 0;border-color:var(--acc2,#6c8cff)">
        <h3>⚡ Quick create — just describe your agent</h3>
        <div class="hint" style="margin-bottom:.6rem">One sentence is enough. The agent runs on the <b>default Copilot system prompt</b> (plus AGENTS.md / copilot-instructions.md from its workspace) exactly like a regular GitHub Copilot agent — every other option has a sensible default and stays optional. Fine-tune anything in the full wizard before publishing.</div>
        <div class="field">
          <label>What should your agent do? <span class="req">*</span></label>
          ${renderMdBox('quickTask', 'Build a Spring Boot + Next.js full-stack app with CRUD endpoints and tests.', 'The only required input — becomes the agent task prompt')}
        </div>
        <div class="form-grid">
          <div class="field">
            <label>LLM Provider</label>
            <select id="quickPreset">
              <option value="mimo">MiMo · api.xiaomimimo.com (\${MIMO_API_KEY})</option>
              <option value="openai">OpenAI (\${LLM_API_KEY})</option>
              <option value="anthropic">Anthropic (\${LLM_API_KEY})</option>
              <option value="azure">Azure OpenAI (\${LLM_API_KEY})</option>
              <option value="ollama">Ollama local (\${LLM_API_KEY})</option>
            </select>
            <span class="hint">Credentials are env-var references (\${MIMO_API_KEY} / \${LLM_API_KEY}) — no secrets inside the definition.</span>
          </div>
          <div class="field" style="display:flex;align-items:flex-end;gap:.6rem">
            <button class="btn" id="btnQuickCreate" type="button" style="padding:.65rem 1.4rem">⚡ Create agent</button>
            <span class="hint">Jumps to Review with a complete definition.</span>
          </div>
        </div>
      </div>

      <!-- M3 Linear Progress Indicator -->
      <div class="m3-progress-container">
        <div class="m3-progress-header">
          <span class="m3-progress-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            Configuration Progress
          </span>
          <span class="m3-progress-pct" id="m3ProgressPct">0% Completed</span>
        </div>
        <div class="m3-progress-track">
          <div class="m3-progress-fill" id="m3ProgressFill" style="width: 12.5%"></div>
        </div>

        <!-- M3 Step Segmented Chips / Tabs -->
        <div class="m3-stepper-grid">
          <div class="m3-step-chip" data-step="1">
            <div class="m3-step-dot" id="m3Dot1">1</div>
            <div class="m3-step-info">
              <div class="m3-step-title">Workspace &amp; Provider</div>
              <div class="m3-step-desc" id="m3Desc1">Directory &amp; LLM</div>
            </div>
          </div>
          <div class="m3-step-chip" data-step="2">
            <div class="m3-step-dot" id="m3Dot2">2</div>
            <div class="m3-step-info">
              <div class="m3-step-title">Identity &amp; Persona</div>
              <div class="m3-step-desc" id="m3Desc2">Name &amp; System Prompt</div>
            </div>
          </div>
          <div class="m3-step-chip" data-step="3">
            <div class="m3-step-dot" id="m3Dot3">3</div>
            <div class="m3-step-info">
              <div class="m3-step-title">Instructions</div>
              <div class="m3-step-desc" id="m3Desc3">Repo Guidelines</div>
            </div>
          </div>
          <div class="m3-step-chip" data-step="4">
            <div class="m3-step-dot" id="m3Dot4">4</div>
            <div class="m3-step-info">
              <div class="m3-step-title">Sub-agents</div>
              <div class="m3-step-desc" id="m3Desc4">Specialist Routing</div>
            </div>
          </div>
          <div class="m3-step-chip" data-step="5">
            <div class="m3-step-dot" id="m3Dot5">5</div>
            <div class="m3-step-info">
              <div class="m3-step-title">Task &amp; Tools</div>
              <div class="m3-step-desc" id="m3Desc5">Prompt &amp; Permissions</div>
            </div>
          </div>
          <div class="m3-step-chip" data-step="6">
            <div class="m3-step-dot" id="m3Dot6">6</div>
            <div class="m3-step-info">
              <div class="m3-step-title">MCP Servers</div>
              <div class="m3-step-desc" id="m3Desc6">Tools &amp; Registries</div>
            </div>
          </div>
          <div class="m3-step-chip" data-step="7">
            <div class="m3-step-dot" id="m3Dot7">7</div>
            <div class="m3-step-info">
              <div class="m3-step-title">Fleet Mode</div>
              <div class="m3-step-desc" id="m3Desc7">Concurrent Swarm</div>
            </div>
          </div>
          <div class="m3-step-chip" data-step="8">
            <div class="m3-step-dot" id="m3Dot8">8</div>
            <div class="m3-step-info">
              <div class="m3-step-title">Review &amp; Publish</div>
              <div class="m3-step-desc" id="m3Desc8">JSON &amp; Verification</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Active Wizard Step Panes (Step 1 to 8) -->
    <div id="viewWizard" style="display:none">
      <div class="wiz-stepper">
        <button class="btn ghost sm" id="btnBackToOverview" type="button" style="padding:.25rem .55rem;margin-right:.4rem">⊞ Overview</button>
        <div class="wiz-step-pill active" data-step="1"><span class="dot"></span> 1. Workspace &amp; Provider</div>
        <div class="wiz-step-pill" data-step="2"><span class="dot"></span> 2. Persona</div>
        <div class="wiz-step-pill" data-step="3"><span class="dot"></span> 3. Instructions</div>
        <div class="wiz-step-pill" data-step="4"><span class="dot"></span> 4. Sub-agents</div>
        <div class="wiz-step-pill" data-step="5"><span class="dot"></span> 5. Task &amp; Tools</div>
        <div class="wiz-step-pill" data-step="6"><span class="dot"></span> 6. MCP Servers</div>
        <div class="wiz-step-pill" data-step="7"><span class="dot"></span> 7. Fleet Mode</div>
        <div class="wiz-step-pill" data-step="8"><span class="dot"></span> 8. Review &amp; Publish</div>
      </div>

      <!-- STEP 1: Workspace & Provider -->
      <div class="wiz-pane active" id="paneStep1">
        <div class="card" style="margin-bottom:1rem">
          <h3>1. Agent Workspace</h3>
          <div class="field">
            <label>Working Directory</label>
            <input type="text" id="wsDir" value="./workspace-agent" placeholder="./workspace-agent" />
            <span class="hint">The target folder where this agent operates. Relative paths resolve against the Minion server root or MINION_WORKSPACE.</span>
          </div>
          <div class="alert info" style="margin-top:.4rem">
            <b>ℹ What Workspace means in current agent context:</b>
            <p style="margin-top:.2rem;font-size:.8rem;line-height:1.5">
              The workspace is an isolated root directory for the agent session. The agent inspects code, writes files, and executes builds exclusively inside this directory. Tool calls to edit, grep, and terminal commands are constrained here to protect your system.
            </p>
          </div>
        </div>

        <div class="card">
          <h3>2. LLM Provider Configuration</h3>
          <div class="form-grid">
            <div class="field">
              <label>Pre-configured Provider</label>
              <select id="providerPreset">
                <option value="custom">Select a pre-configured provider...</option>
                <option value="mimo">Xiaomi Mimo (api.xiaomimimo.com)</option>
                <option value="openai">OpenAI (api.openai.com/v1)</option>
                <option value="anthropic">Anthropic (api.anthropic.com/v1)</option>
                <option value="azure">Azure OpenAI</option>
                <option value="ollama">Ollama / Local (localhost:11434/v1)</option>
                <option value="custom">Custom Provider...</option>
              </select>
              <span class="hint">Selecting a preset fills standard base URLs and credential env names.</span>
            </div>
            <div class="field">
              <label>Provider Type</label>
              <select id="providerType">
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="azure">azure</option>
              </select>
            </div>
          </div>

          <div class="form-grid">
            <div class="field">
              <label>Base URL</label>
              <input type="text" id="providerBaseUrl" value="https://api.xiaomimimo.com/v1" placeholder="https://api.openai.com/v1" />
            </div>
            <div class="field">
              <label for="providerApiKey">providerApiKey</label>
              <input type="password" id="providerApiKey" value="" placeholder="paste provider API key" autocomplete="off" spellcheck="false" />
              <span class="hint">Fixed definition attribute <code>provider.providerApiKey</code>. Stored AES-256-GCM encrypted (<code>enc:v1:</code> token) — the raw key never persists in JSON, logs, or the audit trail.</span>
            </div>
          </div>

          <div class="form-grid">
            <div class="field">
              <label>Wire API</label>
              <select id="providerWireApi">
                <option value="completions">completions</option>
                <option value="responses">responses</option>
              </select>
            </div>
            <div class="field">
              <label>Model Deployment</label>
              <div style="display:flex;gap:.5rem">
                <input type="text" id="providerModel" value="mimo-v2.6-flash" placeholder="e.g. mimo-v2.6-flash, gpt-4o, claude-3-5-sonnet-20241022" style="flex:1" />
                <select id="modelSelectDropdown" style="width:160px;display:none">
                  <option value="">Discovered models...</option>
                </select>
              </div>
              <span class="hint">Type the model manually, or click Test Connection to list discovered models.</span>
            </div>
          </div>

          <div style="margin-top:.8rem;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
            <button class="btn" id="btnTestConnection" type="button">🔌 Test Connection</button>
            <span id="testConnectionStatus" class="mut" style="font-size:.8rem">Click to verify connectivity and discover models.</span>
          </div>
        </div>
      </div>

      <!-- STEP 2: Identity & Persona -->
      <div class="wiz-pane" id="paneStep2">
        <div class="card" style="margin-bottom:1rem">
          <h3>1. Agent Identity (Metadata)</h3>
          <div class="form-grid">
            <div class="field">
              <label>Agent Name <span class="mut">(auto)</span></label>
              <input type="text" id="metaName" value="custom-engineer" placeholder="e.g. fe-engineer, test-builder" />
            </div>
            <div class="field">
              <label>Version <span class="mut">(auto)</span></label>
              <input type="text" id="metaVersion" value="1.0.0" placeholder="1.0.0" />
            </div>
          </div>
          <div class="field">
            <label>Tags <span class="mut">(comma-separated)</span></label>
            <input type="text" id="metaTags" value="coding, assistant" placeholder="frontend, testing, refactor" />
          </div>
          <div class="field">
            <label>Agent Description</label>
            ${renderMdBox('metaDesc', 'Senior engineer that ships production-ready code with clear evidence.', 'High-level purpose of this agent')}
          </div>
        </div>

        <div class="card">
          <h3>2. Persona &amp; System Instructions</h3>
          <div class="alert info" style="margin-bottom:.7rem;display:flex;gap:.6rem;align-items:flex-start">
            <input type="checkbox" id="useDefaultPrompt" checked="checked" style="margin-top:.15rem" />
            <div style="flex:1">
              <b style="font-size:.88rem">Include default Copilot system prompt</b>
              <div style="font-size:.8rem;line-height:1.5">Checked (recommended): the SDK-managed Copilot CLI persona (identity, tone, tool instructions, safety guardrails) stays active and your custom instructions are <i>appended</i>. Leave the content box below empty to run on the pure default prompt alone. Unchecked: your system message <b>replaces</b> the Copilot base prompt entirely (drops SDK guardrails — acknowledgement required).</div>
            </div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label>System Message Mode</label>
              <select id="personaMode">
                <option value="append">append (Safest — augments Copilot default instructions)</option>
                <option value="customize">customize (Fine-grained section replacements)</option>
                <option value="replace">replace (Completely replaces Copilot base system prompt)</option>
              </select>
              <span class="hint">The checkbox above drives this: ON → append/customize; OFF → replace. Toggling syncs the mode automatically.</span>
            </div>
            <div class="field" id="replaceRiskContainer" style="display:none">
              <label style="color:var(--err)">Replace Mode Acknowledgment</label>
              <label class="mut" style="font-size:.82rem;display:flex;align-items:center;margin-top:.3rem">
                <input type="checkbox" id="personaAckReplace" /> I acknowledge replace risks (drops Copilot SDK safety guardrails)
              </label>
            </div>
          </div>
          <div class="field">
            <label>System Message Content <span class="mut">(optional)</span></label>
            ${renderMdBox('personaContent', 'You are a senior full-stack engineer. You write clean, tested, accessible code. You check your work thoroughly and cite file paths.', 'Core instructions and persona defining how the agent behaves')}
          </div>
          <div class="field" id="personaCustomizePanel" style="display:none">
            <label>Original Copilot system prompt (default)</label>
            <div class="hint" style="margin-bottom:.5rem">customize mode edits against the SDK-managed default prompt shown here — the exact original Copilot system instructions this machine's Copilot CLI composes. Target its sections in the override table below; the content box above is appended after all sections.</div>
            <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.5rem">
              <button type="button" class="btn" id="btnLoadDefaultPrompt">&#128260; Load default prompt</button>
              <button type="button" class="btn ghost" id="btnPrefillDefaultPrompt">&#10515; Use as content base</button>
              <span class="mut" id="personaDefaultPromptStatus" style="font-size:.72rem">not loaded yet</span>
            </div>
            <pre id="personaDefaultPrompt" style="max-height:280px;overflow:auto;white-space:pre-wrap;font-size:.72rem;line-height:1.45">(click “Load default prompt” to capture the original Copilot system instructions)</pre>
            <label style="margin-top:.8rem">Section overrides</label>
            <div class="hint" style="margin-bottom:.4rem">Action <b>inherit</b> leaves a section untouched; anything else is written to <code class="inline">persona.systemMessage.sections</code>. Not every section is present in every prompt (e.g. last_instructions appears when subagent guidance is configured).</div>
            <div id="personaSectionRows"></div>
          </div>
        </div>
      </div>

      <!-- STEP 3: Guidance & Knowledge -->
      <div class="wiz-pane" id="paneStep3">
        <div class="card" style="margin-bottom:1rem">
          <h3>0. AGENTS.md &amp; repo instruction files <span class="mut">(auto)</span></h3>
          <div class="hint" style="margin-bottom:.6rem">Like regular GitHub Copilot, the agent automatically picks up <code class="inline">AGENTS.md</code>, <code class="inline">CLAUDE.md</code> and <code class="inline">.github/copilot-instructions.md</code> from its working directory — nothing to fill in here. Files at other paths can be listed explicitly below.</div>
          <div id="instructionFilesList" class="mut" style="font-size:.78rem;margin-bottom:.6rem">scan the workspace to see detected files…</div>
          <div class="field">
            <label>Extra instruction files <span class="mut">(comma-separated paths, optional)</span></label>
            <input type="text" id="agentsMdPaths" placeholder="AGENTS.md, ../shared/GUIDELINES.md" />
            <span class="hint">Mapped to <code class="inline">instructions.agentsMdPaths</code> — their content is injected into the system prompt alongside the discovered files.</span>
          </div>
          <div class="field" style="margin-bottom:.2rem">
            <button type="button" class="btn ghost sm" id="btnScanInstructions">🔄 Rescan workspace</button>
          </div>
        </div>

        <div class="card" style="margin-bottom:1rem">
          <h3>1. Global Instructions</h3>
          <div class="field">
            <label>Repository Guidelines &amp; Coding Standards</label>
            ${renderMdBox('instructionsGlobal', '- Prefer minimal diffs.\n- Cite file paths when referencing code.\n- Write unit tests for new logic.\n- Never reveal credentials or secrets.', 'Repo-wide guidance injected into agent turns')}
          </div>
        </div>

        <div class="card" style="margin-bottom:1rem">
          <h3>2. Scoped Instructions</h3>
          <div class="form-grid">
            <div class="field">
              <label>Apply To Pattern</label>
              <input type="text" id="scopedApplyTo" placeholder="**/*.ts or src/api/**" />
            </div>
            <div class="field">
              <label>Body Guidelines</label>
              <input type="text" id="scopedBody" placeholder="e.g. Ensure strict typing and comprehensive error handling." />
            </div>
          </div>
        </div>

        <div class="card">
          <h3>3. Knowledge &amp; Attachments</h3>
          <div class="form-grid">
            <div class="field">
              <label>Additional Directories <span class="mut">(comma-separated)</span></label>
              <input type="text" id="knowledgeDirs" placeholder="./docs, ./packages/core" />
            </div>
            <div class="field">
              <label>Session Store</label>
              <select id="knowledgeSessionStore">
                <option value="false">Disabled (Recommended for clean turn isolation)</option>
                <option value="true">Enabled (Preserve context across sessions)</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <!-- STEP 4: Sub-agents & Skills -->
      <div class="wiz-pane" id="paneStep4">
        <div class="card" style="margin-bottom:1rem">
          <h3>1. Specialist Sub-Agent</h3>
          <div class="form-grid">
            <div class="field">
              <label>Sub-Agent Name</label>
              <input type="text" id="subAgentName" value="code-builder" placeholder="e.g. code-builder, researcher" />
            </div>
            <div class="field">
              <label>Display Name</label>
              <input type="text" id="subAgentDisplayName" value="Code Builder" placeholder="e.g. Code Builder" />
            </div>
          </div>
          <div class="field">
            <label>Tools Permitted <span class="mut">(comma-separated)</span></label>
            <input type="text" id="subAgentTools" value="grep, glob, view, write, edit" placeholder="grep, glob, view, write, edit" />
          </div>
          <div class="field">
            <label>Sub-Agent Prompt</label>
            ${renderMdBox('subAgentPrompt', 'You are a hands-on implementation specialist. Read the task, inspect the workspace, and implement the necessary changes cleanly.', 'Specialist role and operational boundaries')}
          </div>
        </div>

        <div class="card">
          <h3>2. Skills</h3>
          <div class="form-grid">
            <div class="field">
              <label>Skill Directories <span class="mut">(comma-separated)</span></label>
              <input type="text" id="skillsDirs" value="./skills" placeholder="./skills, ./agent-skills" />
            </div>
            <div class="field">
              <label>Default Agent Route</label>
              <input type="text" id="defaultAgent" value="code-builder" placeholder="code-builder" />
            </div>
          </div>
        </div>
      </div>

      <!-- STEP 5: Task & Tools -->
      <div class="wiz-pane" id="paneStep5">
        <div class="card" style="margin-bottom:1rem">
          <h3>1. Task Prompt</h3>
          <div class="form-grid">
            <div class="field">
              <label>Delivery Mode</label>
              <select id="taskDeliveryMode">
                <option value="enqueue">enqueue (Queued turn execution)</option>
                <option value="immediate">immediate (Synchronous turn)</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>Task Prompt <span class="req">*</span></label>
            ${renderMdBox('taskPrompt', 'Build a clean, responsive single-file landing page in index.html with header, feature cards, and contact form.', 'The primary goal or user prompt executed when running this agent')}
          </div>
        </div>

        <div class="card">
          <h3>2. Copilot CLI Tools — Availability &amp; Decisions</h3>
          <div class="alert info" style="display:flex;gap:.6rem;align-items:flex-start;margin-bottom:.8rem">
            <input type="checkbox" id="builtinAllCheck" checked="checked" style="margin-top:.15rem" />
            <div style="flex:1">
              <b style="font-size:.88rem">All default Copilot CLI tools available</b>
              <div style="font-size:.8rem;line-height:1.5">The full built-in CLI toolset (shell, file tools, search, session tools) is in front of the model — exactly like the default Copilot agent. Uncheck to hand-pick individual tools below. MCP and custom tools keep their own sources and inherit the default decision.</div>
            </div>
          </div>
          <div class="form-grid" style="margin-bottom:.8rem">
            <div class="field">
              <label>Default decision for unlisted tools</label>
              <select id="builtinsDefault">
                <option value="allow">allow (execute freely)</option>
                <option value="ask">confirm before use — headless runs deny with an audit event</option>
                <option value="deny">deny (never execute)</option>
              </select>
              <span class="hint">Posture fallback for any tool without a per-tool decision below. Covers built-in, MCP and custom tools.</span>
            </div>
            <div class="field">
              <label>Destructive update/delete operations</label>
              <select id="allowDestructive">
                <option value="false">Blocked (Recommended — destructive commands and MCP update/delete calls are denied)</option>
                <option value="true">Allowed (critical modifications / delete operations execute)</option>
              </select>
              <span class="hint">Heuristic gate: recursive rm, forced pushes, SQL DROP, kubectl delete, destructive-named MCP tools…</span>
            </div>
          </div>
          <div id="builtinToolGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.5rem">
            ${BUILTIN_TOOLS.map((t) => `
            <div class="mcp-card-select" data-builtin-row="${esc(t.name)}">
              <div style="display:flex;gap:.5rem;align-items:center;flex:1;min-width:0">
                <input type="checkbox" class="builtin-tool-check" value="${esc(t.name)}" checked="checked" />
                <div style="min-width:0">
                  <b style="font-size:.82rem">${esc(t.name)}</b>
                  <div class="mut" style="font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.description)}</div>
                </div>
              </div>
              <select class="builtin-tool-decision" data-tool="${esc(t.name)}" style="width:auto;padding:.2rem .35rem;font-size:.72rem">
                <option value="allow">allow</option>
                <option value="ask">ask</option>
                <option value="deny">deny</option>
              </select>
            </div>`).join('')}
          </div>
          <div style="margin-top:.7rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
            <input type="text" id="builtinFreeform" placeholder="extra tool name (e.g. mcp:server-tool …)" style="max-width:280px" />
            <button class="btn ghost sm" id="btnAddFreeformTool" type="button">+ Add</button>
            <span class="mut" style="font-size:.75rem">Unlisted tool names work as freeform entries; source-qualified forms (mcp:x, custom:x, builtin:x) are matched too.</span>
          </div>
          <details style="margin-top:1rem">
            <summary class="mut" style="cursor:pointer;font-size:.8rem">Advanced: legacy permission policy &amp; patterns</summary>
            <div class="form-grid" style="margin-top:.6rem">
              <div class="field">
                <label>Permission Policy</label>
                <select id="toolsPolicy">
                  <option value="deny-all">deny-all (Strict sandbox — only patterned tools allowed)</option>
                  <option value="pattern-list">pattern-list (Match patterns, fallback to allow)</option>
                  <option value="approve-all-ci-only">approve-all-ci-only (Auto-approve with --yes)</option>
                </select>
                <span class="hint">Explicit patterns below take precedence over everything above. 'ask' patterns are denied+audited in headless runs.</span>
              </div>
              <div class="field">
                <label>Allowed Tool Patterns <span class="mut">(comma-separated)</span></label>
                <input type="text" id="toolsAllowedPatterns" value="grep, glob, view, write, edit" placeholder="grep, glob, view, write, edit" />
                <span class="hint">Legacy allow patterns (written as tools.patterns).</span>
              </div>
            </div>
          </details>
        </div>
      </div>

      <!-- STEP 6: MCP Servers -->
      <div class="wiz-pane" id="paneStep6">
        <div class="card" style="margin-bottom:1rem">
          <h3>1. Select Registered MCP Servers</h3>
          <div class="mut" style="font-size:.82rem;margin-bottom:.6rem">
            Choose from Model Context Protocol servers currently available in your global MCP Registry (<a href="/ui/mcp" target="_blank">/ui/mcp ↗</a>).
          </div>
          <div id="mcpRegistrySelector" class="mcp-ms">
            <button type="button" id="mcpMsToggle" class="mcp-ms-toggle" aria-haspopup="listbox" aria-expanded="false">
              <span id="mcpMsSummary" class="mcp-mssummary">${registeredMcp.length ? registeredMcp.length : 'No'} server${registeredMcp.length === 1 ? '' : 's'} registered — select one or more</span>
              <span class="mcp-mscaret">▼</span>
            </button>
            <div id="mcpMsMenu" class="mcp-ms-menu">
              <input type="text" id="mcpMsSearch" class="mcp-ms-search" placeholder="Search servers by name or description…" autocomplete="off" />
              <div id="mcpMsList" class="mcp-ms-list" role="listbox" aria-multiselectable="true">
                ${registeredMcp.length ? registeredMcp.map(s => `
                <label class="mcp-ms-item" data-mcp-name="${esc(s.name)}" data-search="${esc((s.name + ' ' + (s.description || '')).toLowerCase())}">
                  <input type="checkbox" class="mcp-reg-check" value="${esc(s.name)}" />
                  <div style="min-width:0">
                    <div class="mcp-ms-name">${esc(s.name)}</div>
                    <div class="mcp-ms-desc">${esc(s.description || 'No description')}</div>
                  </div>
                </label>
                `).join('') : '<div class="mcp-ms-empty">No MCP servers registered yet. Register one below!</div>'}
              </div>
              <div class="mcp-ms-actions">
                <span id="mcpMsCount" class="mcp-ms-count">${registeredMcp.length} server${registeredMcp.length === 1 ? '' : 's'} available</span>
                <button type="button" id="mcpMsClear" class="mcp-ms-clear">Clear selection</button>
              </div>
            </div>
          </div>
          <div id="mcpMsBadges" class="mcp-ms-badges" style="display:none"></div>
        </div>

        <div class="card">
          <h3>2. Register New MCP Server (Live Test &amp; Save)</h3>
          <div class="mut" style="font-size:.82rem;margin-bottom:.7rem">
            Connect STDIO (command-based) or Hosted (HTTP/SSE) servers. Tested servers are registered in the global registry and attached to this agent.
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Server Name <span class="req">*</span></label>
              <input type="text" id="newMcpName" placeholder="e.g. file-service or github-mcp" />
            </div>
            <div class="field">
              <label>Description</label>
              <input type="text" id="newMcpDesc" placeholder="Brief description of this server" />
            </div>
          </div>
          <div class="field">
            <label>Config JSON <span class="req">*</span></label>
            <textarea id="newMcpConfig" class="sm" spellcheck="false" placeholder='{"type":"local","command":"node","args":["-e","console.log(&apos;ok&apos;)"],"tools":["*"]}'></textarea>
          </div>
          <div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
            <button class="btn" id="btnTestRegisterMcp" type="button">🔌 Test &amp; Register MCP</button>
            <button class="btn ghost sm" id="btnLoadEchoMcp" type="button">Load Echo Template</button>
            <span id="mcpTestMsg" class="mut" style="font-size:.8rem"></span>
          </div>
          <div id="mcpDiscoveredToolsBox" style="margin-top:.8rem;display:none">
            <div class="alert ok">
              <b>✓ Discovered Tools:</b>
              <div id="mcpDiscoveredToolsList" style="margin-top:.3rem;display:flex;gap:.4rem;flex-wrap:wrap"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- STEP 7: Fleet Mode (Concurrent Agents) -->
      <div class="wiz-pane" id="paneStep7">
        <div class="card" style="margin-bottom:1rem">
          <h3>1. Fleet Mode Orchestration</h3>
          <div class="alert info" style="margin-bottom:1rem">
            <b>🚀 GitHub Copilot SDK Fleet Mode:</b>
            <p style="margin-top:.2rem;font-size:.8rem;line-height:1.5">
              Fleet mode splits complex, multi-file objectives across independent sub-agents running concurrently. An orchestrator decomposes the high-level prompt, coordinates dependencies, and parallelizes execution. Dispatched programmatically via Copilot SDK <code class="inline">session.rpc.fleet.start</code>.
            </p>
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Enable Fleet Mode</label>
              <select id="fleetEnabled">
                <option value="false">Disabled (Single agent execution via sendAndWait)</option>
                <option value="true">Enabled (Parallel fleet mode swarm)</option>
              </select>
            </div>
            <div class="field">
              <label>Max Concurrent Sub-agents</label>
              <input type="number" id="fleetMaxWorkers" value="5" min="1" max="20" />
              <span class="hint">Recommended: 3–8 concurrent workers for optimal context usage.</span>
            </div>
          </div>
          <div class="field">
            <label>Fleet Decomposition Prompt</label>
            ${renderMdBox('fleetPrompt', 'Refactor and test the application across independent tracks:\n1. Update data models in src/models\n2. Implement API routes in src/routes (depends on 1)\n3. Write unit tests in tests/ (runs in parallel with 2)', 'Instructions for orchestrator to decompose and dispatch parallel work tracks')}
          </div>
        </div>
      </div>

      <!-- STEP 8: Runtime & Review / Publish -->
      <div class="wiz-pane" id="paneStep8">
        <div class="card" style="margin-bottom:1rem">
          <h3>1. Runtime Options</h3>
          <div class="form-grid">
            <div class="field">
              <label>Streaming</label>
              <select id="rtStreaming">
                <option value="true">Enabled (Stream message deltas)</option>
                <option value="false">Disabled</option>
              </select>
            </div>
            <div class="field">
              <label>Idle Timeout (Seconds)</label>
              <input type="number" id="rtIdleTimeout" value="1800" />
            </div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Max AI Credits</label>
              <input type="number" id="rtMaxCredits" value="100" />
            </div>
            <div class="field">
              <label>Log Level</label>
              <select id="rtLogLevel">
                <option value="info">info</option>
                <option value="warning">warning</option>
                <option value="error">error</option>
                <option value="debug">debug</option>
              </select>
            </div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Turn Timeout (ms)</label>
              <input type="number" id="rtTurnTimeout" min="1000" max="21600000" step="1000" value="2700000" />
              <span class="hint">Budget for one agent turn. Default 2700000 (45 min) — multi-file builds need the headroom. Also overridable per-run via <code>turnTimeoutMs</code> or the <code>RUN_TURN_TIMEOUT_MS</code> env.</span>
            </div>
            <div class="field">
              <label>Coding Harness</label>
              <select id="rtHarness">
                <option value="true">Enabled (bash, mkdir, write + auto parent dirs)</option>
                <option value="false">Disabled (locked-down agent)</option>
              </select>
              <span class="hint">Injected shell/scaffold tools so nested <code>create</code> paths work like a regular coding agent.</span>
            </div>
          </div>

          <h3 style="margin-top:1rem">1b. Advanced SDK Runtime Keys</h3>
          <div class="form-grid" style="margin-top:.4rem">
            <div class="field">
              <label>Autopilot</label>
              <select id="rtAutopilot">
                <option value="">Runtime default</option>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
              <span class="hint">Session autopilot mode (experimental in the SDK runtime).</span>
            </div>
            <div class="field">
              <label>Tool Search</label>
              <select id="rtToolSearch">
                <option value="false">Disabled (Recommended — all matching tools preloaded for the model)</option>
                <option value="true">Enabled (tools deferred behind tool_search_tool)</option>
              </select>
              <span class="hint">Overriding the runtime's built-in tool-search; default keeps coding tools visible like a normal coding agent.</span>
            </div>
          </div>
          <div class="form-grid" style="margin-top:.3rem">
            <div class="field">
              <label>Built-in Skills to Include <span class="mut">(comma-separated)</span></label>
              <input type="text" id="rtIncludedBuiltinSkills" placeholder="e.g. memory, web-search" />
              <span class="hint">Runtime-bundled skills to opt back in (name list — runtime decides what exists).</span>
            </div>
            <div class="field">
              <label>Excluded Built-in Agents <span class="mut">(comma-separated)</span></label>
              <input type="text" id="rtExcludedBuiltinAgents" placeholder="e.g. brainstormer" />
              <span class="hint">Hide specific built-in runtime agents from sub-agent discovery.</span>
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:1rem">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
            <h3>2. Validation Health &amp; Schema Checks</h3>
            <button class="btn ghost sm" id="btnRunValidation" type="button">↻ Re-verify</button>
          </div>
          <div id="validationResultBox">
            <div class="alert info"><b>ℹ</b> Ready to validate assembled agent definition.</div>
          </div>
        </div>

        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
            <h3>3. Complete Agent Definition JSON</h3>
            <div style="display:flex;gap:.4rem">
              <button class="btn ghost sm" id="btnCopyJson" type="button">📋 Copy JSON</button>
              <button class="btn ghost sm" id="btnDownloadJson" type="button">💾 Download File</button>
            </div>
          </div>
          <textarea id="finalJsonViewer" spellcheck="false" style="min-height:360px;font-size:.82rem"></textarea>
        </div>
      </div>

      <!-- Wizard Navigation Footer -->
      <div class="wiz-foot">
        <div>
          <button class="btn ghost" id="btnNavBack" type="button">← Back</button>
        </div>
        <div style="display:flex;gap:.6rem;align-items:center">
          <button class="btn ghost" id="btnNavSaveDraft" type="button">💾 Save Draft</button>
          <button class="btn" id="btnNavNext" type="button">Next →</button>
          <button class="btn" id="btnNavPublish" type="button" style="display:none;background:var(--ok)">🚀 Publish Agent</button>
        </div>
      </div>
    </div>
  </div>

  <script>${TOAST_JS}
  ${WIZARD_CLIENT_JS}
  </script>
  `;

  return pageShell({
    title: 'Agents', crumb: 'Agents', path: '/ui/agents', body,
    agents: registeredAgents.length,
    runs: db.listRuns().length,
    mcp: db.listMcpServers().length,
  });
}

function renderMdBox(id: string, defaultText: string, placeholder: string): string {
  return `
  <div class="md-box" id="box_${id}">
    <div class="md-bar">
      <div class="md-tabs">
        <button type="button" class="md-tab active" data-tab="split" data-box="${id}">Split</button>
        <button type="button" class="md-tab" data-tab="edit" data-box="${id}">Edit</button>
        <button type="button" class="md-tab" data-tab="preview" data-box="${id}">Preview</button>
      </div>
      <div class="md-actions">
        <input type="file" id="file_${id}" accept=".md,.txt,.markdown" style="display:none" />
        <button type="button" class="btn ghost sm btn-md-upload" data-box="${id}">📎 Upload File</button>
        <button type="button" class="btn ghost sm btn-md-elaborate" data-box="${id}">✨ Elaborate</button>
      </div>
    </div>
    <div class="md-body" id="body_${id}">
      <textarea id="${id}" spellcheck="false" placeholder="${esc(placeholder)}">${esc(defaultText)}</textarea>
      <div class="md-preview" id="prev_${id}"></div>
    </div>
  </div>`;
}

const WIZARD_CLIENT_JS = `
(function(){
  const $=id=>document.getElementById(id);
  let currentStep=1;
  const TOTAL_STEPS=8;

  // --- Quick create (task-only path): assemble a complete definition from defaults ---
  function slugFromTask(t){
    const words = t.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\\s+/).filter(Boolean);
    const skip = new Set(['a','an','the','and','or','with','for','to','of','in','on','that','this','please','build','create','make','using','use','based','app','application','you','are','my','its','it']);
    const picked = words.filter(function(w){ return !skip.has(w); }).slice(0,3);
    return (picked.join('-') || 'my-agent').slice(0,32);
  }
  $('btnQuickCreate').onclick = function(){
    const task = $('quickTask').value.trim();
    if(!task){ toast('warn','Task required','Describe what your agent should do — one sentence is enough'); return; }
    const presetKey = $('quickPreset').value;
    const p = PRESETS[presetKey];
    if(p){
      $('providerPreset').value = presetKey;
      $('providerType').value = p.type;
      $('providerBaseUrl').value = p.url;
      $('providerModel').value = p.model;
    }
    $('providerApiKey').value = presetKey==='mimo' ? '$'+'{MIMO_API_KEY}' : '$'+'{LLM_API_KEY}';
    $('taskPrompt').value = task;
    if(!$('metaName').value.trim() || $('metaName').value.trim()==='custom-engineer') $('metaName').value = slugFromTask(task);
    if(!$('metaVersion').value.trim()) $('metaVersion').value = '1.0.0';
    toast('info','Agent assembled','Review the generated definition — Publish to register it');
    goToStep(TOTAL_STEPS);
  };

  // --- Main Tabs (All Agents vs Define Agent) ---
  function switchMainTab(tab){
    const isDefine = tab === 'define';
    $('tabBtnAgents').classList.toggle('active', !isDefine);
    $('tabBtnDefine').classList.toggle('active', isDefine);
    $('tabContentAgents').style.display = isDefine ? 'none' : 'block';
    $('tabContentDefine').style.display = isDefine ? 'block' : 'none';
    $('defineHeaderActions').style.display = isDefine ? 'flex' : 'none';
    if (isDefine) {
      updateM3Progress();
    }
    try {
      history.replaceState(null, '', isDefine ? '/ui/agents?tab=define' : '/ui/agents');
    } catch(e){}
  }

  $('tabBtnAgents').onclick = () => switchMainTab('agents');
  $('tabBtnDefine').onclick = () => switchMainTab('define');
  if ($('btnSwitchToDefine')) {
    $('btnSwitchToDefine').onclick = () => switchMainTab('define');
  }
  if ($('btnEmptyDefine')) {
    $('btnEmptyDefine').onclick = () => switchMainTab('define');
  }

  // Filter in registered agents list
  if ($('agentFilterInput')) {
    $('agentFilterInput').addEventListener('input', function(){
      const q = this.value.toLowerCase().trim();
      document.querySelectorAll('#registeredAgentsTableBody tr.rowlink').forEach(tr => {
        tr.style.display = tr.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
      });
    });
  }

  // --- Agent list actions: Run / Edit / Delete (published) and Resume / Delete (drafts) ---
  async function deleteAgentById(id, label){
    if(!window.confirm('Delete '+label+'?\\n\\n'+id+'\\n\\nThis removes the definition. Historical runs stay in the audit trail.')) return;
    try {
      const res = await fetch('/api/agents/'+encodeURIComponent(id)+'?force=false', { method:'DELETE' });
      const j = await res.json().catch(()=>({}));
      if(res.status===409){
        const bits=[];
        if(j.activeRuns) bits.push(j.activeRuns+' active run'+(j.activeRuns===1?'':'s'));
        if(j.activeSessions) bits.push(j.activeSessions+' active session'+(j.activeSessions===1?'':'s'));
        toast('warn','Delete Blocked', j.error || ('Cannot delete — '+bits.join(' and ')+' still running.'));
        return;
      }
      if(!res.ok) throw new Error(j.error||('HTTP '+res.status));
      toast('ok','Deleted', id+' removed');
      setTimeout(()=>location.reload(), 600);
    } catch(e){
      toast('err','Delete Failed', e.message);
    }
  }
  document.addEventListener('click', function(e){
    const btn = e.target.closest('button[data-act]');
    if(!btn) return;
    e.stopPropagation();
    e.preventDefault();
    const act = btn.getAttribute('data-act');
    const id = btn.getAttribute('data-id');
    if(act==='run'){ location.href='/ui/agents/'+encodeURIComponent(id); return; }
    if(act==='edit' || act==='resume'){
      if(typeof window.loadDraftById==='function') window.loadDraftById(id);
      else location.href='/ui/agents?tab=define';
      return;
    }
    if(act==='delete'){
      const isDraft = !!btn.closest('tr[data-draft-id]');
      deleteAgentById(id, isDraft ? 'draft' : 'agent');
    }
  }, true);

  // --- Presets ---
  const PRESETS = {
    mimo: { type:'openai', url:'https://api.xiaomimimo.com/v1', model:'mimo-v2.6-flash' },
    openai: { type:'openai', url:'https://api.openai.com/v1', model:'gpt-4o' },
    anthropic: { type:'anthropic', url:'https://api.anthropic.com/v1', model:'claude-3-5-sonnet-20241022' },
    azure: { type:'azure', url:'https://your-resource.openai.azure.com/openai', model:'gpt-4o' },
    ollama: { type:'openai', url:'http://localhost:11434/v1', model:'llama3' },
  };

  $('providerPreset').addEventListener('change',function(){
    const p = PRESETS[this.value];
    if(p){
      $('providerType').value=p.type;
      $('providerBaseUrl').value=p.url;
      $('providerModel').value=p.model;
      toast('info','Preset Applied',this.value+' configuration filled — paste your providerApiKey to store it encrypted');
    }
  });

  // --- Navigation & View Switching ---
  function showOverview(){
    $('viewOverview').style.display='block';
    $('viewWizard').style.display='none';
    updateM3Progress();
  }

  function goToStep(n){
    if(n<1) n=1; if(n>TOTAL_STEPS) n=TOTAL_STEPS;
    currentStep=n;
    $('viewOverview').style.display='none';
    $('viewWizard').style.display='block';

    document.querySelectorAll('.wiz-pane').forEach((el,idx)=>{
      el.classList.toggle('active', (idx+1)===n);
    });
    document.querySelectorAll('.wiz-step-pill').forEach((el)=>{
      const s=parseInt(el.getAttribute('data-step'),10);
      el.classList.toggle('active', s===n);
      el.classList.toggle('done', s<n);
    });

    $('btnNavBack').style.display = n===1 ? 'none' : 'inline-flex';
    $('btnNavNext').style.display = n===TOTAL_STEPS ? 'none' : 'inline-flex';
    $('btnNavPublish').style.display = n===TOTAL_STEPS ? 'inline-flex' : 'none';

    if(n===TOTAL_STEPS){
      syncFinalJson();
      validateAssembledJson();
    }
    updateAllMarkdownPreviews();
    window.scrollTo({top:0,behavior:'smooth'});
  }

  $('btnBeginWizard').onclick = ()=>goToStep(1);
  $('btnBackToOverview').onclick = ()=>showOverview();
  $('btnNavNext').onclick = ()=>goToStep(currentStep+1);
  $('btnNavBack').onclick = ()=>goToStep(currentStep-1);

  document.querySelectorAll('.m3-step-chip').forEach(c=>{
    c.onclick = ()=>goToStep(parseInt(c.getAttribute('data-step'),10));
  });
  document.querySelectorAll('.wiz-step-pill').forEach(p=>{
    p.onclick = ()=>goToStep(parseInt(p.getAttribute('data-step'),10));
  });

  // Persona ↔ default-prompt checkbox sync: replace ⇔ unchecked; append/customize ⇔ checked.
  function syncPersonaUi(){
    const on = $('useDefaultPrompt').checked;
    $('replaceRiskContainer').style.display = on ? 'none' : 'block';
    if(on){
      if($('personaMode').value==='replace'){
        $('personaMode').value='append';
        toast('info','Mode synced','Default prompt is ON — replace would drop it, switched to append');
      }
    } else {
      if($('personaMode').value!=='replace') $('personaMode').value='replace';
    }
    togglePersonaCustomize();
    updateM3Progress();
  }
  $('useDefaultPrompt').addEventListener('change', syncPersonaUi);
  $('personaMode').addEventListener('change',function(){
    $('useDefaultPrompt').checked = this.value!=='replace';
    $('replaceRiskContainer').style.display = this.value==='replace'?'block':'none';
    togglePersonaCustomize();
  });

  // --- customize mode: show the original/default Copilot system prompt + section overrides ---
  const PERSONA_SECTION_ACTIONS = ['preserve','append','prepend','replace','remove'];
  function togglePersonaCustomize(){
    const show = $('personaMode').value==='customize' && $('useDefaultPrompt').checked;
    $('personaCustomizePanel').style.display = show ? 'block' : 'none';
    if(show){
      loadPersonaCatalog().then(function(sections){
        if(!$('personaSectionRows').children.length) renderPersonaSectionRows(sections);
      });
    }
  }
  function loadPersonaCatalog(){
    if(window.__personaSections) return Promise.resolve(window.__personaSections);
    return fetch('/api/persona/default-system-prompt?capture=0').then(function(r){ return r.json(); }).then(function(j){
      window.__personaSections = j.sections || {};
      return window.__personaSections;
    }).catch(function(){ return {}; });
  }
  function renderPersonaSectionRows(sections, existing){
    const box = $('personaSectionRows');
    box.innerHTML = Object.keys(sections).map(function(id){
      const desc = (sections[id] && sections[id].description) || '';
      return '<div class="psec-row" data-sec="'+id+'" style="display:grid;grid-template-columns:180px 120px 1fr;gap:.5rem;align-items:start;margin-bottom:.4rem">' +
        '<div><b style="font-size:.78rem">'+id+'</b><div class="mut" style="font-size:.68rem;line-height:1.35">'+escHtml(desc)+'</div></div>' +
        '<select class="psec-action" style="font-size:.75rem"><option value="">inherit</option>'+PERSONA_SECTION_ACTIONS.map(function(a){ return '<option value="'+a+'">'+a+'</option>'; }).join('')+'</select>' +
        '<input class="psec-content" style="font-size:.75rem" placeholder="content (for append / prepend / replace)" />' +
      '</div>';
    }).join('');
    if(existing){
      Object.keys(existing).forEach(function(id){
        const row = box.querySelector('[data-sec="'+id+'"]');
        if(!row) return;
        row.querySelector('.psec-action').value = (existing[id] && existing[id].action) || '';
        row.querySelector('.psec-content').value = (existing[id] && existing[id].content) || '';
      });
    }
  }
  function collectPersonaSections(){
    const out = {};
    document.querySelectorAll('#personaSectionRows .psec-row').forEach(function(row){
      const action = row.querySelector('.psec-action').value;
      if(!action) return;
      const content = row.querySelector('.psec-content').value.trim();
      out[row.getAttribute('data-sec')] = content ? { action: action, content: content } : { action: action };
    });
    return Object.keys(out).length ? out : undefined;
  }
  $('btnLoadDefaultPrompt').onclick = async function(){
    const status = $('personaDefaultPromptStatus');
    status.textContent = 'capturing the live default prompt from the bundled Copilot CLI… (first capture spawns the runtime — up to ~30s)';
    this.disabled = true;
    try {
      const r = await fetch('/api/persona/default-system-prompt');
      const j = await r.json();
      if(j.capture && j.capture.ok){
        window.__personaDefaultPromptText = j.capture.text;
        $('personaDefaultPrompt').textContent = j.capture.text;
        status.textContent = 'captured ' + j.capture.chars + ' chars · ' + (j.capture.capturedAt || '') + ' · live CLI capture';
      } else {
        window.__personaDefaultPromptText = '';
        $('personaDefaultPrompt').textContent = '(live capture unavailable: ' + ((j.capture && j.capture.error) || 'unknown error') + ') \u2014 the section table below still lists every targetable section.';
        status.textContent = 'capture failed';
      }
      if(!$('personaSectionRows').children.length && j.sections) renderPersonaSectionRows(j.sections);
    } catch(e){
      status.textContent = 'failed: ' + (e && e.message ? e.message : e);
    }
    this.disabled = false;
  };
  $('btnPrefillDefaultPrompt').onclick = function(){
    const t = window.__personaDefaultPromptText || '';
    if(!t){ toast('warn','Load the default prompt first','Click \u201cLoad default prompt\u201d to capture it'); return; }
    $('personaContent').value = t;
    updatePreview('personaContent');
    toast('info','Content filled from the default prompt','It is now your editing base \u2014 trim it down to what you want to change');
  };

  // --- Markdown Editors (Split / Edit / Preview / Upload / Elaborate) ---
  function renderMd(text){
    if(!text) return '<span class="mut" style="font-size:.78rem">(empty)</span>';
    if(window.marked && typeof window.marked.parse === 'function'){
      try { return window.marked.parse(text); } catch(e){}
    }
    return '<pre style="white-space:pre-wrap;background:none;border:0;padding:0">'+escHtml(text)+'</pre>';
  }

  function updatePreview(id){
    const textarea = $(id);
    const prev = $('prev_'+id);
    if(textarea && prev){
      prev.innerHTML = renderMd(textarea.value);
    }
  }

  function updateAllMarkdownPreviews(){
    ['quickTask','metaDesc','personaContent','instructionsGlobal','subAgentPrompt','taskPrompt','fleetPrompt'].forEach(updatePreview);
  }

  document.querySelectorAll('.md-box textarea').forEach(ta=>{
    ta.addEventListener('input',()=>updatePreview(ta.id));
  });

  document.querySelectorAll('.md-tab').forEach(tab=>{
    tab.onclick=function(){
      const boxId=this.getAttribute('data-box');
      const mode=this.getAttribute('data-tab');
      const body=$('body_'+boxId);
      this.parentElement.querySelectorAll('.md-tab').forEach(t=>t.classList.remove('active'));
      this.classList.add('active');
      body.className='md-body mode-'+mode;
    };
  });

  // File Upload to Markdown Area
  document.querySelectorAll('.btn-md-upload').forEach(btn=>{
    btn.onclick=function(){
      const boxId=this.getAttribute('data-box');
      const fileInput=$('file_'+boxId);
      fileInput.value='';
      fileInput.onchange=function(){
        const file=this.files[0];
        if(!file)return;
        const reader=new FileReader();
        reader.onload=e=>{
          $(boxId).value=e.target.result;
          updatePreview(boxId);
          toast('ok','File Rendered',file.name+' loaded into markdown editor');
        };
        reader.readAsText(file);
      };
      fileInput.click();
    };
  });

  // --- Elaborate generation settings (maxTokens / timeoutMs / temperature) ---
  const ELAB_DEFAULTS = { maxTokens: 4096, timeoutMs: 180000, temperature: 0.7 };
  function readElabSettings(){
    const n = (id, dflt) => { const v = parseInt(($(id)||{}).value, 10); return Number.isFinite(v) ? v : dflt; };
    const f = (id, dflt) => { const v = parseFloat(($(id)||{}).value); return Number.isFinite(v) ? v : dflt; };
    return {
      maxTokens: Math.min(65536, Math.max(16, n('elabMaxTokens', ELAB_DEFAULTS.maxTokens))),
      timeoutMs: Math.min(900000, Math.max(1000, n('elabTimeoutMs', ELAB_DEFAULTS.timeoutMs))),
      temperature: Math.min(2, Math.max(0, f('elabTemperature', ELAB_DEFAULTS.temperature)))
    };
  }
  function persistElabSettings(){
    try { localStorage.setItem('minions.elaborate', JSON.stringify(readElabSettings())); } catch {}
  }
  try {
    const saved = JSON.parse(localStorage.getItem('minions.elaborate') || 'null');
    if (saved) {
      if (saved.maxTokens) $('elabMaxTokens').value = saved.maxTokens;
      if (saved.timeoutMs) $('elabTimeoutMs').value = saved.timeoutMs;
      if (saved.temperature != null) $('elabTemperature').value = saved.temperature;
    }
  } catch {}
  ['elabMaxTokens','elabTimeoutMs','elabTemperature'].forEach(id=>{
    const el = $(id);
    if (el) el.addEventListener('change', persistElabSettings);
  });
  $('btnElaborateSettings').onclick = function(){
    const panel = $('elaborateSettingsPanel');
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : '';
    this.classList.toggle('active', !open);
  };

  // LLM-powered Elaborate
  document.querySelectorAll('.btn-md-elaborate').forEach(btn=>{
    btn.onclick=async function(){
      const boxId=this.getAttribute('data-box');
      const ta=$(boxId);
      const provider = {
        type: $('providerType').value,
        baseUrl: $('providerBaseUrl').value.trim(),
        model: $('providerModel').value.trim(),
        providerApiKey: $('providerApiKey').value
      };
      if(!provider.baseUrl || !provider.model){
        toast('warn','Provider Incomplete','Set Base URL and Model in Step 1 before elaborating');
        return;
      }
      if(!provider.providerApiKey){
        toast('warn','Credential Missing','Paste a providerApiKey before elaborating');
        return;
      }
      const gen = readElabSettings();
      const context = assembleJson();
      busyBtn(this,'Elaborating…');
      try {
        // Client budget = server budget + 30s slack so the UI surfaces a real
        // provider error instead of an AbortError when the server is still working.
        const j = await api('/api/agents/elaborate',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          timeoutMs: gen.timeoutMs + 30000,
          body: JSON.stringify({ field: boxId, content: ta.value, context, provider, maxTokens: gen.maxTokens, timeoutMs: gen.timeoutMs, temperature: gen.temperature })
        });
        ta.value = j.elaborated;
        updatePreview(boxId);
        toast('ok','Content Elaborated','Enhanced with '+provider.model+' · '+gen.maxTokens+' tok · '+Math.round(gen.timeoutMs/1000)+'s budget');
      } catch(e){
        toast('err','Elaboration Failed',e.message);
      }
      resetBtn(this);
    };
  });

  // --- Provider Test Connection & Discovery ---
  $('btnTestConnection').onclick = async function(){
    const btn=this;
    const type=$('providerType').value;
    const baseUrl=$('providerBaseUrl').value.trim();
    const providerApiKey=$('providerApiKey').value;
    const model=$('providerModel').value.trim();

    if(!baseUrl){ toast('warn','Missing Base URL','Please enter provider Base URL'); return; }
    if(!providerApiKey){ toast('warn','Missing providerApiKey','Paste your provider API key — it is sealed encrypted on save'); return; }
    busyBtn(btn,'Testing…');
    $('testConnectionStatus').textContent='Connecting to provider live…';
    try {
      const res = await api('/api/providers/test',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ type, baseUrl, providerApiKey, model })
      });
      $('testConnectionStatus').innerHTML='<span class="ok-t">✓ '+escHtml(res.message)+'</span>';
      toast('ok','Connection Successful',res.message);

      if(res.models && res.models.length){
        const dd=$('modelSelectDropdown');
        dd.innerHTML='<option value="">Discovered models ('+res.models.length+')...</option>'+res.models.map(m=>'<option value="'+escHtml(m)+'">'+escHtml(m)+'</option>').join('');
        dd.style.display='inline-block';
        dd.onchange=function(){ if(this.value) $('providerModel').value=this.value; };
      }
    } catch(e){
      $('testConnectionStatus').innerHTML='<span class="err-t">✕ '+escHtml(e.message)+'</span>';
      toast('err','Connection Failed',e.message);
    }
    resetBtn(btn);
  };

  // --- MCP Live Test & Registration ---
  $('btnLoadEchoMcp').onclick=function(){
    $('newMcpName').value='inventory-echo';
    $('newMcpDesc').value='Local echo MCP server';
    $('newMcpConfig').value=JSON.stringify({ type:'local', command:'node', args:[${JSON.stringify(MCP_ECHO_SERVER_PATH)}], tools:['*'] },null,2);
  };

  $('btnTestRegisterMcp').onclick=async function(){
    const btn=this;
    const name=$('newMcpName').value.trim();
    const desc=$('newMcpDesc').value.trim();
    let config;
    try { config = JSON.parse($('newMcpConfig').value); }
    catch(e){ toast('warn','Invalid JSON','Fix MCP config JSON syntax: '+e.message); return; }

    if(!name){ toast('warn','Name Required','Provide an MCP server name'); return; }
    busyBtn(btn,'Testing & Registering…');
    $('mcpTestMsg').textContent='Probing STDIO/Hosted tools…';
    try {
      const j = await api('/api/mcp',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ name, description: desc||undefined, config, probe:true })
      });
      $('mcpTestMsg').innerHTML='<span class="ok-t">✓ Registered: '+escHtml(j.name)+'</span>';
      toast('ok','MCP Server Registered',j.name+' with '+j.tools.length+' tool(s)');

      // Display discovered tools
      const box=$('mcpDiscoveredToolsBox');
      const list=$('mcpDiscoveredToolsList');
      box.style.display='block';
      list.innerHTML = j.tools.map(t=>'<span class="pill tool-pill">🔧 '+escHtml(t.name)+'</span>').join('') || '<span class="mut">No tools exposed</span>';

      // Ensure item in the multi-select dropdown exists & is checked
      const msList=$('mcpMsList');
      let item = msList.querySelector('[data-mcp-name="'+name+'"]');
      if(!item){
        const empty = msList.querySelector('.mcp-ms-empty'); if(empty) empty.remove();
        const itemHtml = '<label class="mcp-ms-item" data-mcp-name="'+escHtml(name)+'" data-search="'+escHtml((name+' '+(desc||'')).toLowerCase())+'"><input type="checkbox" class="mcp-reg-check" value="'+escHtml(name)+'" checked /><div style="min-width:0"><div class="mcp-ms-name">'+escHtml(name)+'</div><div class="mcp-ms-desc">'+escHtml(desc||'Discovered '+j.tools.length+' tools')+'</div></div></label>';
        msList.insertAdjacentHTML('afterbegin', itemHtml);
        item = msList.querySelector('[data-mcp-name="'+name+'"]');
        const cnt=$('mcpMsCount'); if(cnt){ const total=msList.querySelectorAll('.mcp-ms-item').length; cnt.textContent = total+' server'+(total===1?'':'s')+' available'; }
      } else {
        item.querySelector('input').checked=true;
      }
    } catch(e){
      $('mcpTestMsg').innerHTML='<span class="err-t">✕ '+escHtml(e.message)+'</span>';
      toast('err','MCP Probe Failed',e.message);
    }
    resetBtn(btn);
  };

  // --- MCP searchable multi-select dropdown ---
  function mcpMsSync(){
    const selWrap=$('mcpRegistrySelector'), sum=$('mcpMsSummary'), badges=$('mcpMsBadges');
    if(!selWrap||!sum||!badges) return;
    const checked=Array.from(document.querySelectorAll('.mcp-reg-check:checked'));
    sum.textContent = checked.length ? checked.map(el=>el.value).join(', ') : (selWrap.querySelectorAll('.mcp-ms-item').length ? selWrap.querySelectorAll('.mcp-ms-item').length+' servers registered — select one or more' : 'No MCP servers registered yet');
    sum.classList.toggle('has-selection', checked.length>0);
    if(checked.length){
      badges.style.display='flex';
      badges.innerHTML = checked.map(el=>'<span class="mcp-ms-badge" data-badge-for="'+escHtml(el.value)+'">'+escHtml(el.value)+'<button type="button" data-remove-mcp="'+escHtml(el.value)+'" title="Remove '+escHtml(el.value)+'">×</button></span>').join('');
    } else { badges.style.display='none'; badges.innerHTML=''; }
  }
  const mcpMsToggleEl=$('mcpMsToggle');
  if(mcpMsToggleEl){
    mcpMsToggleEl.onclick=function(){
      const wrap=mcpMsToggleEl.closest('.mcp-ms');
      const open=wrap.classList.toggle('open');
      mcpMsToggleEl.setAttribute('aria-expanded', open?'true':'false');
      if(open){ const s=$('mcpMsSearch'); if(s) s.focus(); }
    };
    document.addEventListener('click',function(e){
      const wrap=$('mcpRegistrySelector');
      if(wrap && wrap.classList.contains('open') && !wrap.contains(e.target)){
        wrap.classList.remove('open');
        mcpMsToggleEl.setAttribute('aria-expanded','false');
      }
    });
  }
  const mcpMsSearchEl=$('mcpMsSearch');
  if(mcpMsSearchEl){
    mcpMsSearchEl.addEventListener('input',function(){
      const q=this.value.trim().toLowerCase();
      document.querySelectorAll('#mcpMsList .mcp-ms-item').forEach(function(it){
        it.classList.toggle('hidden', q!=='' && !(it.getAttribute('data-search')||'').includes(q));
      });
    });
  }
  const mcpMsClearBtn=$('mcpMsClear');
  if(mcpMsClearBtn){
    mcpMsClearBtn.onclick=function(){
      document.querySelectorAll('.mcp-reg-check:checked').forEach(function(ck){ ck.checked=false; });
      mcpMsSync();
    };
  }
  const mcpMsBadgesEl=$('mcpMsBadges');
  if(mcpMsBadgesEl){
    mcpMsBadgesEl.addEventListener('click',function(e){
      const btn=e.target.closest('[data-remove-mcp]');
      if(!btn) return;
      const name=btn.getAttribute('data-remove-mcp');
      const ck=document.querySelector('.mcp-reg-check[value="'+name.replace(/"/g,'\\\"')+'"]');
      if(ck){ ck.checked=false; mcpMsSync(); }
    });
  }
  document.querySelectorAll('.mcp-reg-check').forEach(ck=>{
    ck.addEventListener('change',mcpMsSync);
  });
  mcpMsSync();

  // --- Built-in tools grid helpers ---
  function readBuiltins(){
    const all = $('builtinAllCheck').checked;
    const perTool = {};
    document.querySelectorAll('[data-builtin-row]').forEach(function(row){
      const name = row.getAttribute('data-builtin-row');
      const decision = row.querySelector('select.builtin-tool-decision').value;
      const checked = row.querySelector('input.builtin-tool-check').checked;
      if(all){
        // Availability is open; only ask/deny overrides are recorded.
        if(decision!=='allow') perTool[name]=decision;
      } else {
        // Checkbox = availability; selected rows carry their decision, unchecked rows are denied.
        perTool[name]= checked ? decision : 'deny';
      }
    });
    return { all: all, default: $('builtinsDefault').value, perTool: perTool };
  }
  function gridEnabled(){
    const all = $('builtinAllCheck').checked;
    document.querySelectorAll('[data-builtin-row]').forEach(function(row){
      row.querySelector('input.builtin-tool-check').disabled = all;
      row.style.opacity = all ? '' : '1';
    });
    $('builtinFreeform').disabled = all;
    const btn=document.getElementById('btnAddFreeformTool'); if(btn) btn.disabled = all;
  }
  function addFreeformToolRow(name, decision, checked){
    const grid=document.getElementById('builtinToolGrid');
    if(!grid) return;
    if(grid.querySelector('[data-builtin-row="'+name.replace(/"/g,'')+'"]')) return;
    const div=document.createElement('div');
    div.className='mcp-card-select';
    div.setAttribute('data-builtin-row', name);
    div.innerHTML = '<div style="display:flex;gap:.5rem;align-items:center;flex:1;min-width:0"><input type="checkbox" class="builtin-tool-check" value="'+escHtml(name)+'"'+(checked?' checked="checked"':'')+' /><div style="min-width:0"><b style="font-size:.82rem">'+escHtml(name)+'</b><div class="mut" style="font-size:.72rem">freeform entry</div></div></div><select class="builtin-tool-decision" style="width:auto;padding:.2rem .35rem;font-size:.72rem"><option value="allow">allow</option><option value="ask">ask</option><option value="deny">deny</option></select>';
    grid.appendChild(div);
    div.querySelector('select.builtin-tool-decision').value = decision || 'allow';
  }
  function populateBuiltins(b){
    if(!$('builtinAllCheck')) return;
    const all = !b || b.all !== false;
    $('builtinAllCheck').checked = all;
    $('builtinsDefault').value = (b && b.default) ? b.default : 'allow';
    const per = (b && b.perTool) || {};
    // Freeform rows for non-registry names
    Object.keys(per).forEach(function(k){
      const bare = k.replace(/^(builtin|custom|mcp):/,'');
      if(!document.querySelector('[data-builtin-row="'+bare+'"]')) addFreeformToolRow(bare, per[k], per[k]==='allow');
    });
    document.querySelectorAll('[data-builtin-row]').forEach(function(row){
      const name = row.getAttribute('data-builtin-row').toLowerCase();
      let key = Object.keys(per).find(function(k){ const kl=k.toLowerCase(); return kl===name || kl.endsWith(':'+name); });
      const decision = key ? per[key] : 'allow';
      row.querySelector('select.builtin-tool-decision').value = decision;
      row.querySelector('input.builtin-tool-check').checked = all ? (key ? decision==='allow' : true) : decision!=='deny';
    });
    gridEnabled();
  }
  $('builtinAllCheck').addEventListener('change', function(){ gridEnabled(); updateM3Progress(); });
  if(document.getElementById('btnAddFreeformTool')) {
    document.getElementById('btnAddFreeformTool').onclick = function(){
      const name = $('builtinFreeform').value.trim();
      if(!name){ toast('warn','Name required','Enter a tool name first'); return; }
      addFreeformToolRow(name, 'allow', true);
      $('builtinFreeform').value='';
      toast('ok','Tool row added',name); 
    };
  }

  // --- Assembling Definition JSON from Screens ---
  function assembleJson(){
    const selectedMcp = Array.from(document.querySelectorAll('.mcp-reg-check:checked')).map(el=>el.value);
    const tags = $('metaTags').value.split(',').map(s=>s.trim()).filter(Boolean);
    const addDirs = $('knowledgeDirs').value.split(',').map(s=>s.trim()).filter(Boolean);
    const skillDirs = $('skillsDirs').value.split(',').map(s=>s.trim()).filter(Boolean);
    const allowedPatterns = $('toolsAllowedPatterns').value.split(',').map(s=>s.trim()).filter(Boolean);

    const patterns = allowedPatterns.map(tool=>({ tool, decision:'allow', reason:'Permitted in wizard' }));

    // Persona + default Copilot prompt toggle
    const defaultPromptOn = $('useDefaultPrompt').checked;
    const personaContent = $('personaContent').value.trim();
    const personaMode = $('personaMode').value==='replace' ? 'append' : $('personaMode').value;
    const personaSections = personaMode==='customize' ? collectPersonaSections() : undefined;
    const personaSysMessage = personaContent || personaSections
      ? { mode: personaMode, ...(personaContent ? { content: personaContent } : {}), ...(personaSections ? { sections: personaSections } : {}) }
      : undefined;
    const persona = defaultPromptOn
      ? { useCopilotDefaultPrompt: true, ...(personaSysMessage ? { systemMessage: personaSysMessage } : {}) }
      : { useCopilotDefaultPrompt: false, ...(personaContent ? { systemMessage: { mode:'replace', content: personaContent, acknowledgeReplaceRisks: $('personaAckReplace').checked } } : {}) };

    const def = {
      schemaVersion: '1.0',
      metadata: {
        name: $('metaName').value.trim() || 'custom-agent',
        version: $('metaVersion').value.trim() || '1.0.0',
        description: $('metaDesc').value.trim() || undefined,
        tags: tags.length ? tags : undefined
      },
      persona,
      instructions: {
        global: $('instructionsGlobal').value.split('\\n').map(s=>s.trim()).filter(Boolean),
        scoped: $('scopedApplyTo').value.trim() ? [{ applyTo: $('scopedApplyTo').value.trim(), body: $('scopedBody').value.trim() }] : undefined,
        agentsMdPaths: $('agentsMdPaths').value.split(',').map(s=>s.trim()).filter(Boolean)
      },
      knowledge: {
        workingDirectory: $('wsDir').value.trim() || undefined,
        additionalDirectories: addDirs.length ? addDirs : undefined,
        sessionStore: $('knowledgeSessionStore').value==='true'
      },
      agents: [
        {
          name: $('subAgentName').value.trim() || 'specialist',
          displayName: $('subAgentDisplayName').value.trim() || undefined,
          prompt: $('subAgentPrompt').value.trim(),
          tools: $('subAgentTools').value.split(',').map(s=>s.trim()).filter(Boolean),
          infer: true
        }
      ],
      defaultAgent: $('defaultAgent').value.trim() || $('subAgentName').value.trim(),
      skills: {
        directories: skillDirs.length ? skillDirs : ['./skills'],
        disabled: []
      },
      task: {
        prompt: $('taskPrompt').value.trim() || 'Hello from custom agent',
        deliveryMode: $('taskDeliveryMode').value
      },
      tools: {
        builtins: readBuiltins(),
        allowDestructive: $('allowDestructive').value === 'true',
        permissionPolicy: $('toolsPolicy').value,
        patterns: patterns.length ? patterns : [],
        harness: $('rtHarness') ? $('rtHarness').value === 'true' : true
      },
      mcp: {
        servers: {},
        use: selectedMcp
      },
      provider: {
        type: $('providerType').value,
        // Auto-defaults: empty provider fields fall back to the selected preset (mimo
        // when untouched), and an empty key becomes an env-var reference — so a
        // task-only definition assembles into a valid agent without extra typing.
        baseUrl: $('providerBaseUrl').value.trim() || PRESETS[$('providerPreset').value]?.url || PRESETS.mimo.url,
        model: $('providerModel').value.trim() || PRESETS[$('providerPreset').value]?.model || PRESETS.mimo.model,
        wireApi: $('providerWireApi').value,
        providerApiKey: $('providerApiKey').value.trim() || ($('providerPreset').value==='mimo' ? '$'+'{MIMO_API_KEY}' : '$'+'{LLM_API_KEY}')
      },
      runtime: {
        streaming: $('rtStreaming').value==='true',
        idleTimeoutSecs: parseInt($('rtIdleTimeout').value,10)||1800,
        turnTimeoutMs: parseInt($('rtTurnTimeout').value,10)||2700000,
        maxAiCredits: parseInt($('rtMaxCredits').value,10)||100,
        logLevel: $('rtLogLevel').value,
        clientInfo: {
          applicationName: 'minions-assembler',
          applicationVersion: '1.0.0',
          integrationName: 'wizard-defined',
          integrationVersion: '1.0.0'
        }
      }
    };

    const csv = id => $(id).value.split(',').map(s=>s.trim()).filter(Boolean);
    const rtExcludedAgents = csv('rtExcludedBuiltinAgents');
    const rtIncludedSkills = csv('rtIncludedBuiltinSkills');
    const autopilotVal = $('rtAutopilot').value;
    def.runtime = Object.assign(def.runtime || {}, {
      ...(def.runtime||{}),
      toolSearch: $('rtToolSearch').value === 'true' ? { enabled: true } : undefined,
      ...(rtExcludedAgents.length ? { excludedBuiltinAgents: rtExcludedAgents } : {}),
      ...(rtIncludedSkills.length ? { includedBuiltinSkills: rtIncludedSkills } : {}),
      ...(autopilotVal ? { autopilot: autopilotVal === 'true' } : {})
    });
    if(def.runtime.toolSearch === undefined) {
      const { toolSearch, ...rest } = def.runtime;
      def.runtime = rest;
    }

    if($('fleetEnabled').value==='true'){
      def.fleet = {
        enabled: true,
        prompt: $('fleetPrompt').value.trim() || undefined,
        maxConcurrentWorkers: parseInt($('fleetMaxWorkers').value,10) || 5
      };
    }

    return def;
  }

  function syncFinalJson(){
    const def = assembleJson();
    $('finalJsonViewer').value = JSON.stringify(def, null, 2);
  }

  // --- Populate Screens from Imported/Loaded Definition JSON ---
  function populateScreensFromJson(def){
    if(!def || typeof def !== 'object') return;
    if(def.knowledge?.workingDirectory) $('wsDir').value = def.knowledge.workingDirectory;
    if(def.provider){
      if(def.provider.type) $('providerType').value = def.provider.type;
      if(def.provider.baseUrl) $('providerBaseUrl').value = def.provider.baseUrl;
      if(def.provider.providerApiKey){
        // enc:v1: tokens and env refs are safe to round-trip; raw keys are already masked by type=password.
        $('providerApiKey').value = def.provider.providerApiKey;
      } else if(def.provider.credentialEnv){
        // Legacy definition: migrate to the fixed attribute as an env reference.
        $('providerApiKey').value = '$' + '{' + def.provider.credentialEnv + '}';
      }
      if(def.provider.model) $('providerModel').value = def.provider.model;
      if(def.provider.wireApi) $('providerWireApi').value = def.provider.wireApi;
    }
    if(def.metadata){
      if(def.metadata.name) $('metaName').value = def.metadata.name;
      if(def.metadata.version) $('metaVersion').value = def.metadata.version;
      if(def.metadata.description) $('metaDesc').value = def.metadata.description;
      if(def.metadata.tags) $('metaTags').value = def.metadata.tags.join(', ');
    }
    if(def.persona?.systemMessage){
      if(def.persona.systemMessage.mode) $('personaMode').value = def.persona.systemMessage.mode;
      if(def.persona.systemMessage.content) $('personaContent').value = def.persona.systemMessage.content;
      if(def.persona.systemMessage.acknowledgeReplaceRisks) $('personaAckReplace').checked = true;
      if(def.persona.systemMessage.sections){
        loadPersonaCatalog().then(function(sections){ renderPersonaSectionRows(sections, def.persona.systemMessage.sections); });
      }
      togglePersonaCustomize();
      $('replaceRiskContainer').style.display = $('personaMode').value==='replace'?'block':'none';
      $('useDefaultPrompt').checked = $('personaMode').value!=='replace'
        ? (def.persona.useCopilotDefaultPrompt !== false)
        : false;
    } else if(def.persona){
      // Pure default-prompt agent (or explicit off with no content)
      $('useDefaultPrompt').checked = def.persona.useCopilotDefaultPrompt !== false;
      $('personaMode').value = 'append';
      $('replaceRiskContainer').style.display = 'none';
    }
    if(def.instructions){
      if(Array.isArray(def.instructions.agentsMdPaths)) $('agentsMdPaths').value = def.instructions.agentsMdPaths.join(', ');
      if(Array.isArray(def.instructions.global)) $('instructionsGlobal').value = def.instructions.global.join('\\n');
      if(Array.isArray(def.instructions.scoped) && def.instructions.scoped[0]){
        $('scopedApplyTo').value = def.instructions.scoped[0].applyTo || '';
        $('scopedBody').value = def.instructions.scoped[0].body || '';
      }
    }
    if(def.knowledge){
      if(Array.isArray(def.knowledge.additionalDirectories)) $('knowledgeDirs').value = def.knowledge.additionalDirectories.join(', ');
      $('knowledgeSessionStore').value = def.knowledge.sessionStore ? 'true' : 'false';
    }
    if(Array.isArray(def.agents) && def.agents[0]){
      const a = def.agents[0];
      if(a.name) $('subAgentName').value = a.name;
      if(a.displayName) $('subAgentDisplayName').value = a.displayName;
      if(a.prompt) $('subAgentPrompt').value = a.prompt;
      if(Array.isArray(a.tools)) $('subAgentTools').value = a.tools.join(', ');
    }
    if(def.defaultAgent) $('defaultAgent').value = def.defaultAgent;
    if(Array.isArray(def.skills?.directories)) $('skillsDirs').value = def.skills.directories.join(', ');
    if(def.task){
      if(def.task.prompt) $('taskPrompt').value = def.task.prompt;
      if(def.task.deliveryMode) $('taskDeliveryMode').value = def.task.deliveryMode;
    }
    if(def.tools){
      if(def.tools.permissionPolicy) $('toolsPolicy').value = def.tools.permissionPolicy;
      if(Array.isArray(def.tools.patterns)){
        $('toolsAllowedPatterns').value = def.tools.patterns.map(p=>p.tool).join(', ');
      }
      if(def.tools.harness !== undefined && $('rtHarness')) $('rtHarness').value = def.tools.harness ? 'true' : 'false';
      if(def.tools.allowDestructive !== undefined && $('allowDestructive')) $('allowDestructive').value = def.tools.allowDestructive ? 'true' : 'false';
      populateBuiltins(def.tools.builtins);
    }
    if(Array.isArray(def.mcp?.use)){
      const used = new Set(def.mcp.use.map(u=>typeof u==='string'?u:u.name));
      document.querySelectorAll('.mcp-reg-check').forEach(ck=>{
        ck.checked = used.has(ck.value);
      });
      mcpMsSync();
    }
    if(def.fleet){
      $('fleetEnabled').value = def.fleet.enabled ? 'true' : 'false';
      if(def.fleet.prompt) $('fleetPrompt').value = def.fleet.prompt;
      if(def.fleet.maxConcurrentWorkers) $('fleetMaxWorkers').value = def.fleet.maxConcurrentWorkers;
    }
    if(def.runtime){
      if(def.runtime.streaming !== undefined) $('rtStreaming').value = def.runtime.streaming ? 'true' : 'false';
      if(def.runtime.idleTimeoutSecs) $('rtIdleTimeout').value = def.runtime.idleTimeoutSecs;
      if(def.runtime.turnTimeoutMs) $('rtTurnTimeout').value = def.runtime.turnTimeoutMs;
      if(def.runtime.maxAiCredits) $('rtMaxCredits').value = def.runtime.maxAiCredits;
      if(def.runtime.logLevel) $('rtLogLevel').value = def.runtime.logLevel;
      if(def.runtime.toolSearch) $('rtToolSearch').value = def.runtime.toolSearch.enabled ? 'true' : 'false';
      if(def.runtime.autopilot != null && $('rtAutopilot')) $('rtAutopilot').value = String(def.runtime.autopilot);
      if(Array.isArray(def.runtime.excludedBuiltinAgents) && $('rtExcludedBuiltinAgents')) $('rtExcludedBuiltinAgents').value = def.runtime.excludedBuiltinAgents.join(', ');
      if(Array.isArray(def.runtime.includedBuiltinSkills) && $('rtIncludedBuiltinSkills')) $('rtIncludedBuiltinSkills').value = def.runtime.includedBuiltinSkills.join(', ');
    }

    updateAllMarkdownPreviews();
    syncFinalJson();
    updateM3Progress();
  }

  // --- Material 3 Linear Progress & Stepper Updates ---
  function updateM3Progress(){
    const def = assembleJson();
    let completedSteps = 0;

    const setStep=(num, isOk, desc)=>{
      const chip = document.querySelector('.m3-step-chip[data-step="'+num+'"]');
      const dot = $('m3Dot'+num);
      const descEl = $('m3Desc'+num);
      if(!chip) return;
      if(isOk){
        completedSteps++;
        chip.classList.add('done');
        if(dot) dot.textContent = '✓';
      } else {
        chip.classList.remove('done');
        if(dot) dot.textContent = num;
      }
      if(descEl && desc) descEl.textContent = desc;
    };

    setStep(1, Boolean(def.knowledge?.workingDirectory && def.provider?.baseUrl && def.provider?.model), def.provider?.model || 'Directory & LLM');
    setStep(2, Boolean(def.metadata?.name && def.persona?.systemMessage?.content), def.metadata?.name || 'Name & System Prompt');
    setStep(3, Boolean(def.instructions?.global?.length), (def.instructions?.global?.length||0) + ' instructions');
    setStep(4, Boolean(def.agents?.length), def.agents?.[0]?.name || 'Specialist Routing');
    setStep(5, Boolean(def.task?.prompt), 'Prompt & Permissions');
    setStep(6, Boolean(def.mcp?.use?.length), (def.mcp?.use?.length||0) + ' server(s)');
    setStep(7, Boolean(def.fleet?.enabled), def.fleet?.enabled ? 'Fleet ('+def.fleet.maxConcurrentWorkers+' workers)' : 'Disabled');
    setStep(8, true, 'Ready to review');

    const pct = Math.round((completedSteps / TOTAL_STEPS) * 100);
    if($('m3ProgressFill')) $('m3ProgressFill').style.width = Math.max(12.5, pct) + '%';
    if($('m3ProgressPct')) $('m3ProgressPct').textContent = pct + '% Completed (' + completedSteps + ' of ' + TOTAL_STEPS + ' steps)';
  }

  // --- Validate Assembled JSON ---
  async function validateAssembledJson(){
    const box = $('validationResultBox');
    box.innerHTML = '<div class="alert info"><b>ℹ</b> Validating against AgentDefinition v1.0 schema…</div>';
    let def;
    try {
      def = JSON.parse($('finalJsonViewer').value);
    } catch(e){
      box.innerHTML = '<div class="alert err"><b>✕ Syntax Error:</b> Invalid JSON: '+escHtml(e.message)+'</div>';
      return false;
    }

    try {
      const res = await api('/api/agents/validate',{
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: def })
      });
      const warns = res.warnings || [];
      box.innerHTML = '<div class="alert ok"><b>✓ Valid Agent Definition:</b> Schema checks passed (hash <code class="inline">'+res.hash+'</code>)</div>' +
        warns.map(w=>'<div class="alert warn" style="margin-top:.4rem"><b>▲ Warning:</b> '+escHtml(w)+'</div>').join('');
      return true;
    } catch(e){
      box.innerHTML = '<div class="alert err"><b>✕ Validation Error:</b> '+escHtml(e.message)+'</div>';
      return false;
    }
  }

  $('btnRunValidation').onclick = validateAssembledJson;

  // --- Save Draft ---
  async function saveDraft(){
    syncFinalJson();
    let def;
    try { def = JSON.parse($('finalJsonViewer').value); }
    catch(e){ toast('err','Invalid JSON',e.message); return; }

    try {
      const j = await api('/api/agents/draft',{
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: def })
      });
      toast('ok','Draft Saved','Agent draft "'+j.id+'" saved for re-use');
      const dd = $('draftsDropdown');
      let opt = Array.from(dd.options).find(o=>o.value===j.id);
      if(!opt){
        opt = document.createElement('option');
        opt.value = j.id;
        opt.textContent = j.name + ' (v' + j.version + ')';
        dd.appendChild(opt);
      }
      dd.value = j.id;
    } catch(e){
      toast('err','Draft Save Failed',e.message);
    }
  }

  $('btnSaveDraftGlobal').onclick = saveDraft;
  $('btnNavSaveDraft').onclick = saveDraft;

  // Load Draft from dropdown or external call
  window.loadDraftById = async function(id){
    try {
      const j = await api('/api/agents/'+encodeURIComponent(id));
      populateScreensFromJson(j.definition);
      switchMainTab('define');
      goToStep(1);
      toast('ok','Draft Loaded',id+' loaded into wizard');
    } catch(e){
      toast('err','Could not load draft',e.message);
    }
  };

  $('draftsDropdown').addEventListener('change',function(){
    if(!this.value) return;
    window.loadDraftById(this.value);
  });

  // --- Upload Agent Definition JSON ---
  // --- Import markdown agent profile (.agent.md: frontmatter + prompt body) ---
  $('btnImportMd').onclick = ()=> $('fileMdImporter').click();
  $('fileMdImporter').onchange = function(){
    const file = this.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = async e=>{
      try {
        const res = await api('/api/agents/import',{
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: e.target.result, register: false })
        });
        populateScreensFromJson(res.definition);
        $('wizardGlobalAlert').innerHTML = '<div class="alert ok"><b>✓ Markdown profile imported:</b> <code class="inline">'+escHtml(file.name)+'</code> mapped to a regular agent on the default Copilot system prompt (hash: '+res.definitionHash+'). Review and Publish.</div>';
        toast('ok','Markdown agent imported',file.name+' populated into all screens');
        updateM3Progress();
      } catch(err){
        $('wizardGlobalAlert').innerHTML = '<div class="alert err"><b>✕ Import Error:</b> '+escHtml(err.message)+'</div>';
        toast('err','Markdown Import Failed',err.message);
      }
    };
    reader.readAsText(file);
    this.value='';
  };

  // --- Workspace instruction-file detection (AGENTS.md & friends) ---
  async function scanInstructionFiles(){
    const box = $('instructionFilesList');
    if(!box) return;
    box.textContent = 'scanning…';
    try {
      const r = await api('/api/workspace/instruction-files?workdir='+encodeURIComponent($('wsDir').value.trim() || '.'));
      const files = r.files || [];
      if(!files.length){ box.innerHTML = '<span class="mut">No AGENTS.md / CLAUDE.md / .github/copilot-instructions.md found in the working directory yet — drop one in and it will be picked up automatically.</span>'; return; }
      box.innerHTML = files.map(function(f){
        return '<div style="margin:.15rem 0">📄 <code class="inline">'+escHtml(f.path)+'</code> <span class="mut">('+f.kind+' · '+f.bytes+' chars — picked up automatically)</span></div>';
      }).join('');
    } catch(err){ box.textContent = 'scan failed: '+err.message; }
  }
  $('btnScanInstructions').onclick = scanInstructionFiles;
  $('wsDir').addEventListener('change', scanInstructionFiles);
  scanInstructionFiles();

  $('btnImportJson').onclick = ()=> $('fileImporter').click();
  $('fileImporter').onchange = function(){
    const file = this.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = async e=>{
      try {
        const parsed = JSON.parse(e.target.result);
        const res = await api('/api/templates/upload',{
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed)
        });
        populateScreensFromJson(parsed);
        const alertBox = $('wizardGlobalAlert');
        const warns = res.warnings || [];
        alertBox.innerHTML = '<div class="alert ok"><b>✓ Definition Uploaded:</b> Successfully loaded <code class="inline">'+escHtml(file.name)+'</code> (hash: '+res.hash+')</div>' +
          warns.map(w=>'<div class="alert warn" style="margin-top:.4rem"><b>▲ Warning:</b> '+escHtml(w)+'</div>').join('');
        toast('ok','Agent JSON Loaded',file.name+' populated into all screens');
        updateM3Progress();
      } catch(err){
        $('wizardGlobalAlert').innerHTML = '<div class="alert err"><b>✕ Import Error:</b> '+escHtml(err.message)+'</div>';
        toast('err','Import Validation Failed',err.message);
      }
    };
    reader.readAsText(file);
  };

  // --- Load Example Template ---
  $('btnLoadExample').onclick = async function(){
    try {
      const tpl = await api('/api/templates/default');
      populateScreensFromJson(tpl);
      toast('ok','Example Loaded','Working fixture definition loaded into all screens');
      updateM3Progress();
    } catch(e){
      toast('err','Could not load template',e.message);
    }
  };

  // --- Publish Agent ---
  $('btnNavPublish').onclick = async function(){
    const btn=this;
    syncFinalJson();
    let def;
    try { def = JSON.parse($('finalJsonViewer').value); }
    catch(e){ toast('err','Invalid JSON',e.message); return; }

    busyBtn(btn,'Publishing…');
    try {
      const j = await api('/api/agents',{
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: def })
      });
      toast('ok','Agent Published',j.id+' is now active and ready to run');
      $('validationResultBox').innerHTML = '<div class="alert ok" style="padding:1.2rem"><b>🚀 Published!</b> Agent <code class="inline">'+escHtml(j.id)+'</code> is now available on <a href="/ui/agents">/ui/agents</a>.<br><a href="/ui/agents/'+encodeURIComponent(j.id)+'" class="btn sm" style="margin-top:.6rem;display:inline-block">Open Agent Page →</a></div>';
      setTimeout(()=>{ location.href = '/ui/agents/' + encodeURIComponent(j.id); }, 1400);
    } catch(e){
      toast('err','Publish Failed',e.message);
      $('validationResultBox').innerHTML = '<div class="alert err"><b>✕ Publish Blocked:</b> '+escHtml(e.message)+'</div>';
    }
    resetBtn(btn);
  };

  // --- Copy / Download JSON ---
  $('btnCopyJson').onclick = ()=>{
    navigator.clipboard.writeText($('finalJsonViewer').value);
    toast('info','Copied','Definition JSON copied to clipboard');
  };
  $('btnDownloadJson').onclick = ()=>{
    const blob = new Blob([$('finalJsonViewer').value],{type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ($('metaName').value.trim()||'agent')+'-definition.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('ok','Downloaded','Definition saved to downloads folder');
  };

  function escHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Initial tab check from URL query params
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('tab') === 'define') {
    switchMainTab('define');
  }
  const editId = urlParams.get('edit');
  if (editId) {
    switchMainTab('define');
    if (typeof window.loadDraftById === 'function') window.loadDraftById(editId);
  }

  // Initial render
  updateAllMarkdownPreviews();
  updateM3Progress();
  gridEnabled();
})();
`;
