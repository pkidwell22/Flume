#!/usr/bin/env python3
"""Recover already-recorded outputs after the historical runner's banner parse failed.
No inference, network, tool execution, or session writes. Never rerun a model here.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from capture_session import extract_session_id

B = Path(__file__).resolve().parent
home = Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes')))
db = sqlite3.connect((home / 'state.db').as_uri() + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
for model in ['kimi-k3', 'glm-5.3-flash']:
    stdout = (B / 'local-evidence' / f'{model}.stdout.txt').read_text()
    stderr = (B / 'local-evidence' / f'{model}.stderr.txt').read_text()
    sid = extract_session_id(stdout, stderr)
    fields = 'id,source,model,system_prompt_hash,started_at,ended_at,end_reason,tool_call_count,api_call_count,input_tokens,output_tokens,reasoning_tokens,billing_provider,billing_base_url'
    row = db.execute(f'SELECT {fields} FROM sessions WHERE id=?', (sid,)).fetchone()
    assert row is not None
    record = {'capturedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'session': dict(row)}
    config = json.loads(db.execute('SELECT model_config FROM sessions WHERE id=?', (sid,)).fetchone()[0] or '{}')
    record['safeRunConfiguration'] = {k: config[k] for k in ['max_iterations', 'max_tokens', 'reasoning_config'] if k in config}
    messages = db.execute('SELECT role,content,tool_calls,finish_reason FROM messages WHERE session_id=? ORDER BY id', (sid,)).fetchall()
    record['observedToolMessages'] = sum(m['role'] == 'tool' for m in messages)
    record['observedToolCalls'] = sum(len(json.loads(m['tool_calls'])) for m in messages if m['tool_calls'])
    users = [m for m in messages if m['role'] == 'user']
    assert len(users) == 1 and users[0]['content'].encode() == (B / 'prompt.txt').read_bytes(), 'Actual user prompt differs'
    record['actualUserPromptSha256'] = hashlib.sha256(users[0]['content'].encode()).hexdigest()
    finals = [m for m in messages if m['role'] == 'assistant' and m['content'] and not json.loads(m['tool_calls'] or '[]')]
    assert len(finals) == 1 and isinstance(finals[0]['content'], str)
    final = finals[0]['content']
    (B / 'evidence' / f'{model}.response.txt').write_text(final)
    record['responseSha256'] = hashlib.sha256(final.encode()).hexdigest()
    record['finishReason'] = finals[0]['finish_reason']
    record['stdoutMatchesFinalIgnoringSurroundingWhitespace'] = stdout.strip() == final.strip()
    record['targetAttribution'] = 'session_verified' if row['model'] == model and row['billing_provider'] == 'ollama-cloud' and row['billing_base_url'] == 'https://ollama.com/v1' else 'uncertain'
    record['noToolsObserved'] = record['observedToolCalls'] == record['observedToolMessages'] == row['tool_call_count'] == 0
    record['captureIssue'] = 'Inference succeeded. Frozen runner expected Session: on stdout; this Hermes --quiet emitted session_id: on stderr. Original .run.json and raw streams are retained unchanged. This was offline capture recovery, not a model rerun or a transport failure.'
    record['limitations'] = 'Session metadata verifies configured route/model, not independent upstream model attestation. System prompt hashes differ; exact user fixture/prompt bytes are equal. No token cap, seed or temperature was set. Runtime/profile defaults were not modified.'
    (B / 'evidence' / f'{model}.session.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record, indent=2))
db.close()
