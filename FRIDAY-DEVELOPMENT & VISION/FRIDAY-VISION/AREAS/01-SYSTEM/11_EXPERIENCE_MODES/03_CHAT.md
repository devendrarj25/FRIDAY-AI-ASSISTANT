# Chat Experience Contract

## Purpose
Chat is text/manual visual interaction. It submits turns and renders outputs/artifacts/activity; it does not become the task authority.

## Canonical flow
Typed input → shared turn → brain/task → streamed events → response/artifact/activity.

## Required contracts
Chat UI state is reconstructable from backend/session state.

## Failure and recovery
Refresh/disconnect resyncs instead of restarting tasks.

## Implementation guidance
Keep ChatDock as presentation/session surface and move task truth to runtime.
