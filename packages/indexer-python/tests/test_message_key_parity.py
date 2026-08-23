"""Guards message_utils.build_message_key against drifting from indexer-dotnet's
MessageUtils.BuildMessageKey — both read the same fixtures/message-key-parity.json table, so a
change to one implementation without the other fails here instead of silently breaking
cross-repo/cross-language message-type resolution (see Milestone 4).
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest  # noqa: E402
from message_utils import build_message_key  # noqa: E402

PARITY_TABLE_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "fixtures", "message-key-parity.json")
)

with open(PARITY_TABLE_PATH) as f:
    PARITY_CASES = json.load(f)


@pytest.mark.parametrize("case", PARITY_CASES, ids=[c["input"] for c in PARITY_CASES])
def test_build_message_key_matches_the_shared_parity_table(case):
    assert build_message_key(case["input"]) == case["expectedKey"]
