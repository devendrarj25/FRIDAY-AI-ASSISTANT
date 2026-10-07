# Workflow Matrix

| Workflow | Purpose | Can publish? |
|---|---|---:|
| PR validation | validate changes | No |
| test/build | build and test | No |
| release candidate | build/evidence | Draft only |
| official publish | signed verified release | Yes |
| maintenance | dependency/health maintenance | No |

No workflow may independently invent a version. All version decisions come from the release engine/contract.
