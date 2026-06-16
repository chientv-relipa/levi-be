# Levi Relayer — off-chain security firewall (NestJS)

The off-chain "brain" of **Levi**, a security firewall for autonomous on-chain agents on Sui.
The on-chain Move contract (`../sui-contract`) is the trustless enforcer; **this service is the
decision engine** that sits in front of every agent action: it
receives an agent's *encrypted intent*, decrypts and analyzes it (Claude Opus 4.8, with a
deterministic rule-based fallback), and lands a verdict on-chain via `verdict_action` —
**Approved**, **Escalated** (needs the owner), or **Blocked**.

The agent never touches the chain directly and **pays no gas**: the relayer is the gas sponsor
(Sui sponsored transactions), while the agent stays the transaction *sender* so the contract's
`sender == agent_wallet` check still holds. The relayer can never move the agent's funds — it can
only **co-sign gas** for the exact instructions it built, and only **score** an action.

> Ported from the original plain-TypeScript service to NestJS (Fastify adapter). Same behavior
> and the same security guards, proven by the test suite (the parity gate). It reuses
> `../sui-contract`'s SDK for crypto / types / constants.

## What it does

1. **Serves its public key & on-chain config** so an agent can encrypt intent to it.
2. **Sponsors & brokers actions** — builds the `submit_action` transaction, dry-runs it, co-signs
   gas, and broadcasts; the action lands on-chain as `Pending`.
3. **Analyzes intent** — decrypts the payload, verifies its blake3 commitment, scores the *actual*
   decoded transaction (not just the declared fields), and applies a deterministic deny floor.
4. **Renders the verdict on-chain** — `verdict_action` → Approved / Escalated / Blocked, updates
   the agent's reputation, and persists the human-readable reasoning off-chain.
5. **Handles escalations** — owner approves/rejects an Escalated action (browser-signed,
   gas-sponsored).
6. **Backs a dashboard** — read endpoints (agents, actions, stats, reasoning) + owner self-service
   (register / activate / deactivate / allow-list), Swagger, and CORS.

## How it works

```
 AGENT (protect())            RELAYER (this app)                   SUI CHAIN
 ─────────────────            ──────────────────                  ─────────
 GET /system/config  ───────▶ serve relayer x25519 pubkey + IDs
 encrypt {prompt,tx}
 POST build-submit   ───────▶ build sponsored submit_action tx ─▶ (unsigned)
 sign as sender ◀──────────── return { transaction }
 POST submit         ───────▶ assert sponsorable + dry-run + co-sign gas + broadcast ─▶ submit_action → Action(Pending)
                              engine: decrypt → verify blake3 commitment → analyze
                                (Claude/rule-based + deny floor) → verdict_action ──────▶ Approved / Escalated / Blocked
                              persist reasoning + log
 ◀── { verdict } (sync) ───── return decision
 escalation (if Escalated): owner signs build-approve/reject ────▶ approve/reject_action → Approved / Rejected (+strike)
```

## Decision model

