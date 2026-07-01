"""Tests for backend/phi_redactor.py — 8 cases."""
import pytest
from backend.phi_redactor import redact


def test_email_redacted():
    text, flag = redact("Contact me at driver@cabinai.io for details.")
    assert "[EMAIL]" in text
    assert "driver@cabinai.io" not in text
    assert flag is True


def test_phone_redacted():
    text, flag = redact("Call me on 9876543210 now.")
    assert "[PHONE]" in text
    assert "9876543210" not in text
    assert flag is True


def test_phone_with_country_code_redacted():
    text, flag = redact("My number is +91-9123456789.")
    assert "[PHONE]" in text
    assert "9123456789" not in text
    assert flag is True


def test_aadhaar_redacted():
    text, flag = redact("Aadhaar: 234567891234 please verify.")
    assert "[AADHAAR]" in text
    assert "234567891234" not in text
    assert flag is True


def test_pan_redacted():
    text, flag = redact("PAN card ABCDE1234F was submitted.")
    assert "[PAN]" in text
    assert "ABCDE1234F" not in text
    assert flag is True


def test_mixed_pii_all_redacted():
    text, flag = redact(
        "Email: user@test.com, phone: 8888888888, Aadhaar: 123456789012, PAN: ABCDE1234F."
    )
    assert "[EMAIL]" in text
    assert "[PHONE]" in text
    assert "[AADHAAR]" in text
    assert "[PAN]" in text
    assert flag is True


def test_clean_text_unchanged():
    original = "Turn left at Biodiversity Junction in 500 metres."
    text, flag = redact(original)
    assert text == original
    assert flag is False


def test_empty_string():
    text, flag = redact("")
    assert text == ""
    assert flag is False


def test_already_redacted_tokens_not_double_replaced():
    original = "Caller [EMAIL] said hi."
    text, flag = redact(original)
    assert text == original
    assert flag is False
