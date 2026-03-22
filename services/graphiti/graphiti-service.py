#!/usr/bin/env python3
"""
graphiti-service.py
Graphiti Temporal Knowledge Graph - FastAPI Microservice

Provides REST API for the Mnemo memory system, wrapping graphiti-core:
  - POST /episodes      Write conversation episodes (auto entity extraction)
  - POST /search        Temporal-aware semantic search
  - POST /spread        Spreading activation (associative recall)
  - POST /facts/expire  Mark facts as expired
  - GET  /health        Health check

Environment variables:
  NEO4J_URI         (default: bolt://neo4j:7687)
  NEO4J_USER        (default: neo4j)
  NEO4J_PASSWORD    (default: mnemo-dev)
  GRAPHITI_PORT     (default: 18799)
  OPENAI_API_KEY    (used by graphiti-core for entity extraction)
  ANTHROPIC_API_KEY (alternative LLM provider)
"""

import os
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# --- Logging ---

logging.basicConfig(
    level=logging.INFO,
    format="[graphiti-service] %(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger(__name__)

# --- Configuration ---

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://neo4j:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "mnemo-dev")
GRAPHITI_PORT = int(os.environ.get("GRAPHITI_PORT", "18799"))

# --- Graphiti Client ---

graphiti_client = None

app = FastAPI(title="Mnemo Graphiti Service", version="1.0.0")


async def init_graphiti():
    """Initialize Graphiti client and connect to Neo4j."""
    global graphiti_client
    try:
        from graphiti_core import Graphiti

        graphiti_client = Graphiti(
            uri=NEO4J_URI,
            user=NEO4J_USER,
            password=NEO4J_PASSWORD,
        )
        await graphiti_client.build_indices_and_constraints()
        logger.info("Graphiti client initialized, connected to Neo4j: %s", NEO4J_URI)
    except Exception as e:
        logger.error("Graphiti initialization failed: %s", str(e))
        logger.error("Service will run in degraded mode (all writes/queries return empty)")
        graphiti_client = None


async def close_graphiti():
    """Close Graphiti client."""
    global graphiti_client
    if graphiti_client:
        try:
            await graphiti_client.close()
            logger.info("Graphiti client closed")
        except Exception as e:
            logger.warning("Error closing Graphiti: %s", str(e))
        graphiti_client = None


@app.on_event("startup")
async def startup():
    await init_graphiti()


@app.on_event("shutdown")
async def shutdown():
    await close_graphiti()


# --- Request/Response Models ---


class EpisodeRequest(BaseModel):
    """Write a conversation episode."""
    text: str
    group_id: str = "default"
    reference_time: Optional[str] = None
    source: str = "mnemo-memory"
    category: Optional[str] = None


class SearchRequest(BaseModel):
    """Temporal-aware semantic search."""
    query: str
    group_id: str = "default"
    limit: int = 10
    center_date: Optional[str] = None


class SearchResult(BaseModel):
    """A single search result."""
    fact: str
    source_node: Optional[str] = None
    target_node: Optional[str] = None
    created_at: Optional[str] = None
    valid_at: Optional[str] = None
    expired_at: Optional[str] = None
    score: Optional[float] = None
    degree: Optional[int] = None


class SpreadRequest(BaseModel):
    """Spreading activation request."""
    query: str
    group_id: str = "default"
    search_limit: int = 3
    spread_depth: int = 1
    spread_limit: int = 10


class ExpireRequest(BaseModel):
    """Mark matching facts as expired."""
    text: str
    expired_at: str
    reason: Optional[str] = None


# --- API Endpoints ---


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok" if graphiti_client else "degraded",
        "neo4j_uri": NEO4J_URI,
        "message": "Graphiti client ready" if graphiti_client else "Graphiti not initialized, running degraded",
    }


@app.post("/episodes")
async def add_episode(req: EpisodeRequest):
    """
    Write a conversation episode to the Graphiti knowledge graph.
    Graphiti automatically:
    1. Extracts entities (people, companies, projects, etc.)
    2. Identifies relationships between entities
    3. Handles temporal changes (versioned relationship values)
    """
    if not graphiti_client:
        logger.warning("Degraded mode: skipping episode write")
        return {"ok": True, "degraded": True, "message": "Graphiti not ready, skipped"}

    try:
        ref_time = datetime.now(timezone.utc)
        if req.reference_time:
            try:
                ref_time = datetime.fromisoformat(req.reference_time)
            except ValueError:
                pass

        enriched_text = req.text
        if req.category:
            enriched_text = f"[{req.category}] {req.text}"

        await graphiti_client.add_episode(
            name=f"mnemo-{req.group_id}-{ref_time.strftime('%Y%m%d%H%M%S')}",
            episode_body=enriched_text,
            reference_time=ref_time,
            group_id=req.group_id,
            source_description=req.source,
        )

        logger.info(
            "Episode written: group=%s, category=%s, text=%s...",
            req.group_id, req.category, req.text[:60],
        )
        return {"ok": True, "degraded": False}

    except Exception as e:
        logger.error("Failed to write episode: %s", str(e))
        return {"ok": False, "error": str(e)}


