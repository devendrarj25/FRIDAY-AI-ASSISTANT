# Repair / Audit Prompt — Final

Perform an adversarial audit of FRIDAY against every contract in this package.

For each gap:
- locate current implementation;
- determine true owner;
- classify severity: correctness, durability, security, realtime, performance, maintainability;
- propose the smallest compatible fix;
- implement only if within current task scope;
- verify with a real test/build/runtime check;
- ensure no duplicate subsystem was created.

Prioritize false-success states, lost task state, duplicated side effects, authority bypasses, stale memory, modal desynchronization, race conditions, focus fights, provider coupling, broken recovery and resource starvation.
