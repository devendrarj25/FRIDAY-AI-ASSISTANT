# Mobile Companion — Functional Wireframes (Information Architecture Only)

These wireframes describe placement/function, not colors or styling.

## A. Home / Chat

```text
┌──────────────────────────────────────────┐
│ FRIDAY • Online • Manual/Auto • Alerts   │
├──────────────────────────────────────────┤
│ Conversation / Active Task                │
│                                          │
│ User message                             │
│ FRIDAY response / streaming              │
│                                          │
│ [progress / approval / artifact card]    │
│                                          │
├──────────────────────────────────────────┤
│ + Attachment   [Text composer]   🎙       │
│                         Send              │
└──────────────────────────────────────────┘
```

## B. Active Task

```text
┌──────────────────────────────────────────┐
│ Task title                     ● Running │
├──────────────────────────────────────────┤
│ Objective                                │
│ Current stage                            │
│ Verified progress                        │
│                                          │
│ Timeline                                 │
│ ✓ accepted                               │
│ ✓ research                               │
│ ● generating report                      │
│ ○ verification                           │
│                                          │
│ [Pause] [Cancel] [Steer] [Artifacts]    │
└──────────────────────────────────────────┘
```

## C. Approval

```text
┌──────────────────────────────────────────┐
│ Approval required                        │
├──────────────────────────────────────────┤
│ Action                                   │
│ Why                                      │
│ Target / scope                           │
│ Risk                                     │
│ Expires                                  │
│                                          │
│ [Inspect] [Reject]          [Approve]    │
└──────────────────────────────────────────┘
```

## D. Artifact

```text
┌──────────────────────────────────────────┐
│ Report.pdf                  Ready ✓       │
├──────────────────────────────────────────┤
│ Preview                                  │
│                                          │
│ Created by Task #...                     │
│ Version / verification                   │
│                                          │
│ [Open] [Download] [Share*] [Details]    │
└──────────────────────────────────────────┘
```

`*` Share/export is available only when policy allows it.

## E. Device / Remote Control

```text
┌──────────────────────────────────────────┐
│ FRIDAY Desktop • Connected               │
├──────────────────────────────────────────┤
│ Device status                            │
│ Available capability scope               │
│                                          │
│ Remote session: INACTIVE                 │
│                                          │
│ [Start Remote Session]                   │
└──────────────────────────────────────────┘
```

After activation:

```text
┌──────────────────────────────────────────┐
│ REMOTE CONTROL ACTIVE                    │
│ Target: FRIDAY Desktop                   │
│ Scope: screen + approved input           │
├──────────────────────────────────────────┤
│          Live screen / viewport          │
│                                          │
├──────────────────────────────────────────┤
│ [Stop Control] [Revoke Device]           │
└──────────────────────────────────────────┘
```

## F. Notification → deep link

Every notification should route directly to authoritative state:
`Approval required → exact approval`
`Task completed → exact task/artifact`
`Task failed → exact recovery state`
`Security event → exact device/session state`