@app.post("/search", response_model=list[SearchResult])
async def search(req: SearchRequest):
    """
    Temporal-aware semantic search.
    Returns facts/relationships relevant to the query with timestamps.
    """
    if not graphiti_client:
        logger.warning("Degraded mode: search returns empty")
        return []

    try:
        center = datetime.now(timezone.utc)
        if req.center_date:
            try:
                center = datetime.fromisoformat(req.center_date)
            except ValueError:
                pass

        results = await graphiti_client.search(
            query=req.query,
            group_ids=[req.group_id],
            num_results=req.limit,
        )

        # Collect node UUIDs for batch degree query
        node_uuids = set()
        for edge in results:
            if hasattr(edge, 'source_node_uuid') and edge.source_node_uuid:
                node_uuids.add(str(edge.source_node_uuid))
            if hasattr(edge, 'target_node_uuid') and edge.target_node_uuid:
                node_uuids.add(str(edge.target_node_uuid))

        # Batch query node degree + name
        node_info: dict[str, dict] = {}
        if node_uuids and graphiti_client and hasattr(graphiti_client, 'driver'):
            try:
                driver = graphiti_client.driver
                async with driver.session() as session:
                    cypher = """
                    UNWIND $uuids AS uid
                    MATCH (n {uuid: uid})
                    OPTIONAL MATCH (n)-[r]-()
                    RETURN uid, n.name AS name, count(r) AS degree
                    """
                    result = await session.run(cypher, uuids=list(node_uuids))
                    records = await result.data()
                    for rec in records:
                        node_info[rec['uid']] = {
                            'name': rec.get('name', ''),
                            'degree': rec.get('degree', 0),
                        }
            except Exception as de:
                logger.warning("Degree query failed (degrading to no degree): %s", str(de))

        output = []
        for edge in results:
            src_uuid = str(edge.source_node_uuid) if hasattr(edge, 'source_node_uuid') and edge.source_node_uuid else None
            tgt_uuid = str(edge.target_node_uuid) if hasattr(edge, 'target_node_uuid') and edge.target_node_uuid else None
            src_info = node_info.get(src_uuid, {}) if src_uuid else {}
            tgt_info = node_info.get(tgt_uuid, {}) if tgt_uuid else {}
            src_name = src_info.get('name') or (edge.source_node_name if hasattr(edge, 'source_node_name') else None)
            tgt_name = tgt_info.get('name') or (edge.target_node_name if hasattr(edge, 'target_node_name') else None)
            degree = src_info.get('degree', 0) + tgt_info.get('degree', 0)

            output.append(SearchResult(
                fact=edge.fact if hasattr(edge, 'fact') else str(edge),
                source_node=src_name,
                target_node=tgt_name,
                created_at=edge.created_at.isoformat() if hasattr(edge, 'created_at') and edge.created_at else None,
                valid_at=edge.valid_at.isoformat() if hasattr(edge, 'valid_at') and edge.valid_at else None,
                expired_at=edge.expired_at.isoformat() if hasattr(edge, 'expired_at') and edge.expired_at else None,
                score=edge.score if hasattr(edge, 'score') else None,
                degree=degree if degree > 0 else None,
            ))

        logger.info("Search complete: query='%s', group=%s, results=%d", req.query[:40], req.group_id, len(output))
        return output

    except Exception as e:
        logger.error("Search failed: %s", str(e))
        return []


