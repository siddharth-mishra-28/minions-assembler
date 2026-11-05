# Four-mode acceptance — 2026-11-04

This is the handover record for the single-package release of **minions-assembler 1.0.0**.
It documents what was actually executed, what passed, what was repaired after generation,
and how to reproduce or publish the artifact.

The production task used for every mode was the **Northwind Outfitters** three-tier store:
embedded H2 database + Spring Boot 3.5 REST API + Next.js App Router UI, generated in two
phases (backend, then frontend) with one shared `Full Stack Engineer` definition
([`examples/full-stack-engineer.agent.json`](../examples/full-stack-engineer.agent.json))
and the task files in [`ci/tasks/`](../ci/tasks).

## Result matrix

| Mode | How it was driven | Generation | Independent verification | Verdict |
| --- | --- | --- | --- | --- |
| Browser cockpit | Real Chromium against `serve` | — | 25 scripted flows across every page/action | **PASS 25/25** |
| CLI | Packaged CLI, `run --output-format json` | `run_f7d566bb` (47 min) + `run_93cb1231` (31 min) | `ci/verify-app.mjs` | **PASS**, 70/71 checks, 0 required failures |
| REST API | `POST /api/agent-definitions/runs` on a server | `run_bd82723e` + `run_efb207f5` | `ci/verify-app.mjs` | **PASS**, 70/71 checks, 0 required failures |
| UI | Chromium drove New run → inline definition → run detail | `run_849f61f0` + `run_c92636b2` | `ci/verify-app.mjs` | **PASS**, 70/71 checks, 0 required failures |
| GitLab CI | Pipeline `3028042462` on `uat/four-mode-20261104-2136` | `run_a68aabec` (70 min) + `run_f171fa99` (34 min) | Pipeline `app_check` + repaired artifact re-verified locally | Artifact **built**; verification passed after documented repairs |

The single non-required warning in every verifier run is identical: a guest checkout placed
with an e-mail address is not attached to that customer's authenticated order history. The
contract allows guest checkout and only requires that authenticated orders are listed, so the
check is recorded as a warning rather than a failure.

## Single package

One tarball is produced by `npm pack` (which runs the full `prepack` build):

- shipped: `dist/**` including the Vite/React cockpit in `dist/web/**`, plus
  `examples/full-stack-engineer.agent.json`, `docs/UAT.md`, `README.md` and `LICENSE`;
- not shipped: `src/`, tests, `web/`, `data/`, runs, evidence, CI scripts;
- `web/package.json` is `private: true`; there is no second package;
- the retired server-rendered `/ui` surface is absent from `src/` and `dist/`; `/ui` and
  `/ui/dashboard` return **404** from the installed package while `/`, `/api/status`,
  `/docs/` and `/openapi.json` return **200**.

The final rebuild made after the cleanup is 217 files, 679.6 kB packed (2.6 MB unpacked),
shasum `d628dce55f91feeb417f2cecee9d0c06f6236f97`. It was installed into a clean prefix and
exercised independently, all against the real Mimo provider:

- `minions-assembler --version` → `1.0.0`;
- `minions-assembler validate --agentDefinition examples/full-stack-engineer.agent.json` →
  `valid: full-stack-engineer@1.0.0 (hash b4dc171313f5215c)`;
- `minions-assembler serve --port 3220` → cockpit rendered in Chromium (`Minions Cockpit`),
  onboarding completed, SPA navigation to `/chat` worked, `/`, `/docs/` and `/openapi.json`
  returned 200, and `/ui` plus `/ui/dashboard` were 404 even with a browser `Accept` header;
- CLI: `run_bcc11118` returned `PACKAGED_OK` in 10.8 s;
- API: `POST /api/agent-definitions/runs` returned `API_PACKAGED_OK` (`run_0e8a5b97`);
- UI: **New run** in the installed cockpit executed `full-stack-engineer@1.0.0` and returned
  `UI_PACKAGED_OK` (`run_d2d20aa1`, 20.2 s, 31 audited events, output and timeline rendered).

## What the app verifier proves

`ci/verify-app.mjs` does not trust the generation report. For each generated app it:

1. runs `mvn -q -B test`, requires at least 25 tests and zero failures;
2. packages the jar and boots it on a fresh H2 file database with seed data;
3. exercises the HTTP contract (catalog pagination/search/sort, auth, cart, checkout totals,
   coupon, idempotency, stock decrement, order lookup, reviews, admin CRUD/transitions/KPIs);
4. installs and builds the Next.js production bundle, starts it with the `/api` rewrite;
5. drives Chromium through storefront → product → cart → checkout → confirmation →
   customer login → admin login → dashboard → create product → storefront visibility →
   admin orders;
6. writes `report.json`, `report.md` and screenshots.

No required check failed for CLI, API, UI or the repaired GitLab artifact (70 of 71 checks
passed); the single non-required warning is described above.

## Repairs made after generation

These are real generation defects found by verification. They were repaired in the generated
workspaces (never in the packaged source) and are disclosed here for honesty:

| Mode | Defect | Repair |
| --- | --- | --- |
| CLI | `Order.line1` mapped to a 12-character column, rejecting a normal address | widened to 120 characters |
| CLI | Admin login used non-standard test ids | standard `login-email` / `login-password` / `login-submit` |
| API | Admin sub-pages imported `../../components` from `app/admin/<page>` | corrected to `../../../` |
| API | Admin order status select compared `OrderStatus` with `''` | narrowed the empty-value guard |
| API | Checkout did not pass the guest e-mail to the confirmation route | redirect now includes `?email=` |
| API | Admin login used non-standard test ids | standard test ids |
| UI | Catalog sent a 1-based page number to a 0-based API | sends `page - 1` |
| UI | Checkout did not pass the guest e-mail to the confirmation route | redirect now includes `?email=` |
| GitLab | Catalog effect depended on a new `filters` object each render, causing an infinite refetch/re-render loop | depend on the primitive filter fields |
| GitLab | Admin login used non-standard test ids | standard test ids |

