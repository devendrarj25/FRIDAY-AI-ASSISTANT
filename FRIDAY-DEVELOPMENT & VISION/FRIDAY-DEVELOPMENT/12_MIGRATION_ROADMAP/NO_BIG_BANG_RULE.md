# No Big-Bang Migration

Do not rewrite FRIDAY into the Vision architecture in one operation.

For each phase:
`introduce contract → adapt existing owner → dual-read if necessary → validate → migrate state → remove obsolete path only after proof`

No legacy path is removed merely because a new design exists on paper.
