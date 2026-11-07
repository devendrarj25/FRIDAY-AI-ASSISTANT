# FRIDAY — Skills and Agents

This is the one place that lists every skill and system agent FRIDAY ships, and says how she and her agents use them. The list at the bottom is generated from the manifests on disk by `npm run docs:sync`; do not edit it by hand. Feature-by-feature detail and the research record are in [FRIDAY_FEATURES.md](FRIDAY_FEATURES.md), and the buttons are in [FRIDAY_USER_GUIDE.md](FRIDAY_USER_GUIDE.md).

## How skills work

- A skill is a small pure function that runs in the sandbox: offline, no files, no processes, `safe`, no permission (the four exceptions below ask for one). Every skill listed here ships enabled, except the four that ask for web access or file reading (`web.read`, `web.search`, `docs.extract`, `tender.read`); those stay off until you enable them.
- A **tool-rich skill** (`skills/core/`) holds several related tools. A request that names one tool runs it. Otherwise every tool whose topic fits the words runs, the first answer leads and the others are listed under `also`. `part` picks one tool. A tool with nothing to do answers "not for this request" and is left out of the answer.
- A **template skill** (`skills/custom/`) is a ready outline for a job (a cover letter, a meal plan, a code review). The 94 saved workflows call them by id, so they stay separate.
- Manifests carry optional `triggers`, the phrases that should reach the skill.

## How FRIDAY chooses skills

1. Skill management first: "what skills do you have", "disable the secret scan skill" (tool names and trigger phrases count as names), "install skills from <GitHub link>". Changes wait for your approval.
2. Then the skill router. A skill is reached by its name, an id, a trigger phrase, or enough of its own words. Only enabled `safe` skills run on their own.
3. One clear request runs one skill. Two clear requests ("scan this text for secrets and what is my bmi") run both, best first, up to three. "then", "also", "along with" chain several.
4. A skill that had nothing to do is dropped, and the turn goes on as normal chat.

## How agents use skills

- An agent without code of its own runs the skills its manifest names (a small team of tools) and answers from all of their results; skills that did not apply are listed apart and never make the agent look broken.
- A manifest entry can also be `category:<name>` (every enabled skill of that category) or `*` (every enabled skill). The skill router then picks the best few for the prompt, so an agent can own a whole shelf and use several skills at once.
- A skill you switch off is not run by any agent.
- Background agents in `agents/core/` keep their own code and stay off until you turn them on.

## Managing skills

On the Skills page: install (Marketplace, GitHub, zip, folder, git URL), enable, disable, test, remove (installed ones only). In chat: list, explain, enable, disable, remove, install from a GitHub link, each behind the same approval gate.

## The complete list

<!-- docs-engine: generated skill list. Edit scripts/docs-engine.cjs, not this. -->

243 skills ship: 29 tool-rich skills in `skills/core/` and 214 template skills in `skills/custom/`; 24 system agents in `agents/system/` use them.

### Tool-rich skills (`skills/core/`)

