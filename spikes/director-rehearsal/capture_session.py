"""Offline capture only: never invokes Hermes or any provider."""
import re

def extract_session_id(stdout, stderr):
    clean = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', stdout + '\n' + stderr)
    ids = re.findall(r'^(?:Session|session_id):\s*([A-Za-z0-9_-]+)\s*$', clean, re.MULTILINE)
    if not ids or len(set(ids)) != 1:
        raise ValueError('No unambiguous session id')
    return ids[0]
