# DAG Runtime
Nodes declare inputs, outputs, dependencies, resource locks, device/capability constraints,
timeout, retry class and side effects. Scheduler uses ready queue, priority, fairness,
admission, locks and cancellation. Dynamic graph edits must be validated and acyclic.
