"""Tests for the independent personal comfort rule engine."""

import pytest

from comfort import get_comfort


@pytest.mark.parametrize(
    "temp_c, preference, expected",
    [
        (17, "normal", "cold"),
        (18, "normal", "comfortable"),
        (27.9, "normal", "comfortable"),
        (28, "normal", "hot"),
        (20, "cold_sensitive", "cold"),
        (22, "cold_sensitive", "comfortable"),
        (30, "cold_sensitive", "hot"),
        (15, "heat_sensitive", "cold"),
        (20, "heat_sensitive", "comfortable"),
        (24, "heat_sensitive", "hot"),
    ],
)
def test_comfort_categories(temp_c, preference, expected):
    result = get_comfort(temp_c, preference, False)
    assert result["comfort"] == expected
    assert set(result) == {"comfort", "advice"}
    assert isinstance(result["advice"], str) and result["advice"]


@pytest.mark.parametrize("temp_c", [10, 21, 32])
def test_outdoor_changes_advice_not_classification(temp_c):
    inside = get_comfort(temp_c, "normal", False)
    outside = get_comfort(temp_c, "normal", True)
    assert inside["comfort"] == outside["comfort"]
    assert inside["advice"] != outside["advice"]


def test_invalid_preference():
    with pytest.raises(ValueError):
        get_comfort(20, "unknown", True)


def test_invalid_temperature():
    with pytest.raises(ValueError):
        get_comfort(float("nan"), "normal", True)


def test_invalid_outdoor():
    with pytest.raises(TypeError):
        get_comfort(20, "normal", "yes")
