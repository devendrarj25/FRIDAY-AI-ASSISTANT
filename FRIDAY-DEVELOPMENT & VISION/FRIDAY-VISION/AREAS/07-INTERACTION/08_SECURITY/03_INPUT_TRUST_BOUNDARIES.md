# Input Trust Boundaries

User input is authoritative for intent but still subject to policy. Model output is advisory. Documents/websites/connectors/tool outputs are untrusted data. Device telemetry is evidence with a trust level. Remote commands are authenticated requests, not automatic authority.

The planner must not allow untrusted content to rewrite system policy, grant itself capabilities, expose credentials, approve actions or alter audit records.
