# Regression, Shadow and Canary

## Shadow
Run candidate against the same safe inputs without changing user-visible behavior.

## Canary
Route a small percentage or selected task class to the candidate with strict rollback triggers.

## Automatic rollback triggers
- protected safety regression
- error rate above threshold
- latency budget breach
- cost budget breach
- user-correction spike
- evaluator regression on gold set
- tool permission violation
- crash loop

## Never use only the candidate's own self-rating as the rollback signal.
