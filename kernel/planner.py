"""Task planner: goal -> steps -> tools -> verify, with permission gates.

Every run is written to SQLite and, on failure, the model is asked to write a
one-line lesson into vector memory. Those lessons are injected into later runs
— that is FRIDAY's self-improvement loop (no retraining involved).

Approval is genuinely resumable: when a step needs the owner's permission the
whole remaining plan is checkpointed to disk. Approving does not merely report
``resumed: true`` — ``resume()`` loads that checkpoint and continues the SAME
task from the SAME step, even after the kernel was restarted.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Any, AsyncIterator

PLAN_SYSTEM = """You are FRIDAY's planner. Break the user's goal into 2-8 concrete steps.
Return JSON: {"steps":[{"title":str,"tool":str|null,"args":object}]}.
Only use tools from the provided list. Prefer read-only steps first."""

LESSON_SYSTEM = """Write ONE short imperative rule (max 20 words) that would have
prevented the failure described. Return the rule text only."""

# A failing step is retried a bounded number of times before the task fails, so
# a transient tool error (locked file, brief network drop) does not lose a run,
# and a genuinely broken step can never loop forever.
MAX_STEP_ATTEMPTS = 2
_FENCE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.I)


def parse_plan(raw: str) -> list[dict[str, Any]]:
    """Turn a planner model reply into a step list.

    Models often wrap JSON in markdown fences or prose. A raw ``json.loads``
    of the whole reply used to fail the entire task even when a valid plan
    was sitting inside the fence.
    """
    text = str(raw or "").strip()
    if not text:
        raise ValueError("empty plan")
    fenced = _FENCE.search(text)
    if fenced:
        text = fenced.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        text = text[start : end + 1]
    data = json.loads(text)
    if isinstance(data, list):
        steps = data
    elif isinstance(data, dict):
        steps = data.get("steps")
    else:
        raise ValueError("plan is not an object")
    if not isinstance(steps, list) or not steps:
        raise ValueError("plan has no steps")
    cleaned: list[dict[str, Any]] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        title = str(step.get("title") or "").strip()
        if not title:
            continue
        tool = step.get("tool")
        args = step.get("args") if isinstance(step.get("args"), dict) else {}
        cleaned.append({"title": title, "tool": tool if tool else None, "args": args})
    if not cleaned:
        raise ValueError("plan has no usable steps")
    return cleaned


class Planner:
    def __init__(
        self,
        router,
        tools,
        memory,
        storage,
        write_lessons: bool = True,
        auto_approve_writes: bool = False,
    ) -> None:
        self.router = router
        self.tools = tools
        self.memory = memory
        self.storage = storage
        self.write_lessons = bool(write_lessons)
        self.auto_approve_writes = bool(auto_approve_writes)

    def set_write_lessons(self, on: bool) -> None:
        self.write_lessons = bool(on)

    def apply_live_setting(self, key: str, value) -> None:
        """Brain Personality toggles overlay yaml via the existing settings.set IPC."""
        if str(key) == "write_lessons":
            self.set_write_lessons(bool(value))

    # ------------------------------------------------------------- run
    async def run(
        self,
        goal: str,
        model_ids: list[str] | None = None,
        priority: int = 0,
        agent: str | None = None,
    ) -> AsyncIterator[dict]:
        task_id = f"task-{uuid.uuid4().hex[:8]}"
        brain = self.router.by_role("brain")
        if brain is None:
            yield {"taskId": task_id, "type": "failed", "error": "no ready model with role=brain"}
            return

        recalled = await self.memory.recall(goal)
        lessons = [r for r in recalled if r.get("kind") == "lesson"]
        self.storage.create_task(task_id, goal, priority=priority, agent=agent)
        yield {"taskId": task_id, "type": "created", "goal": goal, "recalled": recalled}


        plan_messages = [
            {"role": "system", "content": PLAN_SYSTEM},
            {
                "role": "system",
                "content": "Tools: "
                + json.dumps(
                    self.tools.shortlist(goal)
                    if hasattr(self.tools, "shortlist")
                    else self.tools.describe()
                ),
            },
            {"role": "system", "content": "Lessons: " + json.dumps([l["title"] for l in lessons])},
            {"role": "user", "content": goal},
        ]
        plan_t0 = time.perf_counter()
        if os.environ.get("FRIDAY_DEBUG_TURN_TIMING") == "1":
            print("[friday.turn] kernel planner.complete start", flush=True)
        plan_raw = await self.router.complete(brain, plan_messages)
        if os.environ.get("FRIDAY_DEBUG_TURN_TIMING") == "1":
            print(
                f"[friday.turn] kernel planner.complete {(time.perf_counter() - plan_t0) * 1000:.0f}ms",
                flush=True,
            )
        try:
            steps = parse_plan(plan_raw)
        except Exception:
            # One retry: a model that wrapped the JSON in prose often complies
            # when asked to return the object alone.
            retry_messages = [
                *plan_messages,
                {"role": "assistant", "content": str(plan_raw or "")[:4000]},
                {
                    "role": "user",
                    "content": "Return ONLY the JSON object {\"steps\":[...]} with no markdown.",
                },
            ]
            try:
                steps = parse_plan(await self.router.complete(brain, retry_messages))
            except Exception:
                self.storage.finish_task(task_id, "failed")
                yield {
                    "taskId": task_id,
                    "type": "failed",
                    "error": "planner returned unparsable output",
                }
                return

        # The plan is persisted before the first step runs, so an interrupted
        # task can always be recovered from where it stopped.
        self.storage.save_checkpoint(
            task_id,
            {
                "goal": goal,
                "plan": steps,
                "stepIndex": 0,
                "state": "running",
                "modelIds": model_ids or [],
                "results": [],
            },
        )
        yield {"taskId": task_id, "type": "planned", "steps": steps}

        async for event in self._execute(task_id, goal, steps, 0, model_ids or [], []):
            yield event

    # ---------------------------------------------------------- approval
    def approve(self, task_id: str, step_id: str, allow: bool) -> dict:
        """Records the decision. The task itself continues in ``resume()``."""
        checkpoint = self.storage.load_checkpoint(task_id)
        if checkpoint is None or checkpoint.get("state") != "waiting-approval":
            return {"ok": False, "error": "no pending approval"}
        self.storage.record_permission(task_id, step_id, allow)
        self.storage.save_checkpoint(
            task_id, {**checkpoint, "state": "approved" if allow else "denied"}
        )
        return {"ok": True, "approved": bool(allow), "taskId": task_id, "stepId": step_id}

    async def resume(self, task_id: str) -> AsyncIterator[dict]:
        """Loads the checkpoint and continues the very same task."""
        checkpoint = self.storage.load_checkpoint(task_id)
        if checkpoint is None:
            yield {"taskId": task_id, "type": "failed", "error": "no checkpoint for this task"}
            return
        state = checkpoint.get("state")
        if state == "denied":
            self.storage.finish_task(task_id, "cancelled")
            self.storage.clear_checkpoint(task_id)
            yield {"taskId": task_id, "type": "cancelled", "reason": "owner denied the step"}
            return
        if state not in ("approved", "running", "recovering", "interrupted"):
            yield {"taskId": task_id, "type": "failed", "error": f"task is {state}, not resumable"}
            return
        # A resume clears any stale cancel flag from the previous attempt.
        self.storage.clear_cancel(task_id)


        yield {
            "taskId": task_id,
            "type": "resumed",
            "stepId": f"s{int(checkpoint['stepIndex']) + 1}",
            "remaining": len(checkpoint["plan"]) - int(checkpoint["stepIndex"]),
        }
        async for event in self._execute(
            task_id,
            checkpoint["goal"],
            checkpoint["plan"],
            int(checkpoint["stepIndex"]),
            checkpoint.get("modelIds") or [],
            checkpoint.get("results") or [],
            approved_index=int(checkpoint["stepIndex"]) if state == "approved" else None,
        ):
            yield event

    def pending(self) -> list[dict]:
        """Every task that is paused or interrupted, straight from disk."""
        return [c for c in self.storage.open_checkpoints() if c]

    # --------------------------------------------------------- execution
    async def _execute(
        self,
        task_id: str,
        goal: str,
        steps: list[dict],
        start: int,
        model_ids: list[str],
        results: list[dict],
        approved_index: int | None = None,
    ) -> AsyncIterator[dict]:
        for index in range(start, len(steps)):
            step = steps[index]
            step_id = f"s{index + 1}"
            tool_name = step.get("tool")
            risk = self.tools.risk(tool_name) if tool_name else "safe"
            if risk == "exec":
                needs_approval = True
            elif risk != "safe":
                needs_approval = not self.auto_approve_writes
            else:
                needs_approval = False

            # Cancellation is checked between steps: a running tool is never
            # torn down mid-write, but no further work starts once asked to stop.
            if self.storage.cancel_requested(task_id):
                self.storage.save_checkpoint(
                    task_id,
                    {
                        "goal": goal,
                        "plan": steps,
                        "stepIndex": index,
                        "state": "cancelled",
                        "modelIds": model_ids,
                        "results": results,
                    },
                )
                self.storage.finish_task(task_id, "cancelled")
                yield {"taskId": task_id, "type": "cancelled", "results": results}
                return

            if needs_approval and index != approved_index:
                self.storage.save_checkpoint(
                    task_id,
                    {
                        "goal": goal,
                        "plan": steps,
                        "stepIndex": index,
                        "state": "waiting-approval",
                        "modelIds": model_ids,
                        "results": results,
                    },
                )
                yield {
                    "taskId": task_id,
                    "stepId": step_id,
                    "type": "approval-required",
                    "tool": tool_name,
                    "risk": self.tools.risk(tool_name),
                    "args": step.get("args", {}),
                }
                return  # continues in resume() once the owner decides

            self.storage.save_checkpoint(
                task_id,
                {
                    "goal": goal,
                    "plan": steps,
                    "stepIndex": index,
                    "state": "running",
                    "modelIds": model_ids,
                    "results": results,
                },
            )
            yield {"taskId": task_id, "stepId": step_id, "type": "running", "title": step["title"]}

            if tool_name:
                step_args = step.get("args", {})
                result: dict = {"ok": False, "error": "step not executed"}
                for attempt in range(1, MAX_STEP_ATTEMPTS + 1):
                    # The owner approved this step (safe tier, or an explicit
                    # approval recorded in the checkpoint). Mint a single-use
                    # authorization for exactly this tool + arguments instead of
                    # asserting a plain boolean the kernel would have to trust.
                    authorization = None
                    if self.tools.risk(tool_name) != "safe":
                        try:
                            authorization = self.tools.authority.issue(
                                tool_name,
                                step_args,
                                self.tools.risk(tool_name),
                                requester=f"planner:{task_id}",
                            )
                        except PermissionError as exc:
                            result = {"ok": False, "error": str(exc)}
                            self.storage.log_step(
                                task_id,
                                step_id,
                                tool_name,
                                result,
                                args=step_args,
                                attempt=attempt,
                                duration_ms=0,
                            )
                            break  # an authorization refusal never improves on retry
                    started = time.monotonic()
                    result = await self.tools.execute(
                        tool_name, step_args, authorization=authorization
                    )
                    duration_ms = int((time.monotonic() - started) * 1000)
                    self.storage.log_step(
                        task_id,
                        step_id,
                        tool_name,
                        result,
                        args=step_args,
                        attempt=attempt,
                        duration_ms=duration_ms,
                    )
                    if result.get("ok"):
                        break
                    if attempt < MAX_STEP_ATTEMPTS:
                        yield {
                            "taskId": task_id,
                            "stepId": step_id,
                            "type": "retry",
                            "attempt": attempt + 1,
                            "error": result.get("error"),
                        }

                results.append({"stepId": step_id, "tool": tool_name, "result": result})
                if not result.get("ok"):
                    brain = self.router.by_role("brain")
                    if brain is not None:
                        await self._write_lesson(brain, goal, step, result)
                    self.storage.save_checkpoint(
                        task_id,
                        {
                            "goal": goal,
                            "plan": steps,
                            "stepIndex": index,
                            "state": "recovering",
                            "modelIds": model_ids,
                            "results": results,
                            "retries": MAX_STEP_ATTEMPTS,
                        },
                    )
                    self.storage.finish_task(task_id, "failed", str(result.get("error") or ""))
                    yield {
                        "taskId": task_id,
                        "stepId": step_id,
                        "type": "failed",
                        "error": result.get("error"),
                    }
                    return
                yield {"taskId": task_id, "stepId": step_id, "type": "done", "result": result}

        self.storage.finish_task(task_id, "done")
        self.storage.clear_checkpoint(task_id)
        self.storage.clear_cancel(task_id)
        yield {"taskId": task_id, "type": "done", "results": results}

    # ------------------------------------------------------------- control
    def cancel(self, task_id: str) -> dict:
        """Ask a running or paused task to stop; the flag lives on disk."""
        self.storage.request_cancel(task_id, "owner cancelled")
        checkpoint = self.storage.load_checkpoint(task_id)
        if checkpoint and checkpoint.get("state") in {"waiting-approval", "recovering", "interrupted"}:
            self.storage.save_checkpoint(task_id, {**checkpoint, "state": "cancelled"})
            self.storage.finish_task(task_id, "cancelled")
        return {"ok": True, "taskId": task_id, "state": "cancelled"}

    def recover(self) -> list[dict]:
        """Mark tasks that were mid-flight when the kernel died as interrupted.

        Called once on startup so a crash leaves resumable work, not a task
        stuck in 'running' forever.
        """
        recovered: list[dict] = []
        for checkpoint in self.pending():
            if checkpoint.get("state") != "running":
                continue
            updated = {**checkpoint, "state": "interrupted"}
            self.storage.save_checkpoint(checkpoint["taskId"], updated)
            self.storage.finish_task(checkpoint["taskId"], "interrupted")
            recovered.append(updated)
        return recovered


    async def _write_lesson(self, brain, goal: str, step: dict, result: dict) -> None:
        if not self.write_lessons:
            return
        text = await self.router.complete(
            brain,
            [
                {"role": "system", "content": LESSON_SYSTEM},
                {
                    "role": "user",
                    "content": f"Goal: {goal}\nStep: {step}\nError: {result.get('error')}",
                },
            ],
        )
        await self.memory.add_lesson(text.strip(), context=goal)
