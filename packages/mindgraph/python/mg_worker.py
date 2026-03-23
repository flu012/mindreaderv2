#!/usr/bin/env python3
"""
Memory Graph Background Worker

Processes memory additions asynchronously to improve response time.
Run as: python mg_worker.py

Queue: ~/.openclaw/memory-graphiti/queue/
"""

import asyncio
import os
import sys
import json
import signal
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

from shared import make_graphiti, CACHE_FILE, QUEUE_DIR

# Graceful shutdown flag
_shutdown = False


def _handle_signal(signum, frame):
    global _shutdown
    _shutdown = True
    print(f"\nReceived signal {signum}, shutting down after current item...")


signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)


async def process_queue_item(g, item_path: Path):
    """Process a single queue item using a shared Graphiti instance."""
    try:
        with open(item_path, 'r') as f:
            item = json.load(f)

        content = item['content']
        source = item.get('source', 'agent')
        group_id = item.get('group_id', '')

        print(f"Processing: {content[:50]}...")

        await g.add_episode(
            name=f"memory-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}",
            episode_body=content,
            source_description=source,
            reference_time=datetime.now(timezone.utc),
            group_id=group_id,
        )

        # Mark as processed
        processed_path = item_path.with_suffix('.processed')
        item_path.rename(processed_path)

        print(f"✅ Processed: {item_path.name}")
        return True

    except Exception as e:
        print(f"❌ Error processing {item_path.name}: {e}")
        # Move to error directory
        error_dir = QUEUE_DIR / 'error'
        error_dir.mkdir(parents=True, exist_ok=True)
        item_path.rename(error_dir / item_path.name)
        return False


async def worker():
    """Main worker loop with graceful shutdown support."""
    global _shutdown
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"🧠 Memory Graph Worker started")
    print(f"   Queue directory: {QUEUE_DIR}")
    print(f"   Press Ctrl+C to stop")

    # Create a single shared Graphiti instance for the worker lifetime
    g = make_graphiti()
    await g.build_indices_and_constraints()

    try:
        while not _shutdown:
            try:
                # Find all pending items
                pending = list(QUEUE_DIR.glob('*.json'))

                if pending:
                    print(f"Found {len(pending)} pending items")
                    for item_path in sorted(pending, key=lambda p: p.stat().st_mtime):
                        if _shutdown:
                            print("Shutdown requested, stopping after current batch.")
                            break
                        await process_queue_item(g, item_path)
                else:
                    # No work, wait a bit (check shutdown flag every second)
                    for _ in range(5):
                        if _shutdown:
                            break
                        await asyncio.sleep(1)

            except Exception as e:
                print(f"Worker error: {e}")
                for _ in range(10):
                    if _shutdown:
                        break
                    await asyncio.sleep(1)
    finally:
        await g.close()

    print("Worker stopped gracefully.")


if __name__ == "__main__":
    asyncio.run(worker())
