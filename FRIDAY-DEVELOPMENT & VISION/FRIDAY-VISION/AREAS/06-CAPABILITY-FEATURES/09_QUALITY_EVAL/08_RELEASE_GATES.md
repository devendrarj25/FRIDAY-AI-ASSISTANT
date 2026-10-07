# RELEASE GATES

Gate A: schema compatibility.
Gate B: adapter conformance.
Gate C: security/policy regression.
Gate D: golden workflows.
Gate E: restart/recovery.
Gate F: computer-use safety.
Gate G: interop isolation.
Gate H: performance/SLO.
Gate I: shadow-mode parity.
Gate J: canary + rollback.

A failed safety or correctness gate blocks promotion.
