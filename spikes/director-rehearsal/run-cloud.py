#!/usr/bin/env python3
"""One authorized inference batch per exact model; never retries or executes proposals.
Raw CLI logs stay ignored. Retain final assistant content and narrow session metadata.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import time
import urllib.request

B = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('model', choices=['kimi-k3', 'glm-5.3-flash'])
args = parser.parse_args()
model = args.model
for item in json.loads((B / 'evidence/pre-run-lock.json').read_text())['files']:
    assert hashlib.sha256((B / item['path']).read_bytes()).hexdigest() == item['sha256'], f"Frozen input changed: {item['path']}"

record_path = B / 'evidence' / f'{model}.run.json'
# This exclusive marker also prevents retry after a failure/interruption.
with record_path.open('x') as f:
    json.dump({'status': 'reserved_no_retry', 'requestedModel': model}, f)

record = {
    'requestedModel': model, 'requestedProvider': 'ollama-cloud',
    'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
    'promptSha256': hashlib.sha256((B / 'prompt.txt').read_bytes()).hexdigest(),
    'limits': {'hermesRunBudgetSeconds': 120, 'outerTimeoutSeconds': 180, 'maxTurns': 3, 'manualRetries': 0, 'caseCount': 8},
    'note': 'Only LLM inference. No application/media operations; proposals never executed. web is a narrow read-only toolset, NOT a no-tools sandbox. No-tools compliance is checked in session records. Run budget is wall-clock, not a monetary cap.',
}
try:
    tags = json.load(urllib.request.urlopen('https://ollama.com/api/tags', timeout=30))
    record['catalogueMatch'] = [m for m in tags['models'] if m.get('name') == model or m.get('model') == model]
    assert record['catalogueMatch'], 'Exact model absent from live public catalogue'
    command = ['hermes', 'chat', '--oneshot', '--provider', 'ollama-cloud', '--model', model,
               '--toolsets', 'web', '--ignore-rules', '--source', 'tool', '--max-turns', '3',
               '--run-budget', '120', '--query-file', str(B / 'prompt.txt'), '--quiet']
    record['command'] = command
    record['cwd'] = str(B)
    start = time.monotonic()
    p = subprocess.Popen(command, cwd=B, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = p.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        record['outerTimeout'] = True
        os.killpg(p.pid, signal.SIGTERM)
        try:
            stdout, stderr = p.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            stdout, stderr = p.communicate()
    record['elapsedSeconds'] = round(time.monotonic() - start, 3)
    record['exitCode'] = p.returncode
    local = B / 'local-evidence'
    local.mkdir(exist_ok=True)
    (local / f'{model}.stdout.txt').write_bytes(stdout)
    (local / f'{model}.stderr.txt').write_bytes(stderr)
    text = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', stdout.decode('utf-8', 'replace'))
    ids = re.findall(r'Session:\s*([A-Za-z0-9_-]+)', text)
    assert ids and len(set(ids)) == 1, 'No unambiguous exact session ID in CLI output; inspect retained logs, do not rerun'
    sid = ids[-1]
    record['sessionId'] = sid
    home = Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes')))
    db = sqlite3.connect((home / 'state.db').as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    fields = 'id,source,model,system_prompt_hash,started_at,ended_at,end_reason,tool_call_count,api_call_count,input_tokens,output_tokens,reasoning_tokens,billing_provider,billing_base_url'
    row = db.execute(f'SELECT {fields} FROM sessions WHERE id=?', (sid,)).fetchone()
    assert row is not None, 'Exact CLI session not found in canonical store'
    record['session'] = dict(row)
    messages = db.execute('SELECT role,content,tool_calls,finish_reason FROM messages WHERE session_id=? ORDER BY id', (sid,)).fetchall()
    record['observedToolMessages'] = sum(m['role'] == 'tool' for m in messages)
    record['observedToolCalls'] = sum(len(json.loads(m['tool_calls'])) for m in messages if m['tool_calls'])
    finals = [m for m in messages if m['role'] == 'assistant' and m['content'] and not m['tool_calls']]
    assert finals and isinstance(finals[-1]['content'], str), 'No final textual assistant response in exact session'
    final = finals[-1]['content']
    (B / 'evidence' / f'{model}.response.txt').write_text(final)
    record['responseSha256'] = hashlib.sha256(final.encode()).hexdigest()
    record['finishReason'] = finals[-1]['finish_reason']
    record['targetAttribution'] = 'session_verified' if row['model'] == model and row['billing_provider'] == 'ollama-cloud' else 'uncertain_check_session_metadata'
    record['noToolsObserved'] = record['observedToolMessages'] == record['observedToolCalls'] == row['tool_call_count'] == 0
    record['status'] = 'response_retained' if p.returncode == 0 else 'nonzero_exit_response_retained'
    db.close()
except Exception as exc:
    record['status'] = 'blocked_or_transport_failure'
    record['error'] = f'{type(exc).__name__}: {exc}'
finally:
    record['endedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
    record_path.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record, indent=2))