| Skill | Id | Category | Tools inside | Phrases that reach it |
| --- | --- | --- | --- | --- |
| Date and time tools | `cal-date-time` | calendar | Date calculator, Working days, Age calculator, Timestamp converter, Time zone converter | days between, working days, workdays, business days, date of birth, birthday |
| Calendar and planner | `cal-planner` | calendar | Calendar event file, Day planner blocks, Cron explainer | ics file, calendar file, calendar event, cron, crontab, cron schedule |
| Extract and compare | `dat-extract-tools` | data | Extract entities, List compare, Frequency count, Key-value to JSON | extract emails, extract links, extract phone numbers, find all, compare lists, common items |
| Table and statistics | `dat-table-tools` | data | CSV profile, Table converter, Number statistics | csv, tsv, markdown table, convert table, column types, statistics |
| Color contrast | `dev-color-contrast` | developer | — | contrast, wcag, color contrast, colour contrast |
| Command and Windows help | `dev-command-help` | dev | Command explainer, Git recipes, Windows reference | explain command, explain this command, this command, what does this command do, git undo, undo last commit |
| Decode and hash | `dev-decode-tools` | dev | Token decoder, UUID inspector, Hash check | jwt, base64, decode token, uuid, guid, sha256 |
| Encode and numerals | `dev-encode-tools` | dev | Text encoder, Roman numerals, Number words | url encode, url decode, base64 encode, encode base64, html entities, hex encode |
| JSON tools | `dev-json-tools` | dev | JSON repair, JSON path query | json, repair json, fix json, json path, jq, json repair |
| Project file checks | `dev-project-checks` | dev | Env file audit, Commit message lint, Version compare | .env, dotenv, env file, commit message, conventional commit, compare version |
| Regex and diff | `dev-text-tools` | dev | Regex tester, Text diff | regex, regular expression, text diff, compare two texts, diff, regex tester |
| Text tools | `doc-text-tools` | doc | Text cleaner, Word count and reading time, Naming case converter, Markdown contents list | word count, reading time, character count, snake case, camel case, kebab case |
| Writing analysis | `doc-writing-analysis` | writing | SEO on-page check, Meeting actions, Readability, Summary, Keywords | readability, reading level, flesch, keywords, key terms, summarize |
| Investment and tax | `fin-invest-tax` | finance | CAGR and ROI, Break-even, Inflation, India income tax | cagr, roi, return on investment, break even, inflation, purchasing power |
| Health and fitness | `health-calc` | health | BMI, Calories, Heart-rate zones, Running pace, Water intake | bmi, body mass index, calorie, calories, bmr, tdee |
| Finance calculator | `in-finance-calc` | india | EMI calculator, Fixed deposit calculator, Bill splitter, Percentage calculator | emi, sip, loan, lumpsum, fixed deposit, fd |
| Indian ID check | `in-id-check` | india | — | pan, gstin, ifsc, aadhaar, pan number, upi id |
| GST and invoice | `in-tax-invoice` | india | GST calculator, Invoice total, Rupees in words | gst, cgst, sgst, igst, invoice, rupees in words |
| Hinglish detector | `lang-hinglish-detect` | language | — | hinglish, which language, detect language |
| Trip and home cost | `life-calc` | life | Trip cost, Electricity cost | trip cost, fuel cost, petrol cost, mileage, road trip, electricity bill |
| Math tools | `math-tools` | math | Calculator, Number theory, Combinatorics, Equation solver, Geometry, Fractions and ratios | calculator, square root, gcd, hcf, lcm, prime number |
| Unit and size converter | `ops-convert` | ops | Unit converter, Data size converter, Download time, Number base converter | unit converter, unit conversion, convert units, data size, gib, download time |
| File and path check | `ops-file-path-check` | ops | File type check, Windows path check | file extension, double extension, windows path, path too long, reserved name, is this file safe |
| Log and error doctor | `ops-log-doctor` | ops | Log triage, Exit code decoder | exit code, error code, errorlevel, return code, log triage, analyze log |
| Network lookup | `ops-network-tools` | ops | Port lookup, IP address inspector, CIDR calculator, HTTP status explainer | port number, what port, which port, ip address, private ip, subnet |
| Content safety scan | `saf-content-scan` | safety | Secret scan, PII redactor, Injection scan | secret, api key, redact, personal data, pii, prompt injection |
| Link safety check | `saf-link-check` | safety | Link risk check, URL cleaner | phishing, suspicious link, is this link safe, clean url, tracking parameters, utm |
| Password strength check | `saf-password-check` | safety | — | password strength, strong password, is my password, password safe |
| Study planner | `study-tools` | study | Spaced repetition, Grade converter, Exam plan, Pomodoro plan | spaced repetition, flashcard, sm-2, cgpa, gpa, percentage to cgpa |

### Template skills (`skills/custom/`)

#### career (10)

| Skill | Id | What it does |
| --- | --- | --- |
| 30-60-90 outline | `car-30-60-90` | Outline a 30/60/90 plan with learn / deliver / improve buckets. |
| About-section blurb | `car-about-blurb` | Write a 40–60 word about blurb from role, years, and focus you type. |
| Cover letter skeleton | `car-cover-letter` | Skeleton cover letter: why this role, proof, and close — from notes you paste. |
| Interview question list | `car-interview-prep` | Build a prep list mixing canned behavioural questions with terms from the role paste. |
| Job compare table | `car-job-compare` | Compare two roles on pay band, commute, growth, and fit using notes you type. |
| Offer review questions | `car-offer-questions` | Questions to ask before answering an offer (scope, pay timing, equipment) — not negotiation theatre. |
| Portfolio outline | `car-portfolio` | Outline a portfolio: 3–5 pieces with problem, what you did, and proof. |
| Reference request draft | `car-reference-ask` | Draft a short ask for a reference, naming the role and why you thought of them. |
| STAR resume bullet | `car-resume-bullet` | Turn a STAR story (situation, task, action, result) into one resume bullet. |
| STAR story expander | `car-star-story` | Expand four short lines into a spoken STAR story with suggested timing. |

#### coding (22)

