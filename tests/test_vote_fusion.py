"""Tests for backend/orchestrator/vote_fusion.py — full truth table."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from backend.orchestrator.vote_fusion import classify


# ── L2_CONSENSUS: all three agree it's critical ───────────────────────────────

def test_l2_all_true():
    assert classify(True, 0.80, True) == 'L2_CONSENSUS'

def test_l2_ml_exactly_at_threshold():
    # 0.66 > 0.65 → ml_critical = True
    assert classify(True, 0.66, True) == 'L2_CONSENSUS'

def test_l2_ml_high():
    assert classify(True, 1.0, True) == 'L2_CONSENSUS'


# ── L1_DISAGREE: majority critical but one disagrees ─────────────────────────

def test_l1_llm_false():
    # rule + ml critical, but llm says no
    assert classify(True, 0.80, False) == 'L1_DISAGREE'

def test_l1_llm_none():
    # rule + ml critical, llm not available
    assert classify(True, 0.80, None) == 'L1_DISAGREE'

def test_l1_rule_llm_no_ml():
    # rule + llm agree, ml does not
    assert classify(True, 0.50, True) == 'L1_DISAGREE'

def test_l1_rule_llm_ml_at_boundary():
    # ml exactly at threshold → not critical
    assert classify(True, 0.65, True) == 'L1_DISAGREE'

def test_l1_rule_llm_ml_just_below():
    assert classify(True, 0.64, True) == 'L1_DISAGREE'


# ── STANDARD: no critical signal ─────────────────────────────────────────────

def test_standard_no_signal():
    assert classify(False, 0.0, None) == 'STANDARD'

def test_standard_rule_false_ml_high_llm_true():
    # Rule says not critical — not a majority
    assert classify(False, 0.90, True) == 'STANDARD'

def test_standard_rule_false_ml_high_llm_false():
    assert classify(False, 0.90, False) == 'STANDARD'

def test_standard_rule_true_ml_low_llm_false():
    # Only rule fires; llm says no, ml low
    assert classify(True, 0.30, False) == 'STANDARD'

def test_standard_rule_true_ml_low_llm_none():
    # rule True + ml low + llm None → only 1 vote → STANDARD
    assert classify(True, 0.20, None) == 'STANDARD'

def test_standard_all_false():
    assert classify(False, 0.30, False) == 'STANDARD'

def test_standard_ml_at_zero():
    assert classify(False, 0.0, False) == 'STANDARD'

def test_standard_ml_exactly_65():
    # 0.65 is NOT > 0.65 → ml_critical = False
    assert classify(True, 0.65, True) == 'L1_DISAGREE'  # rule+llm agree but ml doesn't → L1

def test_standard_rule_false_ml_mid_llm_none():
    assert classify(False, 0.50, None) == 'STANDARD'


# ── Return type is always str ─────────────────────────────────────────────────

def test_return_type():
    for result in [
        classify(True, 0.9, True),
        classify(True, 0.9, False),
        classify(False, 0.1, None),
    ]:
        assert isinstance(result, str)
        assert result in ('L2_CONSENSUS', 'L1_DISAGREE', 'STANDARD')