@app.post("/spread")
async def spread_activation(req: SpreadRequest):
    """
    Spreading activation: search for seed nodes, then traverse graph edges
    to find associated facts. Simulates associative recall.
    """
    if not graphiti_client or not hasattr(graphiti_client, 'driver'):
        return []

    try:
        results = await graphiti_client.search(
            query=req.query,
            group_ids=[req.group_id],
            num_results=req.search_limit,
        )

        seed_uuids = set()
        seed_facts = []
        for edge in results:
            if hasattr(edge, 'source_node_uuid') and edge.source_node_uuid:
                seed_uuids.add(str(edge.source_node_uuid))
            if hasattr(edge, 'target_node_uuid') and edge.target_node_uuid:
                seed_uuids.add(str(edge.target_node_uuid))
            if hasattr(edge, 'fact') and edge.fact:
                seed_facts.append(edge.fact)

        if not seed_uuids:
            return []

        driver = graphiti_client.driver
        spread_facts = []
        async with driver.session() as session:
            cypher = """
            UNWIND $seeds AS seedUuid
            MATCH (seed {uuid: seedUuid})-[r:RELATES_TO]-(neighbor)
            WHERE r.group_id = $groupId
              AND (r.expired_at IS NULL)
              AND neighbor.uuid <> seedUuid
            RETURN DISTINCT r.fact AS fact,
                   seed.name AS from_node,
                   neighbor.name AS to_node,
                   r.valid_at AS valid_at,
                   r.expired_at AS expired_at,
                   r.created_at AS created_at
            ORDER BY r.created_at DESC
            LIMIT $limit
            """
            result = await session.run(
                cypher,
                seeds=list(seed_uuids),
                groupId=req.group_id,
                limit=req.spread_limit,
            )
            records = await result.data()
            for rec in records:
                fact = rec.get('fact', '')
                if fact and fact not in seed_facts:
                    spread_facts.append({
                        "fact": fact,
                        "from_node": rec.get('from_node'),
                        "to_node": rec.get('to_node'),
                        "valid_at": str(rec['valid_at']) if rec.get('valid_at') else None,
                        "expired_at": str(rec['expired_at']) if rec.get('expired_at') else None,
                        "source": "spread",
                    })

        combined = []
        for f in seed_facts:
            combined.append({"fact": f, "source": "search"})
        combined.extend(spread_facts)

        logger.info(
            "Spread activation: query='%s', seeds=%d, spread=%d, total=%d",
            req.query[:40], len(seed_facts), len(spread_facts), len(combined),
        )
        return combined[:req.spread_limit + req.search_limit]

    except Exception as e:
        logger.error("Spread activation failed: %s", str(e))
        return []


@app.post("/facts/expire")
async def expire_fact(req: ExpireRequest):
    """Mark matching facts as expired via Neo4j direct update."""
    if not graphiti_client or not hasattr(graphiti_client, 'driver'):
        raise HTTPException(status_code=503, detail="Graphiti not initialized")

    try:
        async with graphiti_client.driver.session() as session:
            search_text = req.text[:100].strip()
            fragments = [
                f.strip()
                for f in search_text.replace(",", " ").replace(".", " ").split()
                if len(f.strip()) >= 4
            ][:3]

            if not fragments:
                return {"ok": False, "expired": 0, "reason": "no valid search fragments"}

            where_clauses = " OR ".join([f"e.fact CONTAINS $frag{i}" for i in range(len(fragments))])
            params = {f"frag{i}": frag for i, frag in enumerate(fragments)}
            params["expired_at"] = req.expired_at
            params["reason"] = req.reason or "superseded"

            fact_query = f"""
                MATCH (e)
                WHERE e.fact IS NOT NULL
                  AND ({where_clauses})
                  AND (e.expired_at IS NULL OR e.expired_at = '')
                SET e.expired_at = $expired_at,
                    e.expiry_reason = $reason
                RETURN count(e) as cnt
            """
            entity_clauses = " OR ".join([
                f"e.name CONTAINS $frag{i} OR e.summary CONTAINS $frag{i}"
                for i in range(len(fragments))
            ])
            entity_query = f"""
                MATCH (e:Entity)
                WHERE ({entity_clauses})
                  AND (e.expired_at IS NULL OR e.expired_at = '')
                SET e.expired_at = $expired_at,
                    e.expiry_reason = $reason
                RETURN count(e) as cnt
            """

            total_expired = 0
            r1 = await session.run(fact_query, params)
            rec1 = await r1.single()
            total_expired += rec1["cnt"] if rec1 else 0

            r2 = await session.run(entity_query, params)
            rec2 = await r2.single()
            total_expired += rec2["cnt"] if rec2 else 0

            logger.info("Expired %d fact(s) matching: %s reason=%s", total_expired, search_text[:60], req.reason)
            return {"ok": True, "expired": total_expired}

    except Exception as e:
        logger.error("Expire failed: %s", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# --- Entrypoint ---

if __name__ == "__main__":
    logger.info("Starting Mnemo Graphiti Service on port %d", GRAPHITI_PORT)
    logger.info("Neo4j: %s (user: %s)", NEO4J_URI, NEO4J_USER)
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=GRAPHITI_PORT,
        log_level="info",
    )