| Skill | Id | What it does |
| --- | --- | --- |
| TypeScript any finder | `code-any-narrow` | List lines that use `any` or `as any` so you can plan narrowing. |
| API contract checklist | `code-api-contract` | Check a pasted OpenAPI/route sketch for method, path, auth, error shape, and examples. |
| Changelog drafter | `code-changelog` | Group pasted bullets into Added / Changed / Fixed / Security for a Keep-a-Changelog draft. |
| Commit message drafter | `code-commit-message` | Draft a Conventional Commit subject and body from a pasted diff or bullet list. |
| Branch-complexity hotspots | `code-complexity-hotspots` | Score each function by if/for/while/case count as a crude cyclomatic stand-in. |
| Dependency list summarizer | `code-dep-audit` | Parse a pasted package.json dependencies block or requirements.txt into a name/version table. |
| Diff stats summarizer | `code-diff-stats` | Count files, plus-lines, and minus-lines in a unified diff paste. |
| Environment-variable audit | `code-env-audit` | List process.env / os.environ / %VAR% usages in pasted code. |
| Error-handling taxonomy | `code-error-taxonomy` | Count throw/catch/retry patterns in pasted code and list empty catches. |
| gitignore coverage notes | `code-gitignore-notes` | Compare a pasted gitignore with a file list and list paths that still look committable. |
| License header check | `code-license-header` | See whether the first 15 lines of a paste contain a copyright/license needle. |
| Naming consistency notes | `code-naming-pass` | Collect identifiers and flag mixed camelCase / snake_case in one paste. |
| OWASP-inspired static checklist | `code-owasp-static` | Cheap static hints: eval, innerHTML, hardcoded secrets, SQL concat — not a penetration test. |
| Performance checklist | `code-perf-checklist` | Look for N+1 awaits, unbounded maps, and JSON.parse in loops in pasted code. |
| Pull-request checklist | `code-pr-checklist` | Standard PR hygiene list ticked against a pasted description or diff header. |
| Refactor planning notes | `code-refactor-plan` | Skim pasted code for long functions, duplication hints, and a sequenced refactor plan. |
| Regex explainer | `code-regex-explain` | Break a regex into tokens and optionally test it against a sample string in the sandbox. |
| SemVer bump suggestion | `code-semver-bump` | Suggest major/minor/patch from changelog language against a starting SemVer. |
| SQL review checklist | `code-sql-review` | Flag SELECT *, missing WHERE on UPDATE/DELETE, and string-concat filters in pasted SQL. |
| Stale comment finder | `code-stale-comments` | List TODO/FIXME/HACK comments and commented-out code-looking lines. |
| Test-case prompt builder | `code-test-cases` | Turn a function spec or pasted code into happy-path, edge, and error test case bullets. |
| TODO triage | `code-todo-triage` | Group TODO/FIXME comments by keyword urgency (security, bug, later). |

#### communication (10)

| Skill | Id | What it does |
| --- | --- | --- |
| Apology draft | `com-apology` | Draft a short apology with what happened, impact, and the next step you name. |
| Polite chase email | `com-ask-update` | Draft a short, polite chase for an overdue reply with optional due context. |
| Difficult-conversation outline | `com-difficult-talk` | Outline a hard conversation: facts, feeling, request, and check-in question. |
| Email draft from bullets | `com-email-draft` | Turn bullets into a short email with subject, greeting, body, and close. |
| Follow-up email | `com-follow-up` | Draft a follow-up that restates the last ask and offers a clear next action. |
| Intro blurb | `com-intro-blurb` | Build a 3-line introduction from name, role, and what you help with. |
| Meeting request draft | `com-meeting-ask` | Draft a meeting-request email with purpose, length, and two time options you type. |
| Short async update | `com-slack-update` | Compress bullets into a 4-line async update suitable for chat (not posted). |
| Stand-up status | `com-status-update` | Format yesterday / today / blockers lines for a stand-up update. |
| Thank-you note | `com-thanks` | Draft a thank-you note naming the specific help and one concrete result. |

#### construction (22)

