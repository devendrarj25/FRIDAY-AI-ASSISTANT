# FRIDAY — Change Control

This is the only change gate. A task is classified, bounded, implemented in
the existing owner, and reported as PASS or BLOCK from command output.

## Gate

TASK, then ROUTE, then OWNER, then DEPENDENCY CHECK, then SCOPE CHECK, then
SECURITY/BOUNDARY CHECK, then FOCUSED TESTS, then REGRESSION TESTS, then
DIFF/EVIDENCE, then PASS or BLOCK.

1. Classify the request with the table below. Write a short task id.
2. Name the canonical owner. Do not add a second router, store, installer, or scheduler.
3. List the files that may change, and the locked files that may not.
4. Read callers before editing. If a file outside the list is required, add it to the list first.
5. Make the smallest change that delivers the behaviour.
6. Run the tests that cover that owner.
7. If more than one subsystem is crossed, test both sides.
8. Run the wider suite when the surface warrants it.
9. Update the owning document and `FRIDAY_STATE.md` with the same change.
10. Stop. Do not refactor an area that was only nearby.
11. Report PASS or BLOCK, the commands, and the counts.

## Task packet

| Field | What it holds |
| --- | --- |
| TASK_ID | Short slug for this change |
| CANONICAL_OWNER | The existing module that already owns the behaviour |
| ALLOWED_FILES | Every file the change may edit |
| FORBIDDEN_FILES | Locked paths and anything outside the boundary |
| DIRECT_DEPENDENCIES | Callers of those files |
| AFFECTED_BOUNDARIES | Runtime, build, installer, updater, memory, routing, capabilities, or UI |
| REQUIRED_TESTS | The test files that must stay green |
| ROLLBACK_PLAN | How to undo the diff |
| EVIDENCE | Commands and counts after the change |

More than one boundary is high-impact: analyse both sides and add the tests each side would otherwise miss.

A change loads a compact packet: the task statement, the owner, the direct dependencies, the tests, the contract, the constraints, and the verification. Prefer an index over the whole tree. Read a full file only when it is the owner or it is being edited. Read a neighbour only for an import, a type, a lifecycle, or a test. Stop once ownership and the direct dependencies are known. Confidence order is exact, then high, then medium, then a broad search. A low confidence means search before editing.

## Route

| Signal | Owner area |
| --- | --- |
| model, provider, fallback, cost, latency | `kernel/router.py` and `electron/model-access.cjs` |
| memory, recall, personalization | `src/lib/friday/self/memory-engine.ts` |
| agent, handoff, worker | `src/lib/friday/self/agent-scheduler.ts` |
| tool, skill, plugin, module, connector | capability trees and `electron/` registries |
| screen, device, app action | `src/lib/friday/self/computer-use.ts` |
| permission, privacy, secret | autonomy, governance, and `safeStorage` |
| task, resume, retry, checkpoint | `src/lib/friday/self/task-graph.ts` |
| chat, voice, realtime | the existing chat and Auto session |
| build, installer, update | the existing pack, installer, and updater |
| self-learning | the existing learning and governance queue |

## Contracts in the product

These behaviours live in `src/lib/friday/self/run-receipt.ts` and are called from the task graph, the desktop loop, and the agent scheduler. `resolveKnowledgeClash` lives in the memory engine.

