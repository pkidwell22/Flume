import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capture_session import extract_session_id

class CaptureTest(unittest.TestCase):
    def test_quiet_id_is_on_stderr(self):
        self.assertEqual(extract_session_id('{"version":1}', '\nsession_id: 20261016_224847_79afbc\n'), '20261016_224847_79afbc')

    def test_legacy_stdout_banner(self):
        self.assertEqual(extract_session_id('Session: 20261016_224847_79afbc', ''), '20261016_224847_79afbc')

    def test_conflicting_or_absent_ids_fail_closed(self):
        with self.assertRaises(ValueError):
            extract_session_id('Session: 20261016_224847_79afbc', 'session_id: 20261016_224911_2e5586')
        with self.assertRaises(ValueError):
            extract_session_id('{}', '')

if __name__ == '__main__':
    unittest.main()
