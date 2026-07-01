"""
3-engine vote fusion for alert consensus classification.
"""


def classify(rule_vote: bool, ml_vote: float, llm_vote: "bool | None") -> str:
    """
    Returns one of: 'L2_CONSENSUS' | 'L1_DISAGREE' | 'STANDARD'

    L2_CONSENSUS: all three engines agree it's critical
    L1_DISAGREE:  majority says critical but at least one disagrees
    STANDARD:     no critical signal or insufficient votes
    """
    ml_critical = ml_vote > 0.65

    if rule_vote and ml_critical and llm_vote is True:
        return "L2_CONSENSUS"

    if rule_vote and ml_critical and (llm_vote is False or llm_vote is None):
        return "L1_DISAGREE"

    if rule_vote and llm_vote is True and not ml_critical:
        return "L1_DISAGREE"

    return "STANDARD"
