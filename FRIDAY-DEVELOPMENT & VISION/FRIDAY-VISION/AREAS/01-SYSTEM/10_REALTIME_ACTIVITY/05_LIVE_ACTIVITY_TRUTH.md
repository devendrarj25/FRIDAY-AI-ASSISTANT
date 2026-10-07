# Live Activity Truth

Realtime surfaces consume the canonical event stream rather than inventing progress.

Events include run/task/step/route/model/tool/action/approval/artifact/device/notification/health/recovery/self-change events.

A UI may render “running”, “waiting for approval”, “paused by user”, “recovered”, “verified” only when the event/state store contains that fact. Never show a success state based solely on an optimistic request.

Activity replay must be possible from event history for debugging and user-visible task history.
