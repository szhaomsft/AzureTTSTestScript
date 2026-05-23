"""Create an ElevenLabs Speech Engine for the BYOM test Worker WebSocket."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os

import httpx
from dotenv import load_dotenv
from elevenlabs import AsyncElevenLabs

logger = logging.getLogger(__name__)

# Default display name used in the ElevenLabs dashboard for this test engine.
DEFAULT_ENGINE_NAME = "Voice Live BYOM Test Speech Engine"


async def main() -> None:
    """Create a Speech Engine and print its engine ID."""
    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="[%(asctime)s][%(levelname)s] %(message)s")

    args = _parse_args()
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("Set ELEVENLABS_API_KEY in your environment or .env file.")

    ws_url = _resolve_ws_url(args.ws_url)
    client = AsyncElevenLabs(api_key=api_key)
    engine = await client.speech_engine.create(
        name=args.name,
        speech_engine={"ws_url": ws_url},
    )
    await _enable_first_message_override(api_key=api_key, speech_engine_id=engine.engine_id)

    logger.info("Created Speech Engine %s with ws_url=%s", engine.engine_id, ws_url)
    logger.info("Enabled client first-message override for Speech Engine %s", engine.engine_id)
    print(f"Speech Engine ID: {engine.engine_id}")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default=DEFAULT_ENGINE_NAME, help="Speech Engine display name.")
    parser.add_argument(
        "--ws-url",
        default=os.getenv("SPEECH_ENGINE_WS_URL", os.getenv("PUBLIC_WS_URL", "")),
        help="Public wss:// URL ending in /speech-engine/ws.",
    )
    return parser.parse_args()


def _resolve_ws_url(ws_url: str) -> str:
    normalized = ws_url.strip()
    if not normalized:
        raise RuntimeError("Pass --ws-url or set SPEECH_ENGINE_WS_URL/PUBLIC_WS_URL.")
    if normalized.startswith("https://"):
        normalized = f"wss://{normalized.removeprefix('https://')}"
    if not normalized.startswith("wss://"):
        raise RuntimeError("Speech Engine ws_url must start with wss:// or https://.")
    if not normalized.rstrip("/").endswith("/speech-engine/ws"):
        normalized = f"{normalized.rstrip('/')}/speech-engine/ws"
    return normalized


async def _enable_first_message_override(*, api_key: str, speech_engine_id: str) -> None:
    """Allow the browser client to set overrides.agent.firstMessage."""
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.patch(
            f"https://api.elevenlabs.io/v1/speech-engine/{speech_engine_id}",
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
            json={"overrides": {"first_message": True}},
        )
        response.raise_for_status()


if __name__ == "__main__":
    asyncio.run(main())