| Skill | Id | What it does |
| --- | --- | --- |
| Brick and block count | `con-brick-count` | Count masonry units from wall area, unit face size, joint gap, and waste. |
| Concrete volume estimator | `con-concrete-volume` | Rectangular slab/footing volume from length, width, and depth, with a unit tag. |
| Material cost rollup | `con-cost-rollup` | Sum line items written as `qty unitCost description` and report a subtotal. |
| Daily site log template | `con-daily-site-log` | Turn rough daily notes into a structured site log: weather, workforce, work done, delays, safety. |
| Drywall sheet count | `con-drywall-sheets` | Sheet count from wall/ceiling area, one sheet's area, and waste. |
| Excavation volume | `con-excavation-volume` | Cut volume with an optional bulking percent for hauled material. |
| Formwork area takeoff | `con-formwork-area` | Contact area for a rectangular pour: base optional, sides from openSides count. |
| Lumber cut list | `con-lumber-cut-list` | Bin packed cut lengths onto stock boards and report leftover per board. |
| Paint coverage estimator | `con-paint-coverage` | Litres of paint from wall area, coats, coverage per litre, and a waste percent. |
| Project phase checklist | `con-phase-checklist` | Emit a default site phase list (mobilise → close-out) scaled to a week count. |
| Rebar length takeoff | `con-rebar-takeoff` | Total rebar length from bar count, each length, and an optional lap percent. |
| RFI and submittal checklist | `con-rfi-checklist` | Prompt list for a complete RFI: drawing ref, spec clause, question, options, needed-by date. |
| Roofing squares estimator | `con-roofing-squares` | Roofing squares from plan area, a pitch multiplier, and waste. |
| Electrical isolation checklist | `con-safety-electrical` | Lock-out / tag-out style prompts for temporary electrical work on a site. |
| General site safety checklist | `con-safety-general` | Tick a generic site-safety list (access, PPE, first aid, housekeeping) against pasted notes. |
| Working-at-height checklist | `con-safety-heights` | Reference checklist for ladders, scaffolds, edges, and harness use — not a permit. |
| Slope and grade calculator | `con-slope-grade` | Percent grade, ratio, and angle from rise and run. |
| Simple span educational aid | `con-span-aid` | Compare a span/depth ratio to rough rules of thumb for timber or steel — educational only. |
| Stair rise/run helper | `con-stair-rise-run` | Split a total rise into riser count and check a 2R+G rule-of-thumb. |
| Tile quantity with waste | `con-tile-waste` | Tile count from room area, one tile's area, and a waste factor for cuts. |
| Construction unit conversions | `con-unit-convert` | Convert length, area, or volume between mm, m, ft, in, m², ft², m³, and yd³. |
| Waste factor planner | `con-waste-factor` | Gross order quantity from a net takeoff and a waste percent. |

#### cooking (10)

| Skill | Id | What it does |
| --- | --- | --- |
| Baker's percentages | `ckn-baker-ratio` | Convert flour-relative weights into baker's percentages (flour = 100%). |
| Cook-time sketch | `ckn-cook-time` | Rough roast minutes from kg at 30–40 min/kg plus rest — educational, not a food-safety timer. |
| Recipe grocery merge | `ckn-grocery-merge` | Merge several recipe ingredient dumps into one shopping list with crude counts. |
| Leftover idea list | `ckn-leftover-ideas` | Suggest reuse ideas (wrap, fried rice, soup) based on leftover keywords you type. |
| Seven-day meal slots | `ckn-meal-week` | Distribute dish names across 7 days lunch/dinner so leftovers can repeat once. |
| Mise en place list | `ckn-mise-en-place` | Split a recipe into prep (chop, measure) versus cook steps from verb hints. |
| Recipe scaler | `ckn-scale-recipe` | Scale ingredient amounts in 'qty unit name' lines from one yield to another. |
| Spice pairing notes | `ckn-spice-pair` | Static pairing notes (cumin-coriander, chilli-lime, garlic-parsley) for a spice you name. |
| Pantry substitution notes | `ckn-sub-pantry` | Static common substitutions (buttermilk, egg wash, starch) when you name an ingredient. |
| Servings split | `ckn-yield-split` | Split a pot into per-person portions from total servings and headcount. |

#### data (10)

| Skill | Id | What it does |
| --- | --- | --- |
| Number column summary | `dat-column-summary` | Summarise a pasted number list: count, min, max, mean, median, and sum. |
| Dedupe key list | `dat-dedupe-keys` | Return unique keys from a pasted list and the ones that were duplicated. |
| Histogram bins | `dat-histogram-bins` | Bin a numeric series into equal-width counts so you can see the shape of the data. |
| Join-key compare | `dat-join-keys` | Compare two id lists and report keys only in A, only in B, and in both. |
| JSON key paths | `dat-json-keys` | List dotted key paths from a pasted JSON object so nested fields are visible. |
| Missing-field report | `dat-missing-report` | Scan CSV-like rows and report empty cells per column so you can see gaps. |
| Simple moving average | `dat-moving-average` | Compute a simple moving average of a numeric series for a window you choose. |
| Z-score outlier flags | `dat-outlier-z` | Flag values whose absolute z-score is above a threshold in a numeric series. |
| Percent-change series | `dat-percent-change` | Compute period-to-period percent change for a numeric series. |
| CSV schema guess | `dat-schema-infer` | Guess column types (number, date-like, text) from a pasted CSV sample. |

#### developer (1)

| Skill | Id | What it does |
| --- | --- | --- |
| Code review helper | `code-review` | Review a source file or diff for risky patterns: hardcoded secrets, shell injection, missing error handling, long functions and TODO debt. |

#### documents (2)

| Skill | Id | What it does |
| --- | --- | --- |
| Extract document text | `docs.extract` | Read real text and rows out of CSV, XLSX, DOCX and text-based PDFs, or pasted document text. |
| Read a tender | `tender.read` | Extract stated tender/RFP clauses (scope, eligibility, deadline, BOQ) from a document, URL or pasted text. |

#### health-education (10)

