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

## 9. The category bank and its coverage

`src/lib/friday/self/benchmark-bank.ts` lists all 77 categories of the twelve domains and says where each is checked: **44 are scored in the app** (367 fixtures, no model, no network, one boolean per fixture), 24 by a named test file the app cannot import (kernel, main process, existing suites), 7 need a real model, none now needs a desktop (target selection is scored on recorded UI trees) and 2 belong to an outside benchmark. `coverage()` gives those counts per domain so the number of categories never hides how many can be scored today; a test checks that every pointer names a file that exists. Rules that must always hold are exact (every fixture passes); categories derived from the eval harness (157 tasks, `eval-harness.ts`) have a floor (0.8) instead, because they are measured rates. The Brain check panel runs the bank and shows each domain's tasks with its interval. Building the bank found and fixed five real faults: a question that merely contained the word "build" or "install" was routed as an action, "ignore all previous instructions" was not recognised as injected screen text, `Authorization: Bearer <token>` leaked the token through the secret scrub, nothing checked an answer for claiming to be human, and "what was the old plan" was not read as a question about the past.

## 10. One gate report

`core/__tests__/helpers/release-gates.ts` builds a single report from three places: the renderer's gate suite, the main process (sensitive content never goes automatically to a cloud model, local models keep data on the PC, a paid or unknown-cost model is blocked until allowed, a remembered allow never weakens write or exec, a deny wins, authorizations are single-use and bound to their arguments) and the kernel (its authority, privacy and billing tests, run as a child process when Python and the kernel's packages are present; otherwise listed as not checked). `core/__tests__/release-gates.test.ts` fails if any gate fails.

## 11. Comparing two versions

`node scripts/brain-ab.cjs <refA> <refB>` checks each git ref out as a throwaway worktree outside the repository, runs the bank in both, and compares category by category and task by task with the exact paired test. It changes nothing in the repository and uses no model or network. A ref that does not contain the bank cannot be compared and the script says so: `origin/main` cannot be compared with this branch until this branch is merged, after which any two later refs can.

## 12. The outside benchmarks

`src/lib/friday/self/external-eval.ts` holds, for GAIA, STATE-Bench, SWE-bench Verified, OSWorld, WebArena and FrontierMemory, what each needs (licence as read, gated data, keys, Docker, a virtual machine, the hardware its own page names). `checkExternalSetup` refuses a run whose data or results sit inside the repository or FRIDAY's own data, with no spend cap, with no key, without Docker or a virtual machine where needed, or without the dataset terms accepted. `runWithBudget` stops before the task that would pass the cap and marks the result partial. `judgeAnswer` grades against a stored rubric, refuses a judge that is the model under test, records the judge's id and version, keeps one evidence line per criterion and rejects a malformed reply; `judgeAgreement` gives Cohen's kappa against a deterministic check. None of it calls a model: running an outside benchmark needs the owner's keys, a spend cap and accepted terms, and has not been done.

## 13. Not built

An actual run of any outside benchmark, a judge run on a real model, a single sound-and-picture pass, realtime multimodal, a real adapter training run, a cross-encoder model for the reranker hook, and fixtures for the 7 categories that need a model. The reranker hook stays a synchronous function; the embedding re-order added later runs in the kernel instead (see FRIDAY_FEATURES). `FRIDAY_STATE.md` lists them under Next priorities.

## 14. Held-out rounds, and what the 2026-11-18 round showed

The error-diagnosis category is the one bank category below 100%, so it is where a real gap shows. It is also the category the held-out rule protects most: its development tasks always pass, so a mixed rate hides the blind one. The first blind figure of each batch is kept, never tuned up (`eval-harness.ts` holds every batch; a batch is held out until its failures are fixed, then joins the development set):

| Batch   | Written                                         | First blind figure (Wilson 95%)                            | Status                            |
| ------- | ----------------------------------------------- | ---------------------------------------------------------- | --------------------------------- |
| h4 (12) | before any rule for its classes                 | 1 of 12 (1% to 35%)                                        | fixed 2026-11-18, now development |
| h5 (22) | 2026-11-18, before any rule for it              | 18 of 22 (61% to 93%)                                      | fixed 2026-11-18, now development |
| h6 (26) | 2026-11-18, **not run until the rules existed** | 16 of 26 (43% to 78%), the same before and after the rules | **held out**, 10 silent           |

**What was wrong.** Diagnosis is a list of rules, each naming a tool's own words. An error that matches none is answered "I could not recognise this one" (silent, which the grader scores as a miss). 15 of the 34 h4 and h5 tasks missed: 14 were silent and one was wrong with confidence: the older Node wording `Unexpected token < in JSON at position 0` was read as broken code by the generic syntax rule instead of the HTML-answer rule. Three tasks the older keyword matcher passed, the new engine failed (npm `ENOENT`, pip hashes, and exit 137, which the old one reached only through a loose out-of-memory entry); they are fixed too.

**What changed** (`src/lib/friday/brain/error-intelligence.ts`): eleven rules for families that had none (git outside a repository, download integrity mismatch for Go, npm and pip, an unsatisfiable version for Cargo, npm and pip, a missing database table, CommonJS and ES module mixing, an invalid React hook call, a database login refused, a process killed (137 or OOMKilled), invalid YAML, a failed test assertion, too many open files), the syntax rule no longer claims a JSON parse failure, npm's bare `ENOENT` joins the missing-path rule, and Java's PKIX certificate error joins the untrusted-chain rule. Each test names words, not a broad class, and an error that matches none is still reported as not recognised. `core/__tests__/error-intelligence-families.test.ts` pins every family in more than one ecosystem, what must not match, and the ordering.

**Measured, same 367 fixtures, offline, no model** (`node scripts/brain-ab.cjs <ref before> <ref after>`, the before ref holds the old engine and the same fixtures):

|                                  | Before                       | After                                                                                      |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| Bank, app-scored fixtures passed | 342 of 367                   | 357 of 367                                                                                 |
| error-diagnosis                  | 101 of 126 (80%, 72% to 86%) | 116 of 126 (92%, 86% to 96%)                                                               |
| Other 43 app categories          | unchanged                    | unchanged                                                                                  |
| Paired tasks                     |                              | 15 gained, **0 lost**, 342 pass both, 10 fail both (all h6); exact paired test p = 0.00006 |

**What this does and does not show.** The 15 gains are exactly the h4 and h5 failures the rules were written for, so they are development gains, not generalisation. The blind check is h6, written before the rules and unchanged by them (16 of 26 both times): hand-written rules fix the families they name and nothing else, so each new batch will again find silent families. The honest standing figure for an error FRIDAY has no rule for is therefore the blind first figures, 34 of 48 over h5 and h6 (71%, 57% to 82%), not the 100% development rate and not the category's 92%. The 10 h6 misses (circular import, `charmap` encoding, `window is not defined`, React missing key, `ECONNRESET`, PowerShell `ConvertFrom-Json`, Docker port allocated, Docker pull denied, Kubernetes `CrashLoopBackOff`, a missing MSVC build tool) are left as they are for the next round. None of this is a statement about model quality: the stand-in is not a model, and the numbers measure the rules around one.

**Verified counts.** The registry, not prose, is the source: `CATEGORIES` has 77 categories, 44 backed by the app, 24 by named tests, 7 needing a model, 2 external. The implementation roadmap's "75 categories, 41 scored" was an older count and is corrected.
