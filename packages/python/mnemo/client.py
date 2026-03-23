"""Mnemo Python client — communicates with @mnemoai/server over HTTP."""

from typing import Optional
import httpx
from mnemo.types import (
    Memory,
    MemoryCategory,
    RecallResult,
    StoreResult,
    Stats,
    HealthStatus,
)


class MnemoError(Exception):
    """Base error for Mnemo operations."""

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


class MnemoClient:
    """
    Python client for the Mnemo REST API.

    Usage:
        client = MnemoClient()  # default: http://localhost:18100
        client.store("User prefers dark mode", category="preference")
        results = client.recall("UI preferences")
        for memory in results:
            print(f"[{memory.score:.2f}] {memory.text}")

    Start the server first:
        npx @mnemoai/server
    """

    def __init__(
        self,
        base_url: str = "http://localhost:18100",
        timeout: float = 30.0,
    ):
        """
        Initialize the Mnemo client.

        Args:
            base_url: URL of the Mnemo server. Default: http://localhost:18100
            timeout: Request timeout in seconds. Default: 30.0
        """
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(base_url=self.base_url, timeout=timeout)

    def store(
        self,
        text: str,
        *,
        category: Optional[MemoryCategory] = None,
        importance: Optional[float] = None,
        scope: Optional[str] = None,
    ) -> StoreResult:
        """
        Store a memory.

        Args:
            text: The text content to remember.
            category: Memory category. Default: "fact".
            importance: Importance score (0.0 to 1.0). Default: 0.7.
            scope: Scope for multi-agent isolation. Default: "global".

        Returns:
            StoreResult with the memory ID.
        """
        body: dict = {"text": text}
        if category is not None:
            body["category"] = category
        if importance is not None:
            body["importance"] = importance
        if scope is not None:
            body["scope"] = scope

        resp = self._request("post", "/store", json=body)
        return StoreResult(**resp.json())

    def recall(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        scope_filter: Optional[list[str]] = None,
        category: Optional[MemoryCategory] = None,
    ) -> RecallResult:
        """
        Recall memories by semantic search.

        Args:
            query: Natural language query.
            limit: Maximum number of results. Default: 5.
            scope_filter: Only search these scopes.
            category: Only return this category.

        Returns:
            RecallResult containing matching memories.
        """
        body: dict = {"query": query}
        if limit is not None:
            body["limit"] = limit
        if scope_filter is not None:
            body["scopeFilter"] = scope_filter
        if category is not None:
            body["category"] = category

        resp = self._request("post", "/recall", json=body)
        return RecallResult(**resp.json())

    def delete(self, memory_id: str) -> bool:
        """
        Delete a memory by ID.

        Args:
            memory_id: The memory ID to delete.

        Returns:
            True if deleted, False if not found.
        """
        resp = self._request("delete", f"/memories/{memory_id}")
        return resp.json().get("deleted", False)

    def stats(self) -> Stats:
        """
        Get memory store statistics.

        Returns:
            Stats with totalEntries, scopeCounts, categoryCounts.
        """
        resp = self._request("get", "/stats")
        return Stats(**resp.json())

    def health(self) -> HealthStatus:
        """
        Check server health.

        Returns:
            HealthStatus with status and version.
        """
        resp = self._request("get", "/health")
        return HealthStatus(**resp.json())

    def close(self):
        """Close the HTTP client."""
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _request(self, method: str, path: str, **kwargs):
        """Make an HTTP request with proper error handling."""
        try:
            resp = getattr(self._client, method)(path, **kwargs)
        except (httpx.ConnectError, httpx.ConnectTimeout, OSError):
            raise MnemoError(
                f"Connection refused — is mnemo-server running? "
                f"(expected at {self.base_url})\n"
                f"Start it with: npx @mnemoai/server"
            )
        except httpx.TimeoutException:
            raise MnemoError(f"Request timed out")

        # Check if response is JSON (not a proxy error page)
        content_type = resp.headers.get("content-type", "")
        if "application/json" not in content_type:
            raise MnemoError(
                f"Connection refused — is mnemo-server running? "
                f"(expected at {self.base_url})\n"
                f"Start it with: npx @mnemoai/server"
            )

        self._check(resp)
        return resp

    def _check(self, resp: httpx.Response):
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("error", resp.text)
            except Exception:
                detail = resp.text
            raise MnemoError(detail, status_code=resp.status_code)