The verifier itself was also hardened for the contract: `PUT /api/admin/products/:id` now sends
a complete product, and admin order transitions accept the `orderId` field. The GitLab pipeline
job `app_check` ran the earlier committed verifier against an unrepaired generation, so it
reported 58/62; the same downloaded GitLab artifact passed 70/71 after the two app repairs above.

## Evidence map

The acceptance evidence tree (`evidence/`, generated apps, run directories, screenshots) was
**removed in the pre-publish cleanup**, because none of it may be packed into the npm artifact.
The durable record is this document plus the pipeline below; the run IDs above can be reproduced
with the commands in this file. During acceptance the reports lived at:

| Evidence | Path (removed) |
| --- | --- |
| Cockpit E2E report + screenshots | `evidence/uat-20261104/reports/cockpit-e2e/` |
| CLI verifier report + screenshots | `evidence/uat-20261104/reports/cli/` |
| API verifier report + screenshots | `evidence/uat-20261104/reports/api/` |
| UI verifier report + screenshots | `evidence/uat-20261104/reports/ui/` |
| GitLab verifier report + screenshots | `evidence/uat-20261104/reports/gitlab/` |
| GitLab pipeline artifacts (package, generated app, reports) | `evidence/gitlab/pipeline-3028042462/*.zip` |
| Generation logs and run IDs | `evidence/uat-20261104/logs/` |

Pipeline: <https://gitlab.com/siddharthmishra28/minions-assembler/-/pipelines/3028042462>
(project `86769878`). Its artifacts expire one week after the run.

## Build, verify and publish locally

Prerequisites: Node.js 22.12+, npm 10+; Java 17+ and Maven 3.9+ only for the generated app.

```bash
# 1. Clean install and full checks
npm ci
npm --prefix web ci
npm run typecheck
npm run typecheck:web
npm test
npm run test:web

# 2. Build one artifact (prepack rebuilds dist/ and dist/web automatically)
npm run build
npm pack                      # -> minions-assembler-1.0.0.tgz

# 3. Inspect exactly what will be published
npm pack --dry-run
tar -tzf minions-assembler-1.0.0.tgz | head -40
tar -tzf minions-assembler-1.0.0.tgz | grep -E 'dist/web/index.html|examples/full-stack-engineer.agent.json'
tar -tzf minions-assembler-1.0.0.tgz | grep -E '(^|/)src/ui/|routes-ui' && echo 'legacy UI leaked' || echo 'no legacy UI'

# 4. Install the built artifact locally and test all local modes
npm install -g ./minions-assembler-1.0.0.tgz
minions-assembler --version
minions-assembler validate --agentDefinition "$(npm root -g)/minions-assembler/examples/full-stack-engineer.agent.json"
minions-assembler serve --port 3100          # cockpit: http://127.0.0.1:3100
curl -s http://127.0.0.1:3100/api/status
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/ui/dashboard   # 404

# 5. CLI mode against a real provider (reads MIMO_API_KEY from the environment)
export MIMO_API_KEY='...'
minions-assembler run \
  --agentDefinition "$(npm root -g)/minions-assembler/examples/full-stack-engineer.agent.json" \
  --task "Reply with exactly: OK" \
  --db ./data/minion.db --approval autopilot --no-stream --output-format json

# 6. Publish the single artifact (when you are ready)
npm login
npm publish --dry-run
npm publish --access public
```

To publish to a local registry instead of npmjs.com, point both commands at it:

```bash
npx verdaccio --listen 4873
npm publish ./minions-assembler-1.0.0.tgz --registry http://127.0.0.1:4873
npm install -g minions-assembler --registry http://127.0.0.1:4873
```

### GitLab CI mode

`.gitlab-ci.yml` defines `package → generate_backend → generate_frontend → app_check` plus a
cockpit smoke job. The only build happens in `package`; every later job installs that tarball.

1. Add a masked CI/CD variable `MIMO_API_KEY` to the project.
2. Commit the repository and push the branch (or run a pipeline from **CI/CD → Pipelines**).
3. `package` produces `minions-assembler-1.0.0.tgz`; `generate_backend` / `generate_frontend`
   install it and run the two phases with `--runDir app`.
4. `app_check` downloads `app/` (and the tarball), then runs `node ci/verify-app.mjs` with
   Chromium. The generated app is the artifact; inspection screenshots and reports are uploaded
   even on failure.

A standalone job that only generates (no verification) is also shown in the README.

## Manual smoke test after cleanup

```bash
npm ci
npm --prefix web ci
npm pack
npm install -g ./minions-assembler-1.0.0.tgz
minions-assembler serve --port 3100
```

The repository is already in the pre-publish state used for the verification above: runtime
dirs, evidence, generated workspaces and the old tarball were removed; only the one shipped
example remains under `examples/`. `npm pack` recreates `dist/` and the tarball.

Open <http://127.0.0.1:3100>, complete onboarding with a provider, then use Chat, Agents,
Runs, Dashboard, MCP registry, Audit & logs, API docs and Settings. Every one of those pages
was exercised in the cockpit run recorded above.