| Skill | Id | What it does |
| --- | --- | --- |
| First-aid kit checklist | `hlt-first-aid-kit` | Static home first-aid kit checklist (gauze, tape, gloves, …) for packing a box. |
| Food-label decode | `hlt-food-label` | Parse kcal / protein / sugar numbers from a pasted label block into a small table. |
| Habit tracker grid | `hlt-habit-tracker` | Build a 7-day habit grid from habit names so you can print or copy it. |
| Hydration reminder math | `hlt-hydration-plan` | Educational glass-count sketch from a kg body-weight figure you type (not a prescription). |
| Screen-break schedule | `hlt-screen-break` | Build a 20-20-20 style break schedule from a work-block length in minutes. |
| Sleep-debt sketch | `hlt-sleep-debt` | Compare logged sleep hours against a target and show the gap for the week. |
| Stretch sequence | `hlt-stretch-flow` | Suggest a timed stretch sequence from a minute budget (neck, hips, hamstrings). |
| Symptom log template | `hlt-symptom-log` | Blank symptom log (time, what you noticed, food/sleep context) — not a diagnosis. |
| Vaccine record template | `hlt-vaccine-record` | Blank personal immunisation record table — you fill dates; FRIDAY does not store medical claims. |
| Workout split template | `hlt-workout-split` | Map a day-count onto a simple push/pull/legs or full-body split template. |

#### home (10)

| Skill | Id | What it does |
| --- | --- | --- |
| Appliance lifespan notes | `hom-appliance-life` | Look up typical residential lifespan ranges for common appliances from a static table. |
| Budget envelopes | `hom-budget-envelopes` | Split a monthly cash amount into named envelopes by percent or equal shares. |
| Weekly chore roster | `hom-chore-roster` | Spread chore names across seven days so each day has a short list. |
| Cleaning cadence | `hom-cleaning-cadence` | Turn a room list into daily / weekly / monthly cleaning cadence suggestions. |
| Leftover meal slots | `hom-meal-slots` | Slot leftover names into lunch/dinner for the next few days so food gets used. |
| Trip packing list | `hom-packing-list` | Build a packing list from trip nights plus climate (hot, cold, rain). |
| Pantry grocery merge | `hom-pantry-list` | Merge recipe ingredient lines into a unique grocery list with crude counts. |
| Plant watering table | `hom-plant-water` | Build a watering interval table from plant names tagged dry, average, or wet. |
| Kitchen unit convert | `hom-unit-kitchen` | Convert common kitchen amounts (cups, tbsp, ml, grams of water) you type. |
| Water-use sketch | `hom-water-use` | Rough household water litres from counts of showers, loads, and dishes you type. |

#### legal-templates (10)

| Skill | Id | What it does |
| --- | --- | --- |
| Change-order fields | `law-change-order` | Fields for a simple change order (what changed, price, time, approval). |
| Contractor kickoff checklist | `law-contractor-list` | Kickoff checklist for a contractor (scope, dates, confidentiality, invoice cadence). |
| Invoice terms bullets | `law-invoice-terms` | Draft payment-term bullets (due days, late note, method) from numbers you type. |
| IP inventory template | `law-ip-inventory` | Blank inventory of what you created (code, docs, marks) versus third-party material. |
| Rental question list | `law-lease-questions` | Questions to ask before signing a rental (deposit, repairs, notice) — not a lease. |
| Recording-consent note | `law-meeting-consent` | Short meeting-recording consent paragraph you can paste into an agenda (not a statute). |
| NDA section outline | `law-nda-outline` | Outline typical NDA headings (parties, purpose, exclusions, term) as a study scaffold. |
| Privacy-notice headings | `law-privacy-outline` | Headings commonly seen in a small privacy notice (what you collect, why, keep, rights). |
| Records retention table | `law-retention` | A study table of example retention buckets (receipts, contracts, HR) — not your jurisdiction's law. |
| RFP clarifying questions | `law-rfp-questions` | Turn TBD / missing fields in an RFP paste into a clarifying-question list. |

#### markets (22)

