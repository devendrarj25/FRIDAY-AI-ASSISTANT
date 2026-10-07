# Update Scenarios

Required automated/integration scenarios:

A. Official file added: appears after update.
B. Official file modified: new version contains modification.
C. Official file removed: absent from new official payload but available through rollback package/state if retained.
D. User skill absent from update package: remains installed.
E. User agent absent from update package: remains installed.
F. User runtime absent from update package: remains installed.
G. User model absent from update package: remains installed.
H. Data migration required: checkpoint/verify/commit.
I. Download corruption: reject before activation.
J. Signature mismatch: reject before activation.
K. Power loss during update: recover deterministically.
L. Rebuild same version: no version increment.
