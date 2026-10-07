# Final Acceptance Gates

A target capability is accepted only when:
1. its owner is identified;
2. canonical state is persisted where required;
3. policy is evaluated before privileged effects;
4. execution emits canonical events;
5. completion has verification evidence;
6. interruption/cancellation behaves correctly;
7. restart/recovery does not duplicate effects;
8. relevant Chat/Voice/Mobile and Manual/Auto surfaces observe the same truth;
9. resource pressure degrades safely;
10. protected build/install/release behavior remains intact.

For self-development additionally require:
- isolated candidate;
- fixed baseline;
- regression suite;
- security checks;
- resource checks;
- canary;
- rollback proof.
