# Primary Research

Before starting a **major/future upgrade** task (not a routine fix), refresh
this list: web-search each area below (AI agent runtimes, other AI
assistants/AI-OS products, model providers, MCP/A2A, agent security) for
what changed since these URLs were last checked, and fold genuinely new,
verified findings into `RESEARCH_SYNTHESIS_2026.md` and the relevant
`FRIDAY-VISION/AREAS/*` target spec before designing the upgrade. Cite the
source. Don't design a "latest and future-proof" change from memory alone.

**Stale research is not current implementation truth.** A row below tells
you what to go re-check and where it would affect FRIDAY if it changed — it
is not proof that FRIDAY already implements it. Update `last_checked` (and
`applicable_version` if the source versions itself) every time you actually
re-read a source; don't bump the date without reading it.

| Source | Official URL | Type | Last checked | Applicable version | Affected FRIDAY area/contract |
|---|---|---|---|---|---|
| OpenAI Agents SDK | https://openai.github.io/openai-agents-python/ | Official docs | 2026-09 (batch add, not individually re-verified since) | latest at check time | `AREAS/05-AUTONOMY-LEARNING-EVOLUTION`, agent runtime contract |
| OpenAI Agents Guardrails | https://openai.github.io/openai-agents-python/guardrails/ | Official docs | 2026-09 | latest at check time | `09_SECURITY_GOVERNANCE` approval contract |
| OpenAI Agents Tracing | https://openai.github.io/openai-agents-python/tracing/ | Official docs | 2026-09 | latest at check time | `08_OBSERVABILITY_EVALUATION` |
| OpenAI Agents Tools | https://openai.github.io/openai-agents-python/tools/ | Official docs | 2026-09 | latest at check time | `05_CAPABILITY_FABRIC` |
| OpenAI Agents Testing | https://openai.github.io/openai-agents-python/testing/ | Official docs | 2026-09 | latest at check time | `11_TESTING_RELEASE` |
| Anthropic Context Engineering | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | Official blog | 2026-09 | n/a (article) | `03_INTELLIGENCE_FABRIC` context/routing |
| MCP | https://modelcontextprotocol.io/ | Protocol spec | 2026-09 | check current spec version at URL | `05_CAPABILITY_FABRIC` tool discovery, connector layer |
| A2A v1.0 | https://a2a-protocol.org/v1.0.0/ | Protocol spec | 2026-09 | v1.0.0 (pinned in URL — check for newer) | agent-to-agent interop, if/when FRIDAY adds it |
| OpenTelemetry | https://opentelemetry.io/docs/specs/otel/ | Protocol spec | 2026-09 | check current spec version at URL | `08_OBSERVABILITY_EVALUATION` tracing contract |
| NIST AI Agent Standards Initiative | https://www.nist.gov/news-events/news/2026/02/announcing-ai-agent-standards-initiative-interoperable-and-secure | Government announcement | 2026-09 | 2026-02 announcement | `09_SECURITY_GOVERNANCE`, long-term compliance posture |
| OWASP GenAI | https://genai.owasp.org/ | Standards body | 2026-09 | check current revision at URL | `09_SECURITY_GOVERNANCE` threat model |
| Electron Security | https://www.electronjs.org/docs/latest/tutorial/security | Official docs | 2026-09 | tracks Electron "latest" — re-check against FRIDAY's pinned Electron version | `electron/` sandbox, preload allowlist, `07_EXECUTION_VERIFICATION` |
| GitHub Immutable Releases | https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases | Official docs | 2026-09 | current GitHub feature state | `.github/workflows/`, release/build boundary |

When a row's finding actually changes a FRIDAY contract, update the row's
`Last checked` date **and** the target file in the "Affected" column in the
same change — don't let this table drift from the specs it points at.
