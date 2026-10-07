# Execution Leases, Focus and Yielding

Foreground computer control is leased, not assumed.

A lease records:
- task/run id;
- target app/window/device;
- authority scope;
- expiry/renewal;
- current user activity;
- interruption policy;
- recovery state.

If user activity conflicts with an action, FRIDAY can pause, move to background work, ask for control, or continue only when policy/task semantics explicitly permit it. The system must not fight the user for mouse/keyboard focus.
