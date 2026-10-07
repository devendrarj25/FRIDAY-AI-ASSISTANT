# Uninstall and Clean Removal

## User choices

### Keep Data
Remove application-owned install payload and OS integration while preserving:
- user components
- runtimes owned by user
- models selected as user-owned
- memory/knowledge
- projects
- downloads explicitly marked persistent

### Remove All FRIDAY Data
After confirmation:
1. stop FRIDAY processes
2. stop FRIDAY-owned runtime processes/services
3. close handles
4. verify the FRIDAY root identity
5. remove all FRIDAY-managed files/directories
6. remove tracked OS integrations
7. verify the root is gone
8. report leftovers if locked by Windows

Never perform arbitrary recursive deletion outside the verified FRIDAY root.
