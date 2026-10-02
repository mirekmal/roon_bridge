"""Expose local Roon playback as an Assist LLM tool."""

from __future__ import annotations

from typing import Any

import probatio
from aiohttp import ClientError
from homeassistant.components import llm
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.llm import LLMContext, ToolInput
from homeassistant.util.json import JsonObjectType

DEFAULT_BRIDGE_URL = "http://local-rdashboard-roon-bridge.local.hass.io:8090"
DOMAIN = "rdashboard_roon_bridge"


class PlayLocalRoonMusicTool(llm.Tool):
    """Search the local Roon library and play a verified match on a player."""

    name = "play_local_roon_music"
    description = (
        "Legacy direct-search tool for the user's local Roon library. Prefer the "
        "search_roon_library MCP tool followed by play_roon_library_request when "
        "those tools are available. This tool can play an exact or unambiguous "
        "artist, album, or track match. If only an artist is supplied, play all of that artist's local Roon music. "
        "For a request for artists similar to a named artist, provide similar_to_artist and a short list of similar_artists; "
        "only artists actually present in the local Roon library will be queued. The default target is the Marantz SACD 30n. "
        "If the user requests Volumio or Volumio Bridge, pass target="
        "media_player.volumio_bridge. Other Roon outputs can be selected by "
        "their Home Assistant media_player entity_id or exact Roon zone name. "
        "Use this for music requests; never target the Jabra assistant speaker. "
        "The library contains local music only and has no streaming sources."
    )
    parameters = probatio.Schema(
        {
            probatio.Optional("artist"): str,
            probatio.Optional("album"): str,
            probatio.Optional("track"): str,
            probatio.Optional("query"): str,
            probatio.Optional("target"): str,
            probatio.Optional("similar_to_artist"): str,
            probatio.Optional("similar_artists"): list[str],
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Resolve and play a local Roon request."""
        args = tool_input.tool_args
        request: dict[str, Any] = {
            key: value.strip()
            for key, value in args.items()
            if key in {"artist", "album", "track", "query", "target", "similar_to_artist"}
            and isinstance(value, str)
            and value.strip()
        }
        similar_artists = args.get("similar_artists")
        if isinstance(similar_artists, list):
            request["similar_artists"] = [
                name.strip() for name in similar_artists
                if isinstance(name, str) and name.strip()
            ][:8]
        if not request:
            raise HomeAssistantError("Podaj wykonawcę, album albo utwór.")

        try:
            session = async_get_clientsession(hass)
            bridge_url = hass.data.get(DOMAIN, {}).get("bridge_url", DEFAULT_BRIDGE_URL)
            async with session.post(f"{bridge_url}/api/roon/play", json=request) as response:
                try:
                    result: dict[str, Any] = await response.json(content_type=None)
                except ValueError as error:
                    raise HomeAssistantError("Mostek Roon zwrócił nieprawidłową odpowiedź.") from error
        except (ClientError, TimeoutError) as error:
            raise HomeAssistantError("Mostek Roon jest chwilowo niedostępny.") from error

        if response.status >= 500:
            raise HomeAssistantError(result.get("error", "Mostek Roon nie wykonał odtwarzania."))
        if result.get("status") == "ambiguous":
            return {
                "status": "ambiguous",
                "message": "Znalazłem kilka pasujących pozycji. Poproś użytkownika o wybór.",
                "matches": result.get("matches", []),
                "target": result.get("target"),
            }
        if result.get("status") == "not_found":
            return {
                "status": "not_found",
                "message": "Nie znalazłem tej pozycji w lokalnej bibliotece Roon.",
                "target": result.get("target"),
            }
        if result.get("status") != "played":
            raise HomeAssistantError(result.get("error", "Nie udało się rozpocząć odtwarzania."))
        return {
            "status": "played",
            "message": "Rozpoczęto odtwarzanie na wybranym odtwarzaczu.",
            "selected": result.get("selected", {}),
            "queued": result.get("queued", []),
            "unavailable_artists": result.get("matches", []),
            "target": result.get("target"),
            "entity_id": result.get("entity_id"),
        }


@callback
def async_get_tools(
    hass: HomeAssistant,
    llm_context: LLMContext,
    api_id: str,
) -> llm.LLMTools | None:
    """Return the Roon tool for Home Assistant's Assist LLM APIs."""
    return llm.LLMTools(
        tools=[PlayLocalRoonMusicTool()],
        prompt=(
            "Jeśli dostępne są narzędzia MCP search_roon_library i play_roon_library_request, "
            "najpierw wyszukaj lokalną bibliotekę narzędziem search_roon_library, "
            "a następnie przekaż wybrane kryteria do play_roon_library_request. "
            "Dla prośby o wszystkie utwory wykonawcy wyszukaj wykonawcę i uruchom jego całą "
            "muzykę z lokalnej biblioteki; nie wybieraj losowego albumu. "
            "Jeśli narzędzia MCP nie są dostępne, użyj play_local_roon_music. "
            "Jeśli użytkownik prosi tylko o wykonawcę bez albumu lub utworu, przekaż artist i nie wybieraj samodzielnie albumu — narzędzie odtworzy całą muzykę tego wykonawcy z biblioteki. "
            "Jeśli użytkownik prosi o muzykę podobną do wykonawcy, rozpoznaj kilku podobnych wykonawców na podstawie publicznie znanych gatunków, stylu i powiązań muzycznych; przekaż nazwę źródłowego wykonawcy w similar_to_artist, a kandydatów jako similar_artists. "
            "Nie twierdź, że sprawdziłeś aktualne źródła internetowe. Narzędzie odtworzy tylko kandydatów znalezionych dokładnie w lokalnej bibliotece Roon i doda ich muzykę do kolejki. "
            "Domyślnie odtwarzaj na Marantzu. Jeśli użytkownik wymieni Volumio, "
            "Volumio Bridge albo odtwarzacz Volumio, przekaż target="
            "media_player.volumio_bridge. Jeśli poda inny odtwarzacz Roon, "
            "przekaż jego Home Assistant media_player entity_id jako target. "
            "Nie zgaduj nazw ani identyfikatorów odtwarzaczy. Jeśli użytkownik nie podał celu, pomiń target i użyj domyślnego Marantza. "
            "Wykonaj najwyżej jedno wywołanie odtwarzania na polecenie; po błędzie celu lub strefy nie próbuj innych odtwarzaczy. "
            "Odpowiadaj po polsku. Jeśli narzędzie zwróci not_found, powiedz, "
            "że utworu nie ma w lokalnej bibliotece. Jeśli zwróci ambiguous, "
            "poproś użytkownika o doprecyzowanie zamiast zgadywać."
        ),
    )
