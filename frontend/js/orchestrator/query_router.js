/**
 * Query router — decides AGENT4 (edge) or AGENT6 (cloud AIC100).
 * Rule-based, <1 ms, no model.
 */
const TEMPORAL_TERMS   = new Set(['yesterday','last','history','before','previous','week','month','ago']);
const EXTERNAL_TERMS   = new Set(['weather','traffic','news','nearby','restaurant','hotel',
                                   'station','gas','fuel','price','open','closed','recall',
                                   'service','dealer','warning','light','serious','fix']);
const COMPLEX_TERMS    = new Set(['should','recommend','feel','tired','stop','risk',
                                   'safe','dangerous','advice','suggest','given','considering']);

function extractFeatures(text) {
    const tokens = text.toLowerCase().split(/\s+/);
    const tokenSet = new Set(tokens);
    return {
        token_count:       tokens.length,
        has_temporal_ref:  [...tokenSet].some(t => TEMPORAL_TERMS.has(t)),
        has_external_data: [...tokenSet].some(t => EXTERNAL_TERMS.has(t)),
        is_complex:        [...tokenSet].some(t => COMPLEX_TERMS.has(t)),
        agent7_escalate:   false,
    };
}

function routeQuery(features, busState = {}) {
    if (features.token_count       > 15)         return 'AGENT6';
    if (features.has_temporal_ref)                return 'AGENT6';
    if (features.has_external_data)               return 'AGENT6';
    if (features.is_complex)                      return 'AGENT6';
    if (features.agent7_escalate || busState.agent7_escalate) return 'AGENT6';
    return 'AGENT4';
}

window.extractFeatures = extractFeatures;
window.routeQuery = routeQuery;