| Skill | Id | What it does |
| --- | --- | --- |
| Portfolio allocation mixer | `mkt-allocation-mix` | Parse name/weight lines, renormalise weights to 100%, and flag rows that do not add up. |
| Beta and volatility glossary | `mkt-beta-terms` | Define beta, idiosyncratic vs systematic risk, and optionally compute sample variance of pasted returns. |
| Bollinger band explainer | `mkt-bollinger-explainer` | Explain middle SMA ± k·stddev bands and compute them from a pasted close list. |
| Break-even after costs | `mkt-break-even` | Illustrative break-even price after a flat fee on a long or short study position. |
| CAGR calculator | `mkt-cagr` | Compound annual growth rate from a start value, end value, and year count. |
| Candlestick pattern explainer | `mkt-candlestick-patterns` | Classify one OHLC bar as hammer, shooting star, doji, marubozu, or ordinary — historical pattern language only. |
| Compound growth table | `mkt-compound-growth` | Year-by-year compound amount from principal, rate, years, and compounds per year. |
| Dollar-cost average schedule | `mkt-dca-schedule` | Split a total cash amount across N equal buys and show shares per slice at a study price. |
| Dividend yield calculator | `mkt-dividend-yield` | Turn price and annual dividend into yield and an optional payout ratio from EPS. |
| Trade expectancy math | `mkt-expectancy` | Expectancy = winRate×avgWin − (1−winRate)×/avgLoss/ on historical averages you type. |
| MACD explainer | `mkt-macd-explainer` | Describe MACD line, signal, and histogram, and compute a simple EMA-based MACD from pasted closes. |
| Max drawdown from a curve | `mkt-max-drawdown` | Walk a pasted equity or price series and report peak-to-trough max drawdown. |
| Order-type glossary | `mkt-order-types` | Define market, limit, stop, stop-limit, and TIF terms from a pasted question — never place one. |
| P/E and PEG helper | `mkt-pe-ratio` | Price-to-earnings and optional PEG from a growth percent you supply. |
| Position size calculator | `mkt-position-size` | Compute a share/unit count from account capital, percent risked, entry, and stop — no order is sent. |
| Two-series return correlation | `mkt-return-correlation` | Pearson correlation of two equal-length return lists you paste. |
| Risk/reward ratio | `mkt-risk-reward` | Distance to stop versus distance to target, as a ratio you can study before a thesis. |
| RSI formula explainer | `mkt-rsi-explainer` | Explain Wilder RSI and, when a close series is pasted, compute a Wilder RSI value. |
| Sharpe ratio from returns | `mkt-sharpe` | Sample Sharpe = (mean excess return) / stdev of pasted period returns. |
| Simple moving average | `mkt-sma-from-series` | Average the last N pasted numbers and list the trailing SMA window. |
| Support and resistance from highs/lows | `mkt-support-resistance` | Cluster pasted high/low prices into crude support and resistance bands. |
| Tax-lot terminology | `mkt-tax-lot-terms` | Explain FIFO, LIFO, HIFO and specific identification against a pasted lot list — no tax filing. |

#### office (10)

| Skill | Id | What it does |
| --- | --- | --- |
| Action tracker table | `off-action-tracker` | Turn a bullet list of tasks into a markdown table with owner, due, and status columns. |
| Agenda builder | `off-agenda-builder` | Build a timed meeting agenda from a list of topics and a total minute budget. |
| Checklist from text | `off-checklist-from-text` | Turn sentences or commas into a numbered markdown checklist with unchecked boxes. |
| Safe filename slug | `off-filename-slug` | Turn a title into a lowercase, filesystem-safe slug with an optional extension. |
| Formal letter skeleton | `off-letter-skeleton` | Draft a formal letter skeleton with salutation, purpose, body slots, and close. |
| Memo outline | `off-memo-outline` | Turn rough notes into a one-page memo outline with purpose, facts, ask, and next step. |
| Minutes heading set | `off-minutes-headings` | Produce standard meeting-minutes headings (attendance, agenda, decisions, actions). |
| Sign-off block options | `off-sign-off-block` | Offer several sign-off lines for email or letters at different formality levels. |
| CSV to markdown table | `off-table-markdown` | Convert pasted CSV or TSV rows into a GitHub-flavoured markdown table. |
| Version note stamp | `off-version-stamp` | Build a short version / what's-new stamp from a version string and change bullets. |

#### productivity (1)

| Skill | Id | What it does |
| --- | --- | --- |
| Meeting notes summariser | `meeting-notes` | Turn a raw transcript or rough notes into a structured summary: decisions, action items with owners, open questions and follow-up dates. |

#### reasoning (22)

