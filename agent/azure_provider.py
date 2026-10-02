"""Builds the pydantic-ai provider for an Azure endpoint, in either shape:

  - Foundry / v1 style  https://<resource>.services.ai.azure.com/openai/v1
    (plain OpenAI client, `api_key` as the bearer, no api-version) — the same
    shape project-soma uses.
  - Classic Azure OpenAI  https://<resource>.openai.azure.com/  (AzureProvider,
    needs api_version).
"""
from __future__ import annotations

import httpx
from pydantic_ai.providers.azure import AzureProvider
from pydantic_ai.providers.openai import OpenAIProvider


def make_provider(endpoint: str, api_key: str, api_version: str, http_client: httpx.AsyncClient):
    if "/openai/v1" in endpoint:
        return OpenAIProvider(base_url=endpoint.rstrip("/"), api_key=api_key, http_client=http_client)
    return AzureProvider(
        azure_endpoint=endpoint, api_key=api_key, api_version=api_version, http_client=http_client
    )
