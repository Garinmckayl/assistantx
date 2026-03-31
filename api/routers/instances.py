"""
Instances router — CRUD for managed OpenClaw instances.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from api.models import Instance, InstanceConfig
from api.services import secrets as secret_vault

router = APIRouter()


def _mgr(request: Request):
    return request.app.state.instance_manager


@router.post("", response_model=Instance, status_code=201)
async def create_instance(config: InstanceConfig, request: Request):
    """Provision a new managed OpenClaw instance."""
    mgr = _mgr(request)
    try:
        instance = await mgr.create_instance(config)
        # Store secrets in vault (not in container)
        secret_vault.store_secrets(instance.id, config)
        # Return instance without secrets in the config
        safe_config = config.model_copy(
            update={
                "anthropic_api_key": "***" if config.anthropic_api_key else None,
                "openai_api_key": "***" if config.openai_api_key else None,
                "telegram_bot_token": "***" if config.telegram_bot_token else None,
            }
        )
        return instance.model_copy(update={"config": safe_config})
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("", response_model=list[Instance])
async def list_instances(request: Request):
    """List all managed instances."""
    mgr = _mgr(request)
    instances = await mgr.list_instances()
    # Mask secrets in response
    result = []
    for inst in instances:
        cfg = inst.config.model_copy(
            update={
                "anthropic_api_key": "***" if inst.config.anthropic_api_key else None,
                "openai_api_key": "***" if inst.config.openai_api_key else None,
                "telegram_bot_token": "***" if inst.config.telegram_bot_token else None,
            }
        )
        result.append(inst.model_copy(update={"config": cfg}))
    return result


@router.get("/{instance_id}", response_model=Instance)
async def get_instance(instance_id: str, request: Request):
    """Get a single instance."""
    mgr = _mgr(request)
    inst = await mgr.get_instance(instance_id)
    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")
    cfg = inst.config.model_copy(
        update={
            "anthropic_api_key": "***" if inst.config.anthropic_api_key else None,
            "openai_api_key": "***" if inst.config.openai_api_key else None,
            "telegram_bot_token": "***" if inst.config.telegram_bot_token else None,
        }
    )
    return inst.model_copy(update={"config": cfg})


@router.delete("/{instance_id}", status_code=204)
async def delete_instance(instance_id: str, request: Request):
    """Destroy a managed instance."""
    mgr = _mgr(request)
    deleted = await mgr.delete_instance(instance_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Instance not found")
    secret_vault.delete_secrets(instance_id)
