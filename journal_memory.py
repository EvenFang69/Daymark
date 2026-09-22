"""Local evidence, retrieval and user-confirmed memory. No network or UI dependencies."""

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone


PROMPT_VERSION = "evidence-v2"
ROLLUP_VERSION = "memory-rollup-v1"

ROLLUP_BUCKETS = (
    {
        "key": "project_progress",
        "title": "项目推进与验证",
        "phrases": (
            ("项目", 6),
            ("产品", 5),
            ("验证", 5),
            ("测试", 4),
            ("进展", 4),
            ("问题", 3),
            ("方案", 3),
        ),
    },
    {
        "key": "content_creation",
        "title": "内容与创作流程",
        "phrases": (
            ("内容", 6),
            ("视频", 6),
            ("素材", 5),
            ("剪辑", 4),
            ("字幕", 4),
            ("发布", 3),
            ("创作", 3),
            ("流程", 3),
        ),
    },
    {
        "key": "learning_and_review",
        "title": "学习与复盘改进",
        "phrases": (
            ("学习", 6),
            ("复盘", 6),
            ("阅读", 4),
            ("研究", 4),
            ("数据", 3),
            ("判断", 3),
            ("计划", 3),
            ("点击", 3),
            ("改进", 3),
        ),
    },
)


def now():
    return datetime.now(timezone.utc).isoformat()


def dumps(value):
    return json.dumps(value, ensure_ascii=False)


def tokens(text):
    result = set(re.findall(r"[a-z0-9_]{2,}", text.lower()))
    for word in re.findall(r"[\u4e00-\u9fff]+", text):
        result.update(word[i:i + 2] for i in range(len(word) - 1))
    return sorted(result)


