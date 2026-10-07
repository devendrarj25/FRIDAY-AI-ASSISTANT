# Anti-Anchoring Self-Improvement

When a repair attempt fails, do not blindly keep editing the same hypothesis.

For difficult regressions the improvement harness should generate multiple independent hypotheses/patch candidates, evaluate them against the same fixed tests, and retain only evidence-backed improvements. This reduces self-conditioned repair loops where the agent repeatedly reinforces its first mistaken diagnosis.

Candidate search is bounded by budget and governance; no production mutation happens directly from the experiment loop.
