"""Minimal deterministic personal comfort recommendations for DayCast.

This is a preference-based rule engine, not a medical or perceived-temperature model.
"""


def get_comfort(temp_c: float, preference: str, outdoor: bool) -> dict[str, str]:
    """Classify temperature and return a short personalized recommendation.

    Preference shifts the cold/hot thresholds (degrees Celsius):
      cold_sensitive: cold below 22, hot at or above 30
      normal:         cold below 18, hot at or above 28
      heat_sensitive: cold below 16, hot at or above 24
    """
    thresholds = {
        "cold_sensitive": (22, 30),
        "normal": (18, 28),
        "heat_sensitive": (16, 24),
    }
    if preference not in thresholds:
        raise ValueError("preference must be cold_sensitive, normal, or heat_sensitive")
    if isinstance(temp_c, bool) or not isinstance(temp_c, (int, float)):
        raise TypeError("temp_c must be a number")
    if not isinstance(outdoor, bool):
        raise TypeError("outdoor must be a boolean")
    if not float('-inf') < temp_c < float('inf'):
        raise ValueError("temp_c must be finite")

    cold_below, hot_from = thresholds[preference]
    if temp_c < cold_below:
        return {
            "comfort": "cold",
            "advice": "Wear a warm jacket outdoors." if outdoor else "Wear a warm layer indoors.",
        }
    if temp_c >= hot_from:
        return {
            "comfort": "hot",
            "advice": "Bring water and seek shade outdoors." if outdoor else "Stay hydrated and keep the room cool.",
        }
    return {
        "comfort": "comfortable",
        "advice": "Dress in comfortable layers for outdoors." if outdoor else "Wear comfortable indoor clothing.",
    }
