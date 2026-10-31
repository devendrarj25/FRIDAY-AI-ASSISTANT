# FRIDAY — Brain Benchmark

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

How FRIDAY's Brain is measured, what a result is allowed to claim, and what is and is not built. The research behind it is in [FRIDAY_BRAIN_INTELLIGENCE_RESEARCH.md](FRIDAY_BRAIN_INTELLIGENCE_RESEARCH.md) and the gaps in [FRIDAY_BRAIN_GAP_ANALYSIS.md](FRIDAY_BRAIN_GAP_ANALYSIS.md). No score is quoted here: nothing in this document has been measured against a real model.

## 1. Rules of a result

- **One owner.** The suites live in `src/lib/friday/self/eval-suites.ts`, the arithmetic in `eval-stats.ts`, fixtures and stored results in `eval-fixtures.ts`. `eval-harness.ts`, `instruction-eval.ts` and `intelligence-benchmark.ts` stay and report through the same statistics. There is no second harness and no telemetry backend.
- **Two paths, never mixed.** The offline path is deterministic: stub models, no network, no clock, no provider, part of the ordinary tests. The external path (GAIA, STATE-Bench, SWE-bench Verified, OSWorld, WebArena, FrontierMemory) is run by the owner on named hardware with a spend cap, with data and results kept outside the repository and outside `<FRIDAY_ROOT>`. It is not built here and nothing in `npm test` can start it.
- **Deterministic scoring first.** Exact checks, parsed values, execution. A judge model is the exception: a different model from the one tested, rubric stored with the fixture, judge id and version recorded, never used for a security gate.
- **Repeat.** Stochastic categories run up to five times. Report pass@1 (mean over runs), pass@k (any run) and pass^k (every run); a model that sometimes succeeds is not a model that reliably succeeds.
- **Say how sure.** Every rate comes with a 95% Wilson interval and its sample count. Two configurations are compared on the same tasks with an exact McNemar test. A category of ten tasks is diagnostic only; a claim needs a domain with at least 50 task-runs.
- **No first-run tuning.** The first blind figure of a held-out set is the one reported; tasks added after seeing a failure join the development set.

## 2. Domains and weights

Twelve domains, weights adding to 100 (`DOMAIN_WEIGHTS`): cognitive 12, deep thinking 8, memory 10, learning 8, multi-model 8, agents 12, coding 10, research 8, computer use 7, multimodal 5, self-development 5, reliability and security 7. `brainScore` sums only the domains that have at least `MIN_DOMAIN_RUNS` (50) task-runs, scales to the weight that was scored, gives an interval, and lists the unscored weight; it never redistributes it.

## 3. Security gates

A gate is an exact count that must be zero and is never averaged into a score. `runGateSuite` reads the real code: every protected policy file is refused at every dial, a change verdict never applies, Stop everything refuses, a fresh install is Balanced and, when a node-side caller supplies `config/kernel.yaml`, `auto_approve_exec` is false. A gate that could not be read is listed as not checked, never as passed. The privacy firewall, billing firewall and token authority are gated by their own tests (`kernel/tests`, `core/__tests__`); folding them into one report is still open. A stored result with any gate failure is not accepted whatever its score (`accepted`).

## 4. Fixtures and results

A fixture (`Fixture`) has an id, a domain, a category, an input and one line saying what a pass is. `validateFixtures` rejects duplicates, unknown domains and fixtures nobody could audit; `hashFixtures` names exactly which tasks a result used. A stored result (`StoredResult`) carries the record (benchmark version, fixture hash, configuration A to D, commit, models, hardware, seed, k, limitations), the domain counts, the gate failures and notes. The last twenty are kept in local state.

## 5. Measuring what a stage is worth

`withStagesOff` runs a turn with one optional stage off (`world-insight`, `meta-review`, `vector-index`, `knowledge-recall`, `memory-retrieve`, `context-recall`); `runAblation` runs the same fixtures with and without it and returns the paired difference. Everything is on by default, nothing is stored, no safety stage is listed. A first use already found that one stored fact reaches the model by four routes, so switching one off changes nothing: the verdict "no measurable effect" is a result, not a failure.

## 6. Tool choice and arguments

`kernel/tests/test_tool_choice_suite.py` scores, with no model, whether the right tool is in the planner's short list for English and Hinglish requests and whether every declared tool schema accepts a well-formed call and names each broken one. The kernel now checks a model's arguments against the declared schema before running a read-only tool (`validate_args`) and returns the problems as plain text so the model can retry.

## 7. Trace

`run-trace.ts` builds a redacted per-turn record (stage names, milliseconds, failed flag) from the existing stage clocks. The desktop sends the turn's `runId` to the kernel; `kernel/run_trace.py` writes one JSON line per event to `<FRIDAY_ROOT>/logs/run-trace.jsonl` only when `FRIDAY_RUN_TRACE=1`, with only ids, model ids, counts and milliseconds. No prompt, answer, argument, path or key is ever written, there is no exporter and no network. This is the local-file use of the recorded OpenTelemetry decision; the exporter stays rejected.

## 8. Learning and self-development

Five things are kept apart: a knowledge update, a memory change, a skill, a prompt or routing tuning, and weight training. Memory is not training. `promotionVerdict` says whether a learned change may replace what it came from: held-out tasks not worse and at least one gained, no significant regression, no gate failure; it is advice, nothing is applied. `mineFailurePatterns` groups repeated task failures by fingerprint and files each once for review through the existing limitation loop. `devCheckRequest` builds the exact `dev.check` call for a proposal (never for a protected file) and `devCheckAllows` reads its verdict; the run itself is an exec-tier tool the owner approves.

## 9. Not built

The task fixtures for all 74 planned categories (only the retrieval, routing, long-horizon, tool-choice, recall and gate fixtures exist), an automatic A/B run of `main` against a branch, every external benchmark, a judge-model path, a single sound-and-picture pass, realtime multimodal and a real adapter training run. `FRIDAY_STATE.md` lists them under Next priorities.
