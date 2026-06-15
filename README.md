# Levi Relayer (off-chain, NestJS)

The off-chain security firewall for the Levi Sui contract — a **NestJS** service that watches
`ActionSubmitted`, decrypts each agent's intent, scores it (Claude Opus 4.8 / rule-based),
and lands a verdict on-chain via `verdict_action`. Lives parallel to `../sui-contract` and
reuses its SDK's crypto / types / constants.

> Ported from the original plain-TypeScript service to NestJS (Fastify adapter). Same
> behavior and the same security guards, proven by the test suite (parity gate).

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
 escalation (if Escalated): owner signs build-approve/reject ────▶ approve/reject_action
```

The agent never touches chain directly and pays no gas (backend sponsors via Sui sponsored
transactions); the contract's `sender == agent_wallet` check still holds.

## Architecture (NestJS modules)

```
levi-relayer/
├── src/
│   ├── main.ts                     # bootstrap (Fastify) + global pipe/guards/filter
│   ├── app.module.ts               # root: feature modules + global RateLimit/ApiKey guards
│   ├── config/                     # ConfigModule + RelayerConfig (RELAYER_CONFIG token)
│   ├── common/                     # levi-sdk re-export · logger · exception filter · guards · view util
│   ├── sui/                        # SuiService: client+signer, sponsored tx, assertSponsorable, dryRun, verdict
│   ├── analyzer/                   # AnalyzerService (rule-based / Claude+floor), KnowledgeBaseService, ptb util
│   ├── store/                      # RelayerStore (RELAYER_STORE) + JsonStore
│   ├── engine/                     # EngineService: decrypt→verify→analyze→verdict→persist
│   ├── watcher/                    # WatcherService: OnApplicationBootstrap poller
│   └── api/                        # controllers: system · agents · actions · reasoning · escalation · health
├── client/protect.ts              # agent-side protect()
├── scripts/                        # set-encryption-key · check-sponsored · demo-agent
├── data/knowledge-base.json
└── test/                           # *.spec.ts (offline) + e2e.spec.ts (gated)
```

**Toolchain:** TypeScript + NestJS 11 (Fastify), CommonJS. Runtime + scripts run via
`@swc-node/register` (transpiles the sibling `sui-contract/sdk` TS and emits decorator
metadata for Nest DI). Tests run on **Vitest** with `unplugin-swc`.

## HTTP API

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

## Setup & run

```bash
cd levi-relayer
npm install
cp .env.example .env       # set OPERATOR_SECRET_KEY (wallet 0x0c8b…, holds RelayerCap)
npm run build              # tsc --noEmit (typecheck)
npm test                   # offline tests (no key/network) — the parity gate

npm run set-key            # generate relayer x25519 key + publish pubkey on-chain (once)
npm run start              # boot HTTP API + ActionSubmitted watcher
npm run demo               # protect() a clean intent (→Approved) + a malicious one (→Blocked)
```

End-to-end on testnet (opt-in): `RUN_E2E=1 npx vitest run test/e2e.spec.ts`.

> ⚠️ After `npm run set-key`, do **not** run the sui-contract e2e suite — it overwrites the
> on-chain encryption key and would desync the relayer.

## Firewall security guarantees (preserved from the original)

- **Sponsor guard (C1) + dry-run (N1):** `SuiService.assertSponsorable` only co-signs the exact
  instructions the backend builds (right gas owner, single allowed moveCall, capped budget),
  then `dryRunSponsored` refuses to pay gas for a tx that would abort — no gas drain.
- **Deterministic deny floor (C2):** `CompositeAnalyzer = max(Claude, hardDenyFloor)` — the LLM
  can never lower the verdict below scam-target / prompt-injection / over-spend-limit signals.
- **No declared-target/value spoofing (M1/L2):** the analyzer scores the packages the decoded
  PTB actually calls and the real `SplitCoins` amounts, not just the declared fields.
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