| Skill | Id | What it does |
| --- | --- | --- |
| Assumption audit | `rsn-assumption-audit` | List statements that look like assumptions (we assume, must, always) and ask for evidence. |
| Cognitive bias checklist | `rsn-bias-check` | Scan a pasted argument for phrasing that often rides confirmation, sunk cost, or anchoring. |
| Decision-focused agenda | `rsn-decision-agenda` | Turn topics into an agenda with a decision question and a minute split. |
| Decision record template | `rsn-decision-record` | Fill an ADR-style record: context, options, decision, consequences from pasted notes. |
| Priority and urgency triage | `rsn-eisenhower` | Sort tasks into urgent-important, schedule, delegate, and drop using keywords or U/I tags. |
| Feedback draft (observation/feeling/request) | `rsn-feedback-draft` | Reshape a complaint into observation, feeling, need, request — a draft you still edit. |
| Five-whys root cause | `rsn-five-whys` | Walk a problem statement through five why-layers, using extra pasted lines as answers if present. |
| Goal and key-result splitter | `rsn-goal-kr` | Separate a north-star goal from measurable KR-looking lines (numbers, %, by-date). |
| Habit loop planner | `rsn-habit-loop` | Cue / routine / reward / craving slots from a pasted habit description. |
| Negotiation prep checklist | `rsn-negotiation-prep` | BATNA, reservation, target, concessions, and questions for the other side. |
| Incident post-mortem template | `rsn-post-mortem` | Bucket incident notes into timeline, impact, root cause, fix, and follow-up. |
| Pre-mortem | `rsn-pre-mortem` | Assume the plan failed and list failure modes, signals, and mitigations from pasted fears. |
| Pros and cons matrix | `rsn-pros-cons` | Split pasted notes into pro / con / unsure columns using leading +/-/? or keywords. |
| Risk register template | `rsn-risk-register` | Parse `risk / likelihood / impact / mitigation` rows into a register with L×I when numeric. |
| Second-order effects | `rsn-second-order` | For each pasted action line, prompt a first-order and second-order consequence slot. |
| Socratic question set | `rsn-socratic` | Generate clarifying, evidence, alternative, and implication questions for a pasted claim. |
| Stakeholder map | `rsn-stakeholder-map` | Parse `name, interest, influence` rows into a low/high influence–interest grid. |
| Study plan builder | `rsn-study-plan` | Spread pasted topics across a day count with a minutes-per-day budget. |
| SWOT from notes | `rsn-swot` | Bucket lines into strengths, weaknesses, opportunities, threats using headings or keywords. |
| Timebox focus plan | `rsn-timebox-plan` | Chunk a task list into sequential timeboxes of N minutes (default 25). |
| Trade-off table | `rsn-tradeoff-table` | Build an option × criterion table from option lines and a comma-separated criteria list. |
| Weighted option scoring | `rsn-weighted-score` | Score options from lines `option, criterion, weight, score` and sum weight×score. |

#### security-hygiene (10)

| Skill | Id | What it does |
| --- | --- | --- |
| 2FA rollout checklist | `sec-2fa-plan` | Order-of-operations checklist for turning on 2FA (mail, bank, password manager first). |
| 3-2-1 backup plan | `sec-backup-321` | Fill a 3-2-1 backup plan template (3 copies, 2 media, 1 off-site) from locations you name. |
| Device lock checklist | `sec-device-lock` | Checklist for screen lock, OS updates, and full-disk encryption being on. |
| Password hygiene checklist | `sec-password-hygiene` | Checklist for unique passwords, a manager, and no reused logins — static advice. |
| App permission questions | `sec-permission-review` | Questions for reviewing app permissions (camera, files, location) on a device you name. |
| Phishing red flags | `sec-phishing-flags` | Flag urgency, mismatched links, and credential asks in a pasted message. |
| Public Wi-Fi checklist | `sec-public-wifi` | Static public-Wi-Fi hygiene (no banking, prefer known hotspot, update later). |
| Recovery-code storage plan | `sec-recovery-codes` | Plan for storing 2FA recovery codes offline (printed, password manager, not chat). |
| Sharing-link review | `sec-share-link` | Questions to ask before sending a share link (who, expiry, edit vs view). |
| Update cadence table | `sec-update-cadence` | Suggested check cadence for OS, browser, and phone (weekly / monthly). |

#### study (10)

| Skill | Id | What it does |
| --- | --- | --- |
| Citation list stub | `std-cite-list` | Normalise pasted source lines into a plain bibliography list (author-year-ish). |
| Text concept map | `std-concept-map` | Indent pasted links (A -> B) into a text concept map. |
| Cornell notes split | `std-cornell` | Split notes into cues, details, and a summary line in Cornell layout. |
| Exam-week checklist | `std-exam-checklist` | Static exam-week checklist (sleep, materials, logistics) plus your subject list. |
| Flashcards from pairs | `std-flashcards` | Turn term:definition lines into a flashcard list you can quiz later. |
| Glossary builder | `std-glossary` | Collect unique terms (capitalised or tagged) from notes into a glossary stub. |
| Pomodoro session blocks | `std-pomodoro` | Lay out focus/break blocks for a study window (25/5 by default). |
| Quiz stubs from bullets | `std-quiz-mcq` | Turn bullet facts into short multiple-choice stubs with one correct line and two placeholders. |
| Prioritised reading list | `std-reading-list` | Rank reading items by optional priority tags (must / should / later) in the line. |
| Spaced-repeat dates | `std-spaced-rep` | Suggest review dates at 1, 3, 7, and 21 days from a start date you type. |

#### travel (10)

