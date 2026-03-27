"""
Workflow tasks — Kanban-style task management per instance.
Stored in-memory with JSON persistence.
"""

import json
import logging
import os
import time
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger("assistantx.workflows")

router = APIRouter()

# In-memory store: {instance_id: [task, ...]}
_tasks: dict[str, list[dict]] = {}
_PERSIST_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "workflows.json")


def _load():
    global _tasks
    try:
        with open(_PERSIST_PATH) as f:
            _tasks = json.load(f)
    except Exception:
        _tasks = {}


def _save():
    try:
        with open(_PERSIST_PATH, "w") as f:
            json.dump(_tasks, f)
    except Exception as exc:
        logger.warning("Failed to persist workflows: %s", exc)


_load()


class TaskCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    status: Optional[str] = "todo"  # todo, in_progress, done
    template_id: Optional[str] = None
    channels: Optional[list[str]] = []  # e.g. ["telegram", "slack"]
    schedule: Optional[str] = None  # e.g. "daily 9am", "weekly monday"


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    channels: Optional[list[str]] = None
    schedule: Optional[str] = None


# Pre-built templates
TEMPLATES = [
    {
        "id": "overnight-email",
        "title": "Overnight Email Summary",
        "description": "Parses emails received overnight and posts a concise summary to your Slack or Telegram channel every morning.",
        "category": "calendar-email",
        "channels": ["slack", "telegram"],
        "schedule": "daily 8am",
        "icon": "mail",
    },
    {
        "id": "meeting-prep",
        "title": "Meeting Prep Briefing",
        "description": "Checks your Google Calendar for upcoming meetings, identifies those missing agendas, and sends prep reminders via WhatsApp or Telegram.",
        "category": "calendar-email",
        "channels": ["whatsapp", "telegram"],
        "schedule": "daily 8am",
        "icon": "calendar",
    },
    {
        "id": "hiring-digest",
        "title": "Hiring Pipeline Digest",
        "description": "Summarizes new job applicants from your ATS and posts a daily digest to Slack with key candidate highlights.",
        "category": "calendar-email",
        "channels": ["slack"],
        "schedule": "daily 9am",
        "icon": "users",
    },
    {
        "id": "competitor-intel",
        "title": "Competitor Intelligence Brief",
        "description": "Searches the web for news and activity about your competitors and delivers a weekly roundup via email or Slack.",
        "category": "web-search",
        "channels": ["slack", "telegram"],
        "schedule": "weekly monday",
        "icon": "search",
    },
    {
        "id": "github-pr-summary",
        "title": "GitHub PR Summary",
        "description": "Monitors your repositories for new PRs and posts a daily summary with review status to Slack or Discord.",
        "category": "developer",
        "channels": ["slack", "discord"],
        "schedule": "daily 9am",
        "icon": "github",
    },
    {
        "id": "daily-standup",
        "title": "Daily Standup Report",
        "description": "Collects yesterday's activity from GitHub commits, calendar events, and Slack messages to generate a standup update.",
        "category": "calendar-email",
        "channels": ["slack", "telegram"],
        "schedule": "daily 9:30am",
        "icon": "clipboard",
    },
    {
        "id": "news-digest",
        "title": "Industry News Digest",
        "description": "Searches for the latest news in your industry and delivers a curated morning briefing with key takeaways.",
        "category": "web-search",
        "channels": ["telegram", "slack"],
        "schedule": "daily 7am",
        "icon": "globe",
    },
    {
        "id": "social-monitor",
        "title": "Social Media Monitor",
        "description": "Tracks mentions of your brand or keywords on X/Twitter and alerts you in real-time via Telegram or Discord.",
        "category": "web-search",
        "channels": ["telegram", "discord"],
        "schedule": "every 2h",
        "icon": "radio",
    },
    {
        "id": "expense-tracker",
        "title": "Expense Report Assistant",
        "description": "Parses receipt emails and bank notifications, categorizes expenses, and posts a weekly summary.",
        "category": "calendar-email",
        "channels": ["slack", "telegram"],
        "schedule": "weekly friday",
        "icon": "receipt",
    },
    {
        "id": "deploy-notifier",
        "title": "Deploy Notifier",
        "description": "Watches your CI/CD pipeline and posts deployment status updates to Slack and Discord channels.",
        "category": "developer",
        "channels": ["slack", "discord"],
        "schedule": "on-event",
        "icon": "rocket",
    },
]


@router.get("/{instance_id}/workflows")
async def list_tasks(instance_id: str, request: Request):
    """List all workflow tasks for an instance."""
    mgr = request.app.state.instance_manager
    inst = await mgr.get_instance(instance_id)
    if not inst:
        raise HTTPException(404, "Instance not found")
    return {"tasks": _tasks.get(instance_id, [])}


@router.post("/{instance_id}/workflows")
async def create_task(instance_id: str, body: TaskCreate, request: Request):
    """Create a new workflow task."""
    mgr = request.app.state.instance_manager
    inst = await mgr.get_instance(instance_id)
    if not inst:
        raise HTTPException(404, "Instance not found")

    task = {
        "id": str(uuid.uuid4())[:8],
        "title": body.title,
        "description": body.description or "",
        "status": body.status or "todo",
        "template_id": body.template_id,
        "channels": body.channels or [],
        "schedule": body.schedule,
        "created_at": time.time(),
    }
    if instance_id not in _tasks:
        _tasks[instance_id] = []
    _tasks[instance_id].append(task)
    _save()
    return task


@router.patch("/{instance_id}/workflows/{task_id}")
async def update_task(instance_id: str, task_id: str, body: TaskUpdate, request: Request):
    """Update a workflow task (e.g. move between columns)."""
    tasks = _tasks.get(instance_id, [])
    for t in tasks:
        if t["id"] == task_id:
            if body.title is not None:
                t["title"] = body.title
            if body.description is not None:
                t["description"] = body.description
            if body.status is not None:
                t["status"] = body.status
            if body.channels is not None:
                t["channels"] = body.channels
            if body.schedule is not None:
                t["schedule"] = body.schedule
            _save()
            return t
    raise HTTPException(404, "Task not found")


@router.delete("/{instance_id}/workflows/{task_id}")
async def delete_task(instance_id: str, task_id: str, request: Request):
    """Delete a workflow task."""
    tasks = _tasks.get(instance_id, [])
    _tasks[instance_id] = [t for t in tasks if t["id"] != task_id]
    _save()
    return {"ok": True}


@router.get("/templates")
async def list_templates():
    """List available workflow templates."""
    return {"templates": TEMPLATES}
