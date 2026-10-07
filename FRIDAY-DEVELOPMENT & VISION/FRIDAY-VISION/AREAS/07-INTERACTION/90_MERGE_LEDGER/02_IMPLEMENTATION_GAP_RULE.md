# Implementation Gap Rule

This package is an architecture/upgrade plan, not a claim that the source repository already implements every contract.

When the implementation AI finds a missing contract, it must first determine whether an existing owner can be extended. If yes, extend it. If no, create the smallest missing adapter/owner and register it through the existing source-of-truth pattern. Never create a parallel subsystem merely because a package describes one concept with a convenient new name.