| Contract | Rule |
| --- | --- |
| Runtime event | Versioned envelope. Secret keys are dropped or refused. Extra fields are tolerated. |
| Durable outcome | A model or tool saying done is not success. A checked observation is required. Exhausted retries quarantine and do not claim success. |
| Approval | Bound to task, action, argument hash, target, data class, risk, expiry, one use, and approver. Revalidated immediately before the side effect. |
| Child authority | A child cannot add capabilities, network, or spend beyond the parent. |
| Capability phase | Registered is not healthy. Healthy is not authorized. Authorized is not execution. |
| Evaluation | Completion, facts, tools, authorization, verification, latency, tokens, cost, recovery, and user control. Deterministic. No provider call. |
| Knowledge clash | A contradiction is kept as two rows unless an explicit correction may supersede. A first-run row is protected. |
| Execution chain | Turn, conversation, task, plan, route, capability, capability version, action, artifact, trace, result, and a passed verification. Chat and voice share the conversation id. Mobile is not a second store. An incomplete chain stays unverified. A failed tool keeps the task only when a scoped substitute is waiting. |
| Route decision | Selected path, policy version, and confidence. Private reasoning is refused. An unscoped id is not selected. A retired capability is not routed. |
| Artifact | Id, type, mime, path, generator, checksum, size, sensitivity, and a passed validation. A failed preview is not a valid file. |
| Self-change | Files, tests, and rollback are required. A direct promotion is refused. The apply stays sandboxed on the existing pipeline. |
| Resource admission | Extra concurrency is refused, then quality is reduced, before a safety break. |
| Failure domain | Model, tool, browser, device, network, task, and artifact share one classifier. Disk-full, permission, clock, and corrupt faults do not retry. |
| Policy root | The owner policy text and version are fixed. A replaced text, a different version, or a mismatched hash fails closed before a privileged action. |
| Capability life | Active needs health and authority. Quarantine does not execute and stays reversible. Retirement keeps the record and is not routed. |
| Side effect | A payment, deletion, uninstall, credential, or system change with an unknown outcome waits for reconciliation. It is not retried blind. |
| External text | Page, file, tool, and model text stay data. A line that tries to set the system prompt, policy, or permission is dropped. |
| Control plane | A closed control plane blocks privileged work. Read-only work may continue. An unapproved privileged request does not run. |
| System state | A lifecycle jump names an actor, a cause, and evidence. An invalid jump is refused. The task graph does not keep a second state store. |

## Planes

The live spine is the 17 layers in `src/lib/friday/flow-chart.ts`. These planes name the same owners. They are not a second map and not permission to move files.

| Plane | Owner |
| --- | --- |
| Experience | `src/lib/friday/navigation.ts` |
| Cognition | `src/lib/friday/brain/cognitive-baseline.ts` |
| Task | `src/lib/friday/self/task-graph.ts` and `kernel/planner.py` |
| Intelligence | `electron/model-router.cjs` |
| Agents | `src/lib/friday/self/agent-scheduler.ts` |
| Capability | the existing tool, skill, and module registries |
| Authority | `kernel/authority.py` |
| Execution | `kernel/tools.py` |
| Verification | a checked postcondition on the task graph |
| Memory | `src/lib/friday/self/memory-engine.ts` |
| Lifecycle | the existing installer and updater |
| Observability | the existing task log |

A model response is not proof of an external effect. Load only the owner for the task. The product version lives only in `config/friday-version.json`.

## Validation states

SOURCE_READY means this checkout passes typecheck, lint, unit tests, and the docs registry. A missing installer is not a source failure. BUILD_READY means a Windows NSIS install, boot, and uninstall actually ran. A Linux run does not report BUILD_READY.

The tool floor lives in `config/toolchain-versions.json`. A brain change re-runs brain, retrieval, and memory tests. A tool change re-runs authority, execution, and verification. A lifecycle change re-runs install, update, and recovery tests.

## Research decisions

Recorded once, from documentation read between 2026-09 and 2026-10-20. ADOPT means it is in FRIDAY, ADAPT means the idea is used inside an existing module, and REJECT means it is not added.

