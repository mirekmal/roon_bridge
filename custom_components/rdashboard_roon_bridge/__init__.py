"""Home Assistant LLM tools for the local Rdashboard Roon bridge."""

from typing import Any

from homeassistant.core import HomeAssistant

DOMAIN = "rdashboard_roon_bridge"
DEFAULT_BRIDGE_URL = "http://local-rdashboard-roon-bridge.local.hass.io:8090"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the Rdashboard Roon bridge integration."""
    options: dict[str, Any] = config.get(DOMAIN, {})
    hass.data[DOMAIN] = {
        "bridge_url": str(options.get("bridge_url", DEFAULT_BRIDGE_URL)).rstrip("/")
    }
    return True
