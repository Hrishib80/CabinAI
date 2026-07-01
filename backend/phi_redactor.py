"""Strip PII patterns before cloud egress."""
import re

_PATTERNS = [
    (re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'), '[EMAIL]'),
    (re.compile(r'\b(?:\+?91[-\s]?)?[6-9]\d{9}\b'), '[PHONE]'),
    (re.compile(r'\b\d{12}\b'), '[AADHAAR]'),       # Aadhaar-like 12-digit
    (re.compile(r'\b[A-Z]{5}[0-9]{4}[A-Z]\b'), '[PAN]'),  # Indian PAN card
]


def redact(text: str) -> tuple[str, bool]:
    """Return (cleaned_text, was_redacted_bool)."""
    was_redacted = False
    for pattern, replacement in _PATTERNS:
        new_text = pattern.sub(replacement, text)
        if new_text != text:
            was_redacted = True
            text = new_text
    return text, was_redacted