| Skill | Id | What it does |
| --- | --- | --- |
| Walk-time from km | `trv-city-hours` | Estimate walking minutes from kilometres at 5 km/h, plus a buffer percent. |
| Trip daily budget | `trv-daily-budget` | Divide a trip cash budget by days and split into stay / food / local transport sketches. |
| Three-block day plan | `trv-day-plan` | Sort pasted attractions into morning, afternoon, and evening blocks by list order. |
| Travel document checklist | `trv-doc-checklist` | Educational document checklist (passport validity, tickets, insurance copy) — not visa advice. |
| Day itinerary skeleton | `trv-itinerary` | Turn a city-plus-days note into a blank morning/afternoon/evening itinerary. |
| Climate packing extras | `trv-pack-climate` | Add climate-specific packing extras (hot / cold / rain / altitude) to a base list. |
| Traveller phrase card | `trv-phrase-card` | Static courtesy phrases (please, thanks, help, water) for a few language codes. |
| Timezone hour offsets | `trv-timezone-span` | Show hour offsets from UTC for a short static list of city timezones you name. |
| Tip percent table | `trv-tip-table` | Build a tip amount table for 10/12/15/18/20 percent on a bill you type. |
| Packing weight sum | `trv-weight-pack` | Sum item weights you list as name:grams so you can compare to an airline cap. |

#### web (2)

| Skill | Id | What it does |
| --- | --- | --- |
| Read a page | `web.read` | Open a URL and return its readable text and links through FRIDAY's built-in browser engine. |
| Web search | `web.search` | Search the public web and return ranked titles, URLs and snippets through FRIDAY's built-in browser engine. |

#### writing (10)

| Skill | Id | What it does |
| --- | --- | --- |
| Forty-word blurb | `wrt-blurb` | Compress pasted text into a roughly forty-word blurb for a card or listing. |
| Cliche hunt | `wrt-cliche-hunt` | Flag tired phrases (at the end of the day, think outside the box, …) in a draft. |
| FAQ from notes | `wrt-faq` | Turn note lines into question/answer pairs when a line looks like a question. |
| Headline options | `wrt-headlines` | Produce eight short headline options from a topic sentence or blurb. |
| Piece outline | `wrt-outline` | Nest pasted bullets into a hierarchical outline (I / A / 1) for an essay or brief. |
| Quoted-text list | `wrt-quote-list` | Extract quoted phrases from a draft so you can check attribution later. |
| Reading ease estimate | `wrt-reading-grade` | Estimate Flesch-style reading ease from sentence and syllable proxies. |
| Thesis split | `wrt-thesis-split` | Split a paragraph into claim, evidence lines, and a so-what closer. |
| Tighten sentences | `wrt-tighten` | Shorten long sentences by dropping filler phrases and reporting the word delta. |
| Tone rewrite options | `wrt-tone-options` | Offer the same message in formal, plain, and warm tones so you can pick one. |

### System agents (`agents/system/`)

| Agent | Id | Skills it uses |
| --- | --- | --- |
| Builder desk | `builder-desk` | `category:construction` |
| Career desk | `career-desk` | `category:career` |
| Code desk | `code-desk` | `category:coding`, `category:developer`, `category:web`, `category:dev` |
| Communication desk | `comms-desk` | `category:communication`, `category:writing` |
| Data desk | `data-desk` | `dat-table-tools`, `doc-text-tools`, `lang-hinglish-detect`, `dat-extract-tools` |
| Dev helper | `dev-helper` | `dev-json-tools`, `dev-text-tools`, `dev-decode-tools`, `dev-project-checks`, `dev-color-contrast`, `dev-encode-tools`, `dev-command-help` |
| Home desk | `home-desk` | `category:home` |
| India desk | `india-desk` | `in-tax-invoice`, `in-finance-calc`, `in-id-check` |
| Kitchen desk | `kitchen-desk` | `category:cooking` |
| Legal desk | `legal-desk` | `category:legal-templates` |
| Life desk | `life-desk` | `health-calc`, `study-tools`, `life-calc` |
| Log doctor | `log-doctor` | `ops-log-doctor`, `ops-network-tools`, `ops-file-path-check` |
| Logic desk | `logic-desk` | `category:reasoning` |
| Markets desk | `markets-desk` | `category:markets`, `category:finance` |
| Math desk | `math-desk` | `math-tools`, `fin-invest-tax` |
| Office desk | `office-desk` | `category:office`, `category:documents`, `category:productivity` |
| Privacy guard | `privacy-guard` | `saf-content-scan`, `saf-link-check`, `saf-password-check` |
| Security desk | `security-desk` | `category:security-hygiene`, `category:safety` |
| Skill desk | `skill-desk` | `*` |
| Study desk | `study-desk` | `category:study`, `category:health-education` |
| System desk | `system-desk` | `ops-convert`, `ops-network-tools`, `ops-file-path-check` |
| Time planner | `time-planner` | `cal-date-time`, `cal-planner` |
| Travel desk | `travel-desk` | `category:travel` |
| Writing desk | `writing-desk` | `doc-text-tools`, `lang-hinglish-detect`, `doc-writing-analysis` |

<!-- docs-engine: end generated skill list -->
