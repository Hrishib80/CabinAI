"""Tests for backend/orchestrator/safety_floor.py — 25+ cases."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from backend.orchestrator.safety_floor import dispatch


# ── Cabin hardware commands ───────────────────────────────────────────────────

def test_ac_on():
    r = dispatch("turn on AC")
    assert r is not None
    assert r['action'] == 'CABIN_AC_ON'
    assert r['value'] is True

def test_ac_on_full_phrase():
    r = dispatch("please turn on air conditioning")
    assert r is not None
    assert r['action'] == 'CABIN_AC_ON'

def test_ac_off():
    r = dispatch("turn off AC")
    assert r is not None
    assert r['action'] == 'CABIN_AC_OFF'

def test_ac_off_full_phrase():
    r = dispatch("turn off air conditioning now")
    assert r is not None
    assert r['action'] == 'CABIN_AC_OFF'

def test_lock_doors():
    r = dispatch("lock the doors")
    assert r is not None
    assert r['action'] == 'CABIN_LOCK'

def test_lock_car():
    r = dispatch("lock car")
    assert r is not None
    assert r['action'] == 'CABIN_LOCK'

def test_unlock_doors():
    r = dispatch("unlock the doors")
    assert r is not None
    assert r['action'] == 'CABIN_UNLOCK'

def test_unlock_car():
    r = dispatch("unlock car")
    assert r is not None
    assert r['action'] == 'CABIN_UNLOCK'

def test_open_windows():
    r = dispatch("open windows")
    assert r is not None
    assert r['action'] == 'CABIN_WINDOWS_OPEN'

def test_close_windows():
    r = dispatch("close the window")
    assert r is not None
    assert r['action'] == 'CABIN_WINDOWS_CLOSE'

def test_mute():
    r = dispatch("mute")
    assert r is not None
    assert r['action'] == 'CABIN_MUTE'

def test_unmute():
    r = dispatch("unmute")
    assert r is not None
    assert r['action'] == 'CABIN_UNMUTE'

def test_dismiss_alert():
    r = dispatch("dismiss alert")
    assert r is not None
    assert r['action'] == 'CABIN_DISMISS_ALERT'

def test_cancel_alert():
    r = dispatch("cancel alert")
    assert r is not None
    assert r['action'] == 'CABIN_DISMISS_ALERT'

def test_stop_alert():
    r = dispatch("stop alert")
    assert r is not None
    assert r['action'] == 'CABIN_DISMISS_ALERT'


# ── Game commands ─────────────────────────────────────────────────────────────

def test_speed_up():
    r = dispatch("speed up")
    assert r is not None
    assert r['action'] == 'GAME_SPEED'
    assert r['value'] == 20

def test_faster():
    r = dispatch("go faster")
    assert r is not None
    assert r['action'] == 'GAME_SPEED'
    assert r['value'] == 20

def test_slow_down():
    r = dispatch("slow down")
    assert r is not None
    assert r['action'] == 'GAME_SPEED'
    assert r['value'] == -20

def test_slower():
    r = dispatch("go slower please")
    assert r is not None
    assert r['action'] == 'GAME_SPEED'
    assert r['value'] == -20

def test_brake():
    r = dispatch("brake")
    assert r is not None
    assert r['action'] == 'GAME_SPEED'
    assert r['value'] == -20

def test_stop_driving():
    r = dispatch("stop driving")
    assert r is not None
    assert r['action'] == 'GAME_STOP'

def test_stop_the_car():
    r = dispatch("stop the car")
    assert r is not None
    assert r['action'] == 'GAME_STOP'

def test_weather_rain():
    r = dispatch("make it rain")
    assert r is not None
    assert r['action'] == 'GAME_WEATHER'
    assert r['value'] == 'rain'

def test_weather_clear():
    r = dispatch("clear weather")
    assert r is not None
    assert r['action'] == 'GAME_WEATHER'
    assert r['value'] == 'clear'

def test_weather_clear_skies():
    r = dispatch("clear skies")
    assert r is not None
    assert r['action'] == 'GAME_WEATHER'
    assert r['value'] == 'clear'

def test_weather_fog():
    r = dispatch("make it foggy")
    assert r is not None
    assert r['action'] == 'GAME_WEATHER'
    assert r['value'] == 'fog'

def test_pause():
    r = dispatch("pause")
    assert r is not None
    assert r['action'] == 'GAME_PAUSE'

def test_pause_the_drive():
    r = dispatch("pause the drive")
    assert r is not None
    assert r['action'] == 'GAME_PAUSE'

def test_resume():
    r = dispatch("resume")
    assert r is not None
    assert r['action'] == 'GAME_RESUME'

def test_resume_driving():
    r = dispatch("resume driving")
    assert r is not None
    assert r['action'] == 'GAME_RESUME'


# ── GAME_JUMP navigation ──────────────────────────────────────────────────────

def test_navigate_to_hitec():
    r = dispatch("navigate to Hi-Tech City")
    assert r is not None
    assert r['action'] == 'GAME_JUMP'
    assert r['value'] == 11  # index 11 in HYDERABAD_ROUTE

def test_take_me_to_biodiversity():
    r = dispatch("take me to Biodiversity Junction")
    assert r is not None
    assert r['action'] == 'GAME_JUMP'
    assert r['value'] == 8

def test_go_to_airport():
    r = dispatch("go to Shamshabad Airport")
    assert r is not None
    assert r['action'] == 'GAME_JUMP'
    assert r['value'] == 16

def test_navigate_to_tunnel():
    r = dispatch("navigate to Durgam Cheruvu Tunnel")
    assert r is not None
    assert r['action'] == 'GAME_JUMP'
    assert r['value'] == 6

def test_navigate_to_orr_highway():
    r = dispatch("take me to ORR Highway")
    assert r is not None
    assert r['action'] == 'GAME_JUMP'
    assert r['value'] == 15


# ── No-match (should return None) ─────────────────────────────────────────────

def test_no_match_weather_query():
    r = dispatch("what is the weather like today?")
    assert r is None

def test_no_match_general_question():
    r = dispatch("how are you doing?")
    assert r is None

def test_no_match_unknown_location():
    r = dispatch("navigate to Paris")
    assert r is None

def test_empty_string():
    r = dispatch("")
    assert r is None


# ── Latency field present ─────────────────────────────────────────────────────

def test_latency_field_present():
    r = dispatch("mute")
    assert r is not None
    assert 'latency_ms' in r
    assert isinstance(r['latency_ms'], float)
    assert r['latency_ms'] < 50  # must be sub-50ms

def test_label_field_present():
    r = dispatch("lock the doors")
    assert r is not None
    assert 'label' in r
    assert isinstance(r['label'], str)
    assert len(r['label']) > 0


# ── Case insensitivity ────────────────────────────────────────────────────────

def test_case_insensitive_ac():
    r = dispatch("TURN ON AC")
    assert r is not None
    assert r['action'] == 'CABIN_AC_ON'

def test_case_insensitive_navigate():
    r = dispatch("NAVIGATE TO HI-TECH CITY")
    assert r is not None
    assert r['action'] == 'GAME_JUMP'
