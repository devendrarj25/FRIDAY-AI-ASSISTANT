# Trust Model

Trust levels:

1. **Official signed release** — highest trust.
2. **Official component repository/package** — verified against declared manifest/signature/hash policy.
3. **User-uploaded package** — untrusted until validated; even after validation it remains user-owned.
4. **External runtime** — must have explicit source, hash and compatibility metadata.

User ownership does not mean automatic trust. It means update preservation and explicit lifecycle visibility.