def migrate(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS memory_migrations(version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS entry_terms(
            term TEXT NOT NULL, entry_id INTEGER NOT NULL REFERENCES entries(id),
            PRIMARY KEY(term, entry_id));
        CREATE TABLE IF NOT EXISTS topics(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL,
            UNIQUE(user_id,name));
        CREATE TABLE IF NOT EXISTS topic_aliases(
            topic_id INTEGER NOT NULL REFERENCES topics(id), alias TEXT NOT NULL,
            PRIMARY KEY(topic_id,alias));
        CREATE TABLE IF NOT EXISTS entry_topics(
            entry_id INTEGER NOT NULL REFERENCES entries(id), topic_id INTEGER NOT NULL REFERENCES topics(id),
            PRIMARY KEY(entry_id,topic_id));
        CREATE TABLE IF NOT EXISTS proposals(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
            text TEXT NOT NULL, reason TEXT NOT NULL, sources_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'proposed', dedupe_key TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE(user_id,kind,dedupe_key));
        CREATE TABLE IF NOT EXISTS memory_rollups(
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            rollup_key TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            next_action TEXT NOT NULL,
            reason TEXT NOT NULL,
            proposal_ids_json TEXT NOT NULL DEFAULT '[]',
            source_entry_ids_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'ready',
            model TEXT NOT NULL DEFAULT 'heuristic',
            fingerprint TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(user_id,rollup_key));
        CREATE TABLE IF NOT EXISTS proposal_events(
            id INTEGER PRIMARY KEY, proposal_id INTEGER NOT NULL REFERENCES proposals(id),
            previous_status TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS background_versions(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, proposal_id INTEGER,
            text TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS report_versions(
            id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES daily_reports(id),
            content_json TEXT NOT NULL, fingerprint TEXT NOT NULL, model TEXT NOT NULL,
            prompt_version TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS feedback(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, entry_id INTEGER NOT NULL REFERENCES entries(id),
            analysis_version INTEGER, rating TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS report_feedback(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
            report_id INTEGER NOT NULL REFERENCES daily_reports(id),
            rating TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS answers(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, question TEXT NOT NULL,
            content_json TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'ready', error TEXT NOT NULL DEFAULT '',
            source_entry_ids_json TEXT NOT NULL DEFAULT '[]', request_id TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
    """)
    columns = {r[1] for r in conn.execute("PRAGMA table_info(entry_relations)")}
    if "verification" not in columns:
        conn.execute("ALTER TABLE entry_relations ADD COLUMN verification TEXT NOT NULL DEFAULT 'legacy_candidate'")
    if not conn.execute("SELECT 1 FROM memory_migrations WHERE version=1").fetchone():
        for row in conn.execute("SELECT id FROM entries WHERE deleted_at IS NULL").fetchall():
            index_entry(conn, row[0])
        conn.execute("""INSERT INTO report_versions(report_id,content_json,fingerprint,model,prompt_version,created_at)
            SELECT id,content_json,source_fingerprint,model,'legacy',created_at FROM daily_reports
            WHERE content_json!='{}'""")
        conn.execute("INSERT INTO memory_migrations VALUES(1)")
    if not conn.execute("SELECT 1 FROM memory_migrations WHERE version=2").fetchone():
        conn.execute("CREATE INDEX IF NOT EXISTS idx_entry_terms_term ON entry_terms(term)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_report_feedback_report ON report_feedback(report_id)")
        conn.execute("INSERT INTO memory_migrations VALUES(2)")
    if not conn.execute("SELECT 1 FROM memory_migrations WHERE version=3").fetchone():
        conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_rollups_user_position ON memory_rollups(user_id,position)")
        conn.execute("INSERT INTO memory_migrations VALUES(3)")
    answer_columns = {row[1] for row in conn.execute("PRAGMA table_info(answers)")}
    for name, definition in (
        ("status", "TEXT NOT NULL DEFAULT 'ready'"),
        ("error", "TEXT NOT NULL DEFAULT ''"),
        ("source_entry_ids_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("request_id", "TEXT"),
        ("updated_at", "TEXT NOT NULL DEFAULT ''"),
    ):
        if name not in answer_columns:
            conn.execute(f"ALTER TABLE answers ADD COLUMN {name} {definition}")
    conn.execute("UPDATE answers SET updated_at=created_at WHERE updated_at='' OR updated_at IS NULL")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_answers_user_created ON answers(user_id,id)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_answers_request ON answers(user_id,request_id) WHERE request_id IS NOT NULL")


def facts(conn, entry_id):
    row = conn.execute("SELECT raw_text FROM entries WHERE id=? AND deleted_at IS NULL", (entry_id,)).fetchone()
    if not row:
        return []
    result = [{"message_id": None, "text": row[0]}]
    result.extend({"message_id": r[0], "text": r[1]} for r in conn.execute(
        "SELECT m.id,m.content FROM messages m JOIN conversations c ON c.id=m.conversation_id "
        "WHERE c.entry_id=? AND m.role='user' AND m.kind!='original' ORDER BY m.id", (entry_id,)))
    try:
        attachments = conn.execute(
            "SELECT original_name, extracted_text FROM attachments WHERE entry_id=? ORDER BY id",
            (entry_id,),
        ).fetchall()
    except sqlite3.OperationalError:
        attachments = []
    for attachment in attachments:
        text = f"附件：{attachment[0]}"
        if attachment[1]:
            text += f"\n{attachment[1]}"
        result.append({"message_id": None, "text": text})
    return result


def index_entry(conn, entry_id):
    row = conn.execute("SELECT user_id FROM entries WHERE id=? AND deleted_at IS NULL", (entry_id,)).fetchone()
    if not row:
        return
    analysis = conn.execute("SELECT data_json FROM entry_analysis WHERE entry_id=? ORDER BY version DESC LIMIT 1", (entry_id,)).fetchone()
    try:
        data = json.loads(analysis[0]) if analysis else {}
    except (TypeError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    text = "\n".join(x["text"] for x in facts(conn, entry_id)) + "\n" + dumps(data)
    conn.execute("DELETE FROM entry_terms WHERE entry_id=?", (entry_id,))
    conn.executemany("INSERT OR IGNORE INTO entry_terms VALUES(?,?)", [(term, entry_id) for term in tokens(text)])
    conn.execute("DELETE FROM entry_topics WHERE entry_id=?", (entry_id,))
    for name in data.get("projects_or_products", []) + data.get("subjects", []):
        if not isinstance(name, str) or not name.strip():
            continue
        name = name.strip()[:100]
        conn.execute("INSERT OR IGNORE INTO topics(user_id,name) VALUES(?,?)", (row[0], name))
        topic = conn.execute("SELECT id FROM topics WHERE user_id=? AND name=?", (row[0], name)).fetchone()[0]
        conn.execute("INSERT OR IGNORE INTO topic_aliases VALUES(?,?)", (topic, name))
        conn.execute("INSERT OR IGNORE INTO entry_topics VALUES(?,?)", (entry_id, topic))


def retrieve(conn, user_id, query, exclude=None, limit=12):
    terms = tokens(query)[:180]
    if not terms:
        return []
    aliases = conn.execute("SELECT t.name,a.alias FROM topics t JOIN topic_aliases a ON a.topic_id=t.id WHERE t.user_id=?", (user_id,))
    for name, alias in aliases:
        if alias in query:
            terms.extend(tokens(name))
    terms = sorted(set(terms))[:240]
    slots = ",".join("?" for _ in terms)
    rows = conn.execute(f"""SELECT e.*,COUNT(*) AS relevance FROM entry_terms t JOIN entries e ON e.id=t.entry_id
        WHERE e.user_id=? AND e.deleted_at IS NULL AND e.id!=? AND t.term IN ({slots}) GROUP BY e.id
        ORDER BY relevance DESC,e.record_date DESC,e.id DESC LIMIT ?""", (user_id, exclude or -1, *terms, limit)).fetchall()
    if rows:
        return rows
    # A broad question may not contain a term that was indexed verbatim. Keep
    # the personal context useful without pretending that it is a match.
    return conn.execute(
        """SELECT e.*,0 AS relevance FROM entries e
           WHERE e.user_id=? AND e.deleted_at IS NULL AND e.id!=?
           ORDER BY e.record_date DESC,e.created_at DESC LIMIT ?""",
        (user_id, exclude or -1, min(limit, 6)),
    ).fetchall()


def context(conn, user_id, query, exclude=None):
    entries = []
    for row in retrieve(conn, user_id, query, exclude, 8):
        analysis = conn.execute("SELECT version,data_json FROM entry_analysis WHERE entry_id=? ORDER BY version DESC LIMIT 1", (row["id"],)).fetchone()
        entries.append({"id": row["id"], "record_date": row["record_date"],
                        "facts": [{**f, "text": f["text"][:2400]} for f in facts(conn, row["id"])],
                        "analysis_version": analysis[0] if analysis else None,
                        "interpretation": safe_json(analysis[1]) if analysis else None})
    background = conn.execute("SELECT text FROM background_versions WHERE user_id=? ORDER BY id DESC LIMIT 1", (user_id,)).fetchone()
    return {"confirmed_background": background[0] if background else "", "related_entries": entries,
            "instruction": "Only user facts are evidence. Interpretations are fallible. Missing mentions do not mean abandoned or completed."}


def references(conn, user_id, ids, allowed=None):
    result = []
    for entry_id in dict.fromkeys(i for i in ids if isinstance(i, int) and not isinstance(i, bool)):
        if allowed is not None and entry_id not in allowed:
            continue
        row = conn.execute("SELECT record_date FROM entries WHERE id=? AND user_id=? AND deleted_at IS NULL", (entry_id, user_id)).fetchone()
        if not row:
            continue
        version = conn.execute("SELECT MAX(version) FROM entry_analysis WHERE entry_id=?", (entry_id,)).fetchone()[0]
        result.append({"entry_id": entry_id, "analysis_version": version, "record_date": row[0],
                       "message_ids": [f["message_id"] for f in facts(conn, entry_id) if f["message_id"]]})
    return result


def propose(conn, user_id, kind, text, reason, refs):
    if kind not in ("action", "background") or not text.strip() or not refs:
        return None
    key = hashlib.sha256(re.sub(r"[\W_]+", "", text.lower()).encode()).hexdigest()
    conn.execute("""INSERT OR IGNORE INTO proposals(user_id,kind,text,reason,sources_json,dedupe_key,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)""", (user_id, kind, text[:1200], reason[:1200], dumps(refs), key, now(), now()))
    return conn.execute("SELECT id FROM proposals WHERE user_id=? AND kind=? AND dedupe_key=?", (user_id, kind, key)).fetchone()[0]


def _proposal_sources(proposal):
    sources = proposal.get("sources") if isinstance(proposal, dict) else []
    if sources is None and isinstance(proposal, dict):
        sources = safe_json(proposal.get("sources_json"), [])
    if not isinstance(sources, list):
        return []
    result = []
    for source in sources:
        if isinstance(source, int) and not isinstance(source, bool):
            entry_id = source
            result.append({"entry_id": entry_id})
            continue
        if not isinstance(source, dict):
            continue
        try:
            entry_id = int(source.get("entry_id"))
        except (TypeError, ValueError):
            continue
        if entry_id > 0:
            result.append({**source, "entry_id": entry_id})
    return result


def _proposal_rows(conn, user_id, include_events=False):
    result = []
    deleted_ids = {
        row[0]
        for row in conn.execute(
            "SELECT id FROM entries WHERE user_id=? AND deleted_at IS NOT NULL",
            (user_id,),
        )
    }
    rows = conn.execute(
        "SELECT * FROM proposals WHERE user_id=? ORDER BY updated_at DESC,id DESC",
        (user_id,),
    ).fetchall()
    for row in rows:
        item = dict(row)
        item["sources"] = safe_json(item.pop("sources_json"), [])
        if not isinstance(item["sources"], list):
            item["sources"] = []
        original_sources = list(item["sources"])
        item["sources"] = [
            source
            for source in item["sources"]
            if not isinstance(source, dict) or source.get("entry_id") not in deleted_ids
        ]
        if original_sources and not item["sources"]:
            continue
        if include_events:
            item["events"] = [
                dict(event)
                for event in conn.execute(
                    "SELECT * FROM proposal_events WHERE proposal_id=? ORDER BY id",
                    (item["id"],),
                )
            ]
        result.append(item)
    return result


def _proposal_fingerprint(proposals):
    payload = [
        {
            "id": item.get("id"),
            "kind": item.get("kind"),
            "status": item.get("status"),
            "text": item.get("text"),
            "reason": item.get("reason"),
            "sources": _proposal_sources(item),
            "updated_at": item.get("updated_at"),
        }
        for item in proposals
    ]
    return hashlib.sha256(dumps(payload).encode("utf-8")).hexdigest()


def _rollup_bucket(text):
    value = str(text or "").lower()
    scores = []
    for bucket in ROLLUP_BUCKETS:
        score = sum(weight for phrase, weight in bucket["phrases"] if phrase in value)
        scores.append(score)
    best = max(range(len(scores)), key=lambda index: (scores[index], -index))
    return ROLLUP_BUCKETS[best]


def _clip(value, limit=420):
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def deterministic_rollups(proposals, max_rollups=3):
    """Build a safe, source-preserving view when the AI digest is unavailable."""
    active = [
        item
        for item in proposals
        if item.get("kind") == "action" and item.get("status") not in ("dismissed", "done")
    ]
    groups = {bucket["key"]: [] for bucket in ROLLUP_BUCKETS}
    for proposal in active:
        groups[_rollup_bucket(proposal.get("text", ""))["key"]].append(proposal)

    populated = [
        (bucket, groups[bucket["key"]])
        for bucket in ROLLUP_BUCKETS
        if groups[bucket["key"]]
    ]
    populated.sort(
        key=lambda pair: (
            -len(pair[1]),
            -max((len(_proposal_sources(item)) for item in pair[1]), default=0),
            next(index for index, bucket in enumerate(ROLLUP_BUCKETS) if bucket["key"] == pair[0]["key"]),
        )
    )
    result = []
    for position, (bucket, group) in enumerate(populated[:max_rollups]):
        source_proposal_ids = sorted({int(item["id"]) for item in group})
        source_entry_ids = sorted(
            {
                int(source["entry_id"])
                for item in group
                for source in _proposal_sources(item)
                if source.get("entry_id")
            }
        )
        representative = max(
            group,
            key=lambda item: (
                len(_proposal_sources(item)),
                item.get("updated_at", ""),
                int(item.get("id", 0)),
            ),
        )
        reasons = []
        for item in group:
            reason = re.sub(r"\s+", " ", str(item.get("reason") or "")).strip()
            if reason and reason not in reasons:
                reasons.append(reason)
        reason = (
            f"这个方向在 {len(group)} 条建议中反复出现，"
            f"关联 {len(source_entry_ids)} 条原始记录。"
        )
        if reasons:
            reason += f" 最近一次依据：{_clip(reasons[0], 220)}"
        result.append(
            {
                "position": position,
                "rollup_key": bucket["key"],
                "title": bucket["title"],
                "summary": (
                    f"把相关事项合并成一个验证方向，避免在同一件事上重复开很多条任务。"
                ),
                "next_action": _clip(representative.get("text", ""), 520),
                "reason": _clip(reason, 680),
                "proposal_ids": source_proposal_ids,
                "source_entry_ids": source_entry_ids,
                "status": "ready",
            }
        )
    return result


def save_rollups(conn, user_id, rollups, model="heuristic", fingerprint=None):
    proposals = _proposal_rows(conn, user_id)
    fingerprint = fingerprint or _proposal_fingerprint(proposals)
    previous = {
        row["rollup_key"]: dict(row)
        for row in conn.execute(
            "SELECT rollup_key,created_at FROM memory_rollups WHERE user_id=?",
            (user_id,),
        )
    }
    conn.execute("DELETE FROM memory_rollups WHERE user_id=?", (user_id,))
    timestamp = now()
    for position, item in enumerate(rollups[:3]):
        key = str(item.get("rollup_key") or "").strip()
        title = _clip(item.get("title"), 120)
        summary = _clip(item.get("summary"), 800)
        next_action = _clip(item.get("next_action"), 800)
        reason = _clip(item.get("reason"), 1000)
        proposal_ids = sorted(
            {
                int(value)
                for value in (item.get("proposal_ids") or item.get("source_proposal_ids") or [])
                if str(value).isdigit() and int(value) > 0
            }
        )
        entry_ids = sorted(
            {
                int(value)
                for value in (item.get("source_entry_ids") or [])
                if str(value).isdigit() and int(value) > 0
            }
        )
        if not key or not title or not next_action or not proposal_ids:
            continue
        created_at = previous.get(key, {}).get("created_at") or timestamp
        conn.execute(
            """
            INSERT INTO memory_rollups(
                user_id,position,rollup_key,title,summary,next_action,reason,
                proposal_ids_json,source_entry_ids_json,status,model,fingerprint,
                created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                user_id,
                position,
                key,
                title,
                summary,
                next_action,
                reason,
                dumps(proposal_ids),
                dumps(entry_ids),
                str(item.get("status") or "ready"),
                model,
                fingerprint,
                created_at,
                timestamp,
            ),
        )
    return fingerprint


def ensure_rollups(conn, user_id):
    proposals = _proposal_rows(conn, user_id)
    fingerprint = _proposal_fingerprint(proposals)
    current = conn.execute(
        "SELECT * FROM memory_rollups WHERE user_id=? ORDER BY position,id",
        (user_id,),
    ).fetchall()
    if current and all(row["fingerprint"] == fingerprint for row in current):
        return proposals, fingerprint
    deterministic = deterministic_rollups(proposals)
    save_rollups(conn, user_id, deterministic, model="heuristic", fingerprint=fingerprint)
    return proposals, fingerprint


def _rollup_rows(conn, user_id):
    result = []
    for row in conn.execute(
        "SELECT * FROM memory_rollups WHERE user_id=? ORDER BY position,id",
        (user_id,),
    ):
        item = dict(row)
        item["proposal_ids"] = safe_json(item.pop("proposal_ids_json"), [])
        item["source_entry_ids"] = safe_json(item.pop("source_entry_ids_json"), [])
        item["proposal_count"] = len(item["proposal_ids"])
        item["source_entry_count"] = len(item["source_entry_ids"])
        result.append(item)
    return result


def transition(conn, user_id, proposal_id, status):
    row = conn.execute("SELECT * FROM proposals WHERE id=? AND user_id=?", (proposal_id, user_id)).fetchone()
    if not row:
        raise ValueError("not_found")
    if status == row["status"]:
        return
    allowed = {"proposed": {"accepted", "deferred", "dismissed"}, "deferred": {"accepted", "dismissed"},
               "accepted": {"done", "deferred", "dismissed"}, "done": {"accepted"}, "dismissed": {"accepted"}}
    if status not in allowed.get(row["status"], set()) or (row["kind"] == "background" and status == "done"):
        raise ValueError("invalid_transition")
    conn.execute("UPDATE proposals SET status=?,updated_at=? WHERE id=?", (status, now(), proposal_id))
    conn.execute("INSERT INTO proposal_events(proposal_id,previous_status,status,created_at) VALUES(?,?,?,?)", (proposal_id, row["status"], status, now()))
    if row["kind"] == "background":
        text = "\n".join(r[0] for r in conn.execute("SELECT text FROM proposals WHERE user_id=? AND kind='background' AND status='accepted' ORDER BY id", (user_id,)))
        conn.execute("INSERT INTO background_versions(user_id,proposal_id,text,created_at) VALUES(?,?,?,?)", (user_id, proposal_id, text, now()))


def dashboard(conn, user_id, detail=False):
    proposals, fingerprint = ensure_rollups(conn, user_id)
    rollups = _rollup_rows(conn, user_id)
    active = [
        item
        for item in proposals
        if item.get("kind") == "action" and item.get("status") not in ("dismissed", "done")
    ]
    detail_proposals = _proposal_rows(conn, user_id, include_events=True) if detail else []
    rollup_by_proposal = {
        proposal_id: rollup["rollup_key"]
        for rollup in rollups
        for proposal_id in rollup["proposal_ids"]
    }
    for proposal in detail_proposals:
        proposal["rollup_key"] = rollup_by_proposal.get(proposal["id"]) or _rollup_bucket(proposal["text"])["key"]
    background = conn.execute("SELECT * FROM background_versions WHERE user_id=? ORDER BY id DESC LIMIT 1", (user_id,)).fetchone()
    report_feedback = [
        dict(row) for row in conn.execute(
            "SELECT * FROM report_feedback WHERE user_id=? ORDER BY id DESC LIMIT 50",
            (user_id,),
        )
    ]
    try:
        digest_job = conn.execute(
            "SELECT status,last_error,updated_at FROM ai_jobs WHERE user_id=? AND job_type='memory_digest' ORDER BY id DESC LIMIT 1",
            (user_id,),
        ).fetchone()
    except sqlite3.OperationalError:
        digest_job = None
    return {
        "rollups": rollups,
        "proposals": detail_proposals,
        "proposal_count": len([item for item in proposals if item.get("kind") == "action"]),
        "active_proposal_count": len(active),
        "completed_proposal_count": len(
            [
                item
                for item in proposals
                if item.get("kind") == "action" and item.get("status") in ("dismissed", "done")
            ]
        ),
        "rollup_fingerprint": fingerprint,
        "detail": bool(detail),
        "digest": dict(digest_job) if digest_job else None,
        "background": dict(background) if background else None,
        "report_feedback": report_feedback,
    }


def save_relations(conn, user_id, entry_id, analysis):
    current = facts(conn, entry_id)
    for link in analysis.get("relations", [])[:6]:
        target = link.get("entry_id")
        kind = link.get("kind")
        if target == entry_id or kind not in ("supports", "contradicts", "updates", "outcome"):
            continue
        refs = references(conn, user_id, [target])
        quote, previous = link.get("quote", ""), link.get("previous_quote", "")
        if not refs or not quote or not previous:
            continue
        if not any(quote in f["text"] for f in current) or not any(previous in f["text"] for f in facts(conn, target)):
            continue
        evidence = {"quote": quote, "previous_quote": previous, "sources": references(conn, user_id, [entry_id, target])}
        conn.execute("""INSERT INTO entry_relations(user_id,from_entry_id,to_entry_id,relation_type,confidence,evidence_json,created_at,verification)
            VALUES(?,?,?,?,?,?,?,'evidence_linked') ON CONFLICT(from_entry_id,to_entry_id,relation_type)
            DO UPDATE SET evidence_json=excluded.evidence_json,verification='evidence_linked'""",
            (user_id, entry_id, target, kind, analysis.get("confidence", 0), dumps(evidence), now()))


def history(conn, user_id, entry_id):
    links = []
    for row in conn.execute("SELECT * FROM entry_relations WHERE user_id=? AND (from_entry_id=? OR to_entry_id=?) ORDER BY id", (user_id, entry_id, entry_id)):
        item = dict(row)
        item["evidence"] = safe_json(item.pop("evidence_json"))
        links.append(item)
    return links


def safe_json(value, fallback=None):
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def export_extra(conn, user_id):
    result = {"schema_version": 4}
    for table in (
        "proposals",
        "memory_rollups",
        "background_versions",
        "feedback",
        "report_feedback",
        "answers",
        "topics",
    ):
        result[table] = [dict(r) for r in conn.execute(f"SELECT * FROM {table} WHERE user_id=? ORDER BY id", (user_id,))]
    for table, parent, key in (("proposal_events", "proposals", "proposal_id"), ("report_versions", "daily_reports", "report_id"), ("topic_aliases", "topics", "topic_id")):
        result[table] = [dict(r) for r in conn.execute(f"SELECT c.* FROM {table} c JOIN {parent} p ON p.id=c.{key} WHERE p.user_id=?", (user_id,))]
    result["review_questions"] = [dict(r) for r in conn.execute("SELECT * FROM review_questions WHERE user_id=?", (user_id,))]
    return result
