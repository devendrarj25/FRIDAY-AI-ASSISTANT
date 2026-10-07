# REPAIR/AUDIT PROMPT

Audit FRIDAY against `00_MASTER_CONTROL` through `24_ACCEPTANCE`.

For every gap:
- locate the existing owner;
- identify the exact missing contract or broken integration;
- propose the smallest fix;
- implement it only if inside current scope;
- test the symptom and relevant regression;
- update documentation.

Do not rewrite functioning modules for stylistic reasons. Do not add duplicate infrastructure. Do not touch release/build files unless required by the specific fix.

If a high-risk change would alter authority boundaries, policy root, installer, release pipeline or system-wide security posture beyond the requested scope, stop and request owner approval.