| Source | Decision | Reason |
| --- | --- | --- |
| [OpenTelemetry logs data model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) | ADAPT | A versioned event name plus a timestamp fits the existing task log. A second telemetry backend does not. |
| [OpenTelemetry GenAI spans](https://github.com/open-telemetry/semantic-conventions/blob/v1.37.0/docs/gen-ai/gen-ai-spans.md) | ADAPT | Model and tool faults share the existing task log; no collector. |
| [Temporal workflow execution](https://docs.temporal.io/workflow-execution) | ADAPT | Checkpoints, idempotency, and bounded retry already live on the task graph. A hosted workflow server does not fit a local-first app. |
| [NIST NCCoE agent identity concept paper](https://www.nccoe.nist.gov/sites/default/files/2026-02/accelerating-the-adoption-of-software-and-ai-agent-identity-and-authorization-concept-paper.pdf) | ADOPT | Least privilege: a grant is scoped, expiring, and rechecked, and a child cannot widen the parent. |
| [NIST on agent identity](https://www.nist.gov/blogs/cybersecurity-insights/back-future-why-agentic-ai-needs-strong-identity-foundation) | ADAPT | Attenuate authority as it is delegated. No hosted identity provider. |
| [CALM-MAS](https://dl.acm.org/doi/10.1145/3838177.3841735) | ADAPT | Lower concurrency and quality before a safety break; no second serving stack. |
| [Cognitive admission control](https://arxiv.org/abs/2609.16313) | ADAPT | A privileged action with missing evidence does not run. |
| [MCP](https://modelcontextprotocol.io/) | ADAPT | A connector stays under FRIDAY authority. |
| A2A v1.0 | REJECT | No second agent protocol. |
| [OWASP GenAI](https://genai.owasp.org/) and [prompt injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) | ADOPT | Model output, heard speech, and page text stay data. Tool approval stays in application code. No second guard model. |
| [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) | ADOPT | Resolve the host, then refuse private, loopback, and link-local addresses. Tests inject the resolver; production calls `socket.getaddrinfo`. |
| [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) | ADOPT | contextIsolation, sandbox, IPC sender checks, and navigation limits stay the bar. The CSP header is sent report-only on `friday://` and the dev session; enforcing mode is the owner's decision (`FRIDAY_CSP_ENFORCE=1`). |
| [Electron webContents unresponsive](https://www.electronjs.org/docs/latest/api/web-contents) | ADAPT | After a grace period the lifecycle owner calls `reload()`. `forcefullyCrashRenderer` is not used and no owned process is killed. |
| [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/) | ADOPT | Startup and shutdown use one lifespan, and one shared HTTP client lives for the kernel lifetime in `kernel/router.py`. |
| [Ruff](https://docs.astral.sh/ruff/) | ADOPT | One dev-only linter and formatter for the kernel, including bandit rules (`ruff>=0.15.0` in `kernel/requirements-dev.txt`, MIT, about 23 MB, not packaged). |
| [Pyright](https://microsoft.github.io/pyright/) | ADAPT | Basic mode; dev-only `pyright>=1.1.400` (MIT, about 6 MB, not packaged). `kernel/pyright-baseline.txt` is a ceiling that may only shrink. A missing tool fails when `CI`, `GITHUB_ACTIONS`, or `FRIDAY_PYRIGHT_STRICT` is set; a workstation may skip with a loud line. |
| [Knip](https://knip.dev/) and [Madge](https://github.com/pahen/madge) | ADAPT | Dev-only dead-export and cycle checks. A finding is fixed in the existing modules and removed only when no caller remains. |
| [npm audit](https://docs.npmjs.com/cli/v10/commands/npm-audit) and [pip-audit](https://pypi.org/project/pip-audit/) | ADOPT | High, critical, and unknown severity fail unless `config/advisory-allow.json` lists the id and its expiry is still ahead of the injected clock. Moderate and low warn. pip-audit stays dev-only. |
| [Dependabot groups](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file#groups) | ADOPT | The monthly wildcard group per ecosystem stays; majors stay ignored. |
| [GitHub secret scanning](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning) | ADOPT | The existing secret-scan workflow stays; no second scanner. |
| [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use) and [security roadmap](https://github.blog/news-insights/product-news/whats-coming-to-our-github-actions-2026-security-roadmap/) | ADOPT | Least privilege, a job timeout, and pinned third-party images stay inside the existing eleven workflows. |
| [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) | ADAPT | Release artifacts stay integrity-checked in the existing publish path. |
| [React hooks eslint](https://react.dev/reference/eslint-plugin-react-hooks) | ADOPT | The five compiler rules and `exhaustive-deps` are errors: state is derived, an effect subscribes, and a ref is not read while rendering. |
| [AbortSignal.reason](https://nodejs.org/api/globals.html#abortsignalreason) | ADOPT | A download pause or cancel rejects with code `PAUSE` or `CANCEL` and message `paused` or `cancelled`. |
| Realtime voice APIs (voice activity detection and conversation items) | ADAPT | Wait longer on an unfinished utterance, drop a duplicate final transcript, keep the text already shown on barge-in, and never insert one item twice. The hosted API is not added. |
| Generated SBOM | REJECT | A hash mismatch already fails closed; a bill-of-materials generator is future work in `docs/FRIDAY_BUILD_AND_RELEASE.md`. |
| MSIX, and Bedrock, Foundry, and Vertex providers | REJECT for now | MSIX stays a future channel (NSIS remains primary); the three cloud hosts need the owner's own accounts (`docs/FRIDAY_PROVIDERS_AND_SECRETS.md`). |

## Definition of done

A change is done when the behaviour exists in the canonical owner, a test from this change passes, the owning document matches the code, and PASS is backed by command output. A written plan is not done. Windows install, boot, microphone, and hosted Actions stay unverified until a Windows run or the owner's PC shows them.
