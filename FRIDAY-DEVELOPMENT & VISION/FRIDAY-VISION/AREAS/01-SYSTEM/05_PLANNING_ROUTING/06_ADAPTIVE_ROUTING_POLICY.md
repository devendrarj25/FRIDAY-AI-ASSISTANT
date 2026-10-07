# Adaptive Routing Policy

Route on a score derived from:
- task class;
- required modality;
- capability fit;
- model quality history for this task class;
- latency;
- cost/resource pressure;
- privacy/data sensitivity;
- reliability/health;
- context window;
- tool compatibility;
- user preference;
- current environment.

Routing is learned from outcomes but constrained by policy. A high-performing model cannot bypass a privacy or authority rule. Provider state is not embedded in task truth, so routing can change mid-run when health or requirements change.
