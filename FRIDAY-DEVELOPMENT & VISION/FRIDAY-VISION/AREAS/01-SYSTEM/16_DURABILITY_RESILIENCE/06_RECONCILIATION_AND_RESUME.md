# Reconciliation and Resume

Recovery order:
1. load journal/checkpoint;
2. reconstruct canonical state;
3. identify completed effects;
4. detect ambiguous effects;
5. reconcile with authoritative external evidence where available;
6. resume only safe missing work;
7. re-plan if the world changed;
8. emit recovery evidence.

Recovery is a normal operating mode, not an exceptional afterthought.
