# Roon Bridge for Home Assistant

This repository distributes two related Home Assistant components:

- A HACS custom integration that exposes local Roon-library playback as an Assist/LLM tool.
- A Home Assistant App that connects to Roon and MQTT, maintains the local music catalog, and provides playback/artwork APIs.

## Install the integration with HACS

In HACS, add `mirekmal/roon_bridge` as a custom **Integration** repository, then download **Rdashboard Roon Bridge** and restart Home Assistant.

## Install the companion app

Add `https://github.com/mirekmal/roon_bridge` to the Home Assistant App store, then install **Rdashboard Roon Bridge**. Configure its MQTT credentials and Roon options as appropriate for your installation. Existing installations should preserve their current app options when migrating.

## Connect the integration to the app

The integration uses the app's internal HTTP endpoint on port `8090`. If the app's internal hostname is not the default configured by the integration, set `bridge_url` in the `rdashboard_roon_bridge:` YAML configuration to `http://<app-hostname>:8090`.

## Repository layout

- `custom_components/rdashboard_roon_bridge/` — HACS integration.
- `roon_bridge_app/` — Supervisor app definition, container build files, and bridge runtime.

The bridge app includes its Node test suite under `roon_bridge_app/test/`.
