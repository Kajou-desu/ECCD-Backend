import os
import sys

# The service refuses to start without a key; set one BEFORE `app` is imported.
os.environ.setdefault("RECOGNITION_SERVICE_KEY", "test-key-" + "x" * 40)
os.environ.setdefault("KNOWN_FACES_DIR", os.path.join(os.path.dirname(__file__), "no-such-dir"))
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
