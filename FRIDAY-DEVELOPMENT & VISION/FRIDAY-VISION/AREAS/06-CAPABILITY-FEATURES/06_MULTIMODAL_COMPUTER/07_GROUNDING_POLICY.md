# GROUNDING POLICY

Target selection order:
1. stable application API
2. DOM/accessibility semantic locator
3. Windows UIA/Win32/WinCOM identity
4. visual semantic grounding
5. coordinates as last resort

Before action:
- confirm application/window/domain
- confirm target identity
- confirm user/account context
- confirm expected side effect
- check policy/risk
- capture precondition evidence

After action:
- observe
- verify postcondition
- capture evidence
- retry/recover only under declared policy