The analyzer maps each action to a **`rawScore` on a `0..100000` scale** (the contract's scale).
`verdict_action` classifies it by two thresholds, and the same `classifyScore` is mirrored
off-chain:

| Score range | Decision | Meaning |
|---|---|---|
| `0 – 39 999` | **Approved** | safe; the agent may proceed |
| `40 000 – 69 999` | **Escalated** | suspicious; held for the owner to approve/reject |
| `≥ 70 000` | **Blocked** | malicious; rejected outright |

On top of the per-action score the **contract** maintains a per-agent **EMA reputation** (threat
score) and a **strike** counter; an agent that repeatedly trips the firewall is **auto-deactivated**
on-chain. Two safeguards make the score trustworthy:

- **Composite deny floor** — the final score is `max(Claude score, deterministic floor)`, so the
  LLM can never *lower* a verdict below hard signals (known scam target, prompt-injection markers,
  spend-limit breach).
- **Real-transaction scoring** — the analyzer decodes the actual PTB and scores the packages it
  truly calls and the real `SplitCoins` amounts, not the self-declared `targetProgram` / `value`.

## Architecture (NestJS modules)

```
levi-relayer/
├── src/
│   ├── main.ts                     # bootstrap (Fastify) + CORS + Swagger + global pipe/guards/filter
│   ├── app.module.ts               # root: feature modules + global RateLimit/ApiKey guards
│   ├── config/                     # ConfigModule + RelayerConfig (RELAYER_CONFIG token)
│   ├── common/                     # levi-sdk re-export · logger · exception filter · guards · view util
│   ├── sui/                        # SuiService: client+signer, sponsored tx, assertSponsorable, dryRun, verdict
│   ├── analyzer/                   # AnalyzerService (rule-based / Claude+floor), KnowledgeBaseService, ptb util
│   ├── store/                      # RelayerStore (RELAYER_STORE) + JsonStore
│   ├── engine/                     # EngineService: decrypt→verify→analyze→verdict→persist
│   ├── watcher/                    # WatcherService: OnApplicationBootstrap poller (backstop for the sync path)
│   └── api/                        # controllers: system · agents · actions · reasoning · escalation · stats · health
├── client/protect.ts              # agent-side protect() — the SDK an agent embeds
├── scripts/                        # set-encryption-key · check-sponsored · demo-agent
├── data/knowledge-base.json        # scam targets / injection markers (state.json is gitignored)
└── test/                           # *.spec.ts (offline) + e2e.spec.ts (gated, testnet)
```

**Toolchain:** TypeScript + NestJS 11 (Fastify), CommonJS. Runtime + scripts run via
`@swc-node/register` (transpiles the sibling `sui-contract/sdk` TS and emits decorator metadata
for Nest DI). Tests run on **Vitest** with `unplugin-swc`. No database — see [Storage](#storage).

## HTTP API

All routes are under the `/api/v1` prefix except `/health`. Interactive docs at **`/docs`**.

| Method + path | Purpose |
|---|---|
| `GET /health` | liveness (outside the `/api/v1` prefix) |
| `GET /api/v1/system/config` | relayer x25519 pubkey, package/config/registry IDs, thresholds |
| `GET /api/v1/agents/check-registration?agentAddress=` | read AgentRegistry on-chain |
| `POST /api/v1/actions/build-submit` | unsigned, gas-sponsored `submit_action` tx |
| `POST /api/v1/actions/submit` | assert + dry-run + co-sign gas + broadcast + **synchronous verdict** |
| `GET /api/v1/actions/:id` | status / decision / reasoning (poll) |
| `GET /api/v1/reasoning/:hash` | full reasoning text (on-chain stores only the hash) |
| `POST /api/v1/actions/:id/build-approve` \| `build-reject` | unsigned owner-signed escalation tx |
| `POST /api/v1/actions/:id/resolve` | broadcast the owner-signed approve/reject |
| `GET /api/v1/stats` | dashboard: aggregate verdict/agent counts |
| `GET /api/v1/actions` | dashboard: list actions (filter by `agentId`/`decision`, paginated) |
| `GET /api/v1/agents` | dashboard: agents seen by the relayer + on-chain reputation |
| `GET /api/v1/agents/:id` | dashboard: full on-chain agent detail (reputation, stats, allow-list) |
| `POST /api/v1/agents/build-register` | owner self-service: unsigned, gas-sponsored `register_agent` tx |
| `POST /api/v1/agents/:id/build-activate` \| `build-deactivate` | unsigned agent lifecycle tx (owner-signed) |
| `POST /api/v1/agents/:id/build-update-target` | unsigned `update_agent_program_target` tx (toggle allow-list) |
| `POST /api/v1/agents/execute` | assert + dry-run + co-sign gas + broadcast an owner-signed management tx |

**Build → sign → execute** pattern (escalation & owner-management): the relayer builds an unsigned
tx (`sender = owner`, `gas = relayer`), the owner signs it in the browser (`@mysten/dapp-kit`), then
the `resolve` / `execute` endpoint validates it (only the whitelisted instructions are sponsorable),
dry-runs, co-signs gas, and broadcasts. `agents/execute` returns the new `agentId` after a register.

**Auth:** write (`POST`) routes require the `x-api-key` header when `RELAYER_API_KEY` is set; read
(`GET`) routes are public. **Swagger** (`/docs`) has an `x-api-key` "Authorize" button.
**CORS** is enabled — pin origins with `CORS_ORIGINS`, otherwise any origin is reflected (dev).

## Configuration

Copy `.env.example` → `.env` and fill it in.

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPERATOR_SECRET_KEY` | ✅ | — | Relayer Sui signer (Bech32 `suiprivkey1…`). **Must hold the `RelayerCap`** (deployer wallet `0x0c8b…`). Gas sponsor for all sponsored txs. |
| `RELAYER_X25519_SECRET` | ✅¹ | — | 32-byte x25519 secret (hex). Its public key is published on-chain as `Config.relayer_encryption_key`. Generated + set by `npm run set-key`. |
| `ANTHROPIC_API_KEY` | ➖ | — | Claude analyzer key. **If unset, falls back to the offline rule-based analyzer** (also on any API error). |
| `RELAYER_API_KEY` | ➖ | — | If set, `POST` routes require it in `x-api-key`. Unset = writes are open (a warning is logged); fine for local dev/demo. |
| `SUI_RPC_URL` | ➖ | testnet fullnode | Sui RPC endpoint. |
| `POLL_INTERVAL_MS` | ➖ | `4000` | Watcher poll interval for `ActionSubmitted`. |
| `PORT` | ➖ | `8787` | HTTP bind port. |
| `PUBLIC_BASE_URL` | ➖ | `http://localhost:<PORT>` | Used only to build escalation/review links (not the bind port). |
| `RATE_LIMIT_MAX` | ➖ | `120` | Per-IP requests per window. |
| `RATE_LIMIT_WINDOW_MS` | ➖ | `60000` | Rate-limit window. |
| `CORS_ORIGINS` | ➖ | reflect any | Comma-separated allowed origins for the dashboard. Pin in production. |

¹ Not needed just to build/run the typecheck & offline tests; required to actually decrypt intents.

## Setup & run

**Prerequisites:** Node.js ≥ 18 and npm. A funded relayer wallet holding the `RelayerCap` (for the
chain-touching steps). The `../sui-contract` package deployed (see its `DEPLOYMENT.testnet.md`).

```bash
cd levi-relayer
npm install
cp .env.example .env          # fill in OPERATOR_SECRET_KEY (+ ANTHROPIC_API_KEY for real LLM scoring)

npm run build                 # typecheck (tsc --noEmit)
npm test                      # offline test suite (no key/network) — the parity gate

npm run set-key               # generate the relayer x25519 key + publish the pubkey on-chain (once)
npm run start                 # boot the HTTP API + ActionSubmitted watcher
npm run demo                  # end-to-end: Approved + Escalated + Blocked against the live contract
```

After boot, sanity-check: `curl localhost:8787/health` and open `http://localhost:8787/docs`.

End-to-end on testnet (opt-in): `RUN_E2E=1 npx vitest run test/e2e.spec.ts`.

> ⚠️ After `npm run set-key`, do **not** run the `sui-contract` e2e suite — it overwrites the
> on-chain encryption key and would desync the relayer.

### npm scripts

| Script | What it does |
|---|---|
| `npm run build` / `npm run typecheck` | `tsc --noEmit` typecheck |
| `npm start` | boot the API + watcher (`@swc-node/register`) |
| `npm run start:dev` | same, with `--watch` reload |
| `npm test` | offline Vitest suite (the parity gate) |
| `npm run set-key` | generate x25519 key + publish pubkey on-chain (once) |
| `npm run check-sponsored` | inspect the sponsor wallet's gas coins |
| `npm run demo` | full agent flow against the live contract (Approved / Escalated / Blocked) |

## Storage

There is **no database**. The relayer keeps a small JSON state file at `data/state.json`
(`JsonStore`) holding the watcher cursor and per-action records (decision + reasoning). The
on-chain contract is the source of truth for everything that matters (registry, reputation,
action lifecycle); the JSON file is just an off-chain convenience cache for reasoning text and the
dashboard. It is gitignored and safe to delete (it rebuilds from the watcher). The
`data/knowledge-base.json` file (scam targets / prompt-injection markers) *is* committed and feeds
the deterministic analyzer.

## Firewall security guarantees (preserved from the original)

- **Sponsor guard (C1) + dry-run (N1):** `SuiService.assertSponsorable` only co-signs the exact
  instructions the backend builds (right gas owner, single allowed moveCall, capped budget), then
  `dryRunSponsored` refuses to pay gas for a tx that would abort — no gas drain.
- **Deterministic deny floor (C2):** `CompositeAnalyzer = max(Claude, hardDenyFloor)` — the LLM can
  never lower the verdict below scam-target / prompt-injection / over-spend-limit signals.
- **No declared-target/value spoofing (M1/L2):** the analyzer scores the packages the decoded PTB
  actually calls and the real `SplitCoins` amounts, not just the declared fields.
- **Integrity guard:** decrypt failure / commitment mismatch / undecodable payload → Blocked.
- **Auth + rate-limit (N2):** `ApiKeyGuard` (x-api-key on POST when `RELAYER_API_KEY` set) +
  per-IP `RateLimitGuard`.
- **Idempotent + race-safe:** verdict only when `status == pending`; concurrent API + watcher
  processing collapsed in the engine; the contract is the final backstop.

## Decisions

- LLM: **Claude Opus 4.8** (`claude-opus-4-8`) via forced tool-use; offline rule-based fallback
  when `ANTHROPIC_API_KEY` is unset (and on any API error).
- Relayer wallet `0x0c8b…` = gas sponsor + RelayerCap holder.
- Targets the testnet deployment in `../sui-contract/DEPLOYMENT.testnet.md`.
