# Computer Use Runtime

## Decision hierarchy
1. Native API
2. Accessibility/UIA/Win32/WinCOM
3. DOM/structured browser state
4. deterministic automation
5. vision grounding
6. coordinates

## Loop
observe → ground → plan → policy → act → observe → verify

## Windows priority
UFO² demonstrates the value of Windows UIA + Win32 + WinCOM hybrid control. FRIDAY should expose a `WindowsNativeActionAdapter` rather than forcing every operation through screen clicks.
