"""
Mnemo — AI memory that forgets intelligently.
Python SDK for the Mnemo REST API.

Usage:
    from mnemo import MnemoClient

    client = MnemoClient()  # connects to http://localhost:18100
    client.store("User prefers dark mode", category="preference")
    results = client.recall("UI preferences")
"""

from mnemo.client import MnemoClient
from mnemo.types import Memory, RecallResult, Stats, MemoryCategory

__all__ = ["MnemoClient", "Memory", "RecallResult", "Stats", "MemoryCategory"]
__version__ = "0.1.1"
