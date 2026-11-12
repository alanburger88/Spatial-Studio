# Setup and safe launch instructions

**This archive is a repository blueprint, not a prebuilt runnable web application.** Do not run `pnpm dev` before the coding agent has scaffolded `package.json` and the application packages.

## Prerequisites (development environment)

- Node 22+ LTS, pnpm via Corepack, a recent Chromium browser, Python 3.10+ (3.13 verified for pack tests).
- Optional `jsonschema`/`pypdf` for deep pack schema and PDF inspection. The supplied `verify_pack.py` and core oracle tests run without third-party Python libraries.
- Network only to fetch stable npm dependencies or explicitly permitted external AI provider. The base application and offline assistant must work without a hosted backend.
- Store secrets in local uncommitted `.env`; see `.env.example`. External AI cannot be enabled until configured.

## Step 1: verify the pack

```bash
python3 scripts/verify_pack.py
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

These tests verify *assets and independent golden outcomes*, not the application.

## Step 2: feed to autonomous agent

Open the unzipped root as the agent's workspace and paste the full contents of `execution/ONE_SHOT_PROMPT.md`. Require it to read START_HERE and AGENTS and not ask sponsor about branding or hosting until necessary.

## Step 3: agent builds

Create `package.json`, lockfile, packages and apps. Document exact commands in the final report. Expected local topology is web at `http://127.0.0.1:5173` and API at `http://127.0.0.1:3001`.

## Step 4: verify the built application

```bash
python3 scripts/verify_app.py --base-url http://127.0.0.1:3001 --web-url http://127.0.0.1:5173
./scripts/verify-all.sh --app
```

Both commands should FAIL rather than falsely PASS before the application exists. After app implementation, they supplement — not replace — the 36 acceptance checks and browser tests.

## Deployment and branding

- Branding: insert approved brand assets only when supplied, using `--iss-*` tokens. Keep existing placeholder theme until then.
- Publication: **do not deploy**. Sponsor will supply instructions later; ask when local build is ready to publish, not earlier.
