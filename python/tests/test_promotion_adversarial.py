"""Independent reviewer regressions: fake registry only, no numerical work."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import footprint_ml_promotion as promotion
import test_promotion as fixtures


class PromotionAdversarialTests(unittest.TestCase):
    def scenario(self):
        fixture = fixtures.PromotionTests("test_exact_promotion_and_read_only_historical_retry")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        return fixture

    @staticmethod
    def set_expiry(request, stamp):
        request = copy.deepcopy(request)
        request["payload"]["validUntil"] = stamp
        canonical = json.dumps(request["payload"], sort_keys=True, separators=(",", ":"))
        request["payloadCanonicalJson"] = canonical
        request["payloadSha256"] = hashlib.sha256(canonical.encode()).hexdigest()
        return request

    def test_expiry_during_intent_persistence_prevents_the_alias_call(self):
        fixture = self.scenario()
        request = self.set_expiry(fixture.request, 1005)
        clock = [1.000]
        original = fixture.publisher._write_journal

        def persist(state):
            original(state)
            if state["entries"] and state["entries"][-1]["status"] == "pending":
                # The approval is valid before this real intent write, but
                # expired before the application would invoke the alias API.
                clock[0] = 1.010

        with patch.object(promotion.time, "time", side_effect=lambda: clock[0]), \
                patch.object(fixture.publisher, "_write_journal", side_effect=persist):
            result = fixture.publisher.publish(request)
        self.assertFalse(result["allowed"], result)
        self.assertEqual(fixture.registry.mutations, 0,
                         "An approval already expired before invocation must not change the alias")

    def test_commit_capacity_is_checked_before_an_external_alias_effect(self):
        # Measure actual successful record sizes rather than reproducing the
        # receiver's receipt-building algorithm in the regression.
        control = self.scenario()
        with patch.object(promotion.time, "time", return_value=1.000):
            self.assertEqual(control.publisher.publish(control.request)["status"], "published")
            committed = control.publisher.read_state()
        pending = copy.deepcopy(committed)
        pending["entries"][-1].update(status="pending", receipt=None)
        committed_size = len(promotion._json_bytes(committed, limit=promotion.MAX_JOURNAL_BYTES)) + 1
        pending_size = len(promotion._json_bytes(pending, limit=promotion.MAX_JOURNAL_BYTES)) + 1
        self.assertGreater(committed_size, pending_size)
        capacity = (committed_size + pending_size) // 2
        fixture = self.scenario()
        with patch.object(promotion, "MAX_JOURNAL_BYTES", capacity), \
                patch.object(promotion.time, "time", return_value=1.000):
            result = fixture.publisher.publish(fixture.request)
        self.assertFalse(result["allowed"], result)
        self.assertEqual(fixture.registry.mutations, 0,
                         "A journal known to lack receipt capacity must refuse before the alias effect")

    def test_boolean_receipt_schema_is_not_integer_version_one(self):
        fixture = self.scenario()
        self.assertEqual(fixture.publisher.publish(fixture.request)["status"], "published")
        path = fixture.root / "journal" / "journal.json"
        state = json.loads(path.read_text())
        state["entries"][0]["receipt"]["schemaVersion"] = True
        path.write_text(json.dumps(state))
        result = fixture.lookup()
        self.assertFalse(result["allowed"], result)
        self.assertEqual(fixture.registry.mutations, 1)


if __name__ == "__main__":
    unittest.main()
