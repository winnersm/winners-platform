#!/usr/bin/env python3
"""Cliente minimo del Graph API de Meta + carga de configuracion desde .env."""

import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, ".env")

# Codigos que Meta devuelve cuando hay que esperar y reintentar.
#   4/17/32/613/800xx : limites de peticiones
#   1/2               : "An unexpected error has occurred. Please retry your
#                        request later" — el generico que devuelve cuando esta
#                        saturado. Es transitorio y el propio mensaje pide reintentar.
RATE_LIMIT_CODES = {1, 2, 4, 17, 32, 613, 80000, 80004}

# El codigo 1 lo usa Meta para dos cosas distintas, y no se distinguen mas que
# por el texto: "estoy saturado, reintenta" y "me estas pidiendo demasiado de
# golpe". Esperar solo sirve para la primera. Para la segunda hay que pedir
# menos por pagina, y cada espera es tiempo tirado: una campana de cien
# anuncios se pasaba cinco minutos reintentando lo mismo antes de rendirse.
PEDIR_MENOS = "reduce the amount of data"


class ApiError(Exception):
    """Error devuelto por el Graph API, con el payload completo."""

    def __init__(self, err: Dict[str, Any], path: str):
        self.err = err or {}
        self.path = path
        self.code = self.err.get("code")
        self.subcode = self.err.get("error_subcode")
        self.message = self.err.get("error_user_msg") or self.err.get("message") or "error desconocido"
        super().__init__("[{}] {} ({})".format(self.code, self.message, path))

    @property
    def pedir_menos(self) -> bool:
        """¿Meta se queja del tamano de la peticion, no de la frecuencia?"""
        return PEDIR_MENOS in (self.message or "").lower()


def load_env() -> Dict[str, str]:
    """Lee .env como pares clave=valor. Sin dependencias externas."""
    if not os.path.exists(ENV_PATH):
        sys.exit(
            "No existe {}\nCopia la plantilla y rellenala:\n  cp {} {}".format(
                ENV_PATH, os.path.join(HERE, ".env.example"), ENV_PATH
            )
        )
    cfg: Dict[str, str] = {}
    with open(ENV_PATH, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            cfg[key.strip()] = val.strip().strip('"').strip("'")
    return cfg


def require(cfg: Dict[str, str], *keys: str) -> None:
    missing = [k for k in keys if not cfg.get(k) or cfg[k] == "act_"]
    if missing:
        sys.exit("Faltan valores en .env: {}".format(", ".join(missing)))


class Graph:
    """Wrapper sobre el Graph API con reintentos ante rate limit."""

    def __init__(self, token: str, version: str = "v23.0", max_retries: int = 4):
        self.token = token
        self.base = "https://graph.facebook.com/{}".format(version)
        self.max_retries = max_retries
        self.session = requests.Session()
        self.calls = 0

    # -- internos -------------------------------------------------------

    def _request(self, method: str, path: str, **kwargs) -> Any:
        url = "{}/{}".format(self.base, path.lstrip("/"))
        attempt = 0
        while True:
            attempt += 1
            self.calls += 1
            resp = self.session.request(method, url, timeout=120, **kwargs)
            try:
                payload = resp.json()
            except ValueError:
                payload = {}

            if resp.ok and not (isinstance(payload, dict) and "error" in payload):
                return payload

            err = payload.get("error", {}) if isinstance(payload, dict) else {}
            code = err.get("code")
            # Pedir de mas no se arregla esperando: se sale ya para que quien
            # llama pueda reintentar con paginas mas pequenas.
            if PEDIR_MENOS in (err.get("message") or "").lower():
                raise ApiError(err, path)

            if code in RATE_LIMIT_CODES and attempt <= self.max_retries:
                wait = min(300, 30 * (2 ** (attempt - 1)))
                print(
                    "  ! rate limit (code {}) — esperando {}s [intento {}/{}]".format(
                        code, wait, attempt, self.max_retries
                    ),
                    flush=True,
                )
                time.sleep(wait)
                continue
            raise ApiError(err, path)

    # -- publicos -------------------------------------------------------

    def get(self, path: str, **params) -> Any:
        params["access_token"] = self.token
        return self._request("GET", path, params=params)

    def post(self, path: str, **data) -> Any:
        data["access_token"] = self.token
        # Dicts y listas van serializados como JSON, que es lo que espera Meta.
        # Los booleanos tambien: sin esto viajarian como "True"/"False" y Meta
        # solo entiende "true"/"false".
        body = {
            k: (json.dumps(v) if isinstance(v, (dict, list, bool)) else v)
            for k, v in data.items()
            if v is not None
        }
        return self._request("POST", path, data=body)

    def post_files(self, path: str, files: Dict[str, Any], **data) -> Any:
        data["access_token"] = self.token
        return self._request("POST", path, data=data, files=files)

    def get_all(self, path: str, limit: int = 100, **params) -> List[Dict[str, Any]]:
        """Recorre todas las paginas de un edge y devuelve la lista completa.

        Si Meta responde que se le pide demasiado, se reintenta con paginas mas
        pequenas en vez de rendirse. Pasa con campanas de muchos anuncios: cada
        uno arrastra su creative entero, con los textos y videos de sus veinte
        idiomas, y cien de esos no caben en una sola pagina.
        """
        tamanos = [t for t in (limit, 25, 10, 5, 2) if t <= limit] or [limit]
        for i, tam in enumerate(tamanos):
            try:
                return self._recorrer(path, tam, dict(params))
            except ApiError as e:
                if not e.pedir_menos or i == len(tamanos) - 1:
                    raise
                print(
                    "  ! Meta pide menos datos por pagina — reintentando de {} "
                    "en {} ({})".format(tam, tamanos[i + 1], path),
                    flush=True,
                )
        return []

    def _recorrer(self, path: str, limit: int, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        params["limit"] = limit
        out: List[Dict[str, Any]] = []
        page = self.get(path, **params)
        while True:
            out.extend(page.get("data", []))
            nxt = (page.get("paging") or {}).get("next")
            if not nxt:
                return out
            resp = self.session.get(nxt, timeout=120)
            self.calls += 1
            page = resp.json()
            if "error" in page:
                raise ApiError(page["error"], path)


def build_clients(cfg: Dict[str, str]):
    """Devuelve (graph_origen, graph_destino). Comparten token salvo que haya DST_TOKEN."""
    version = cfg.get("GRAPH_VERSION") or "v23.0"
    src = Graph(cfg["FB_TOKEN"], version)
    dst_token = cfg.get("DST_TOKEN")
    dst = Graph(dst_token, version) if dst_token else src
    return src, dst


def norm_account(account_id: str) -> str:
    """Normaliza a formato act_XXXX."""
    account_id = (account_id or "").strip()
    return account_id if account_id.startswith("act_") else "act_{}".format(account_id)


def fmt_money(amount: Optional[str], currency: str = "") -> str:
    """Meta devuelve los importes en centavos como string."""
    if amount in (None, ""):
        return "-"
    try:
        return "{:.2f} {}".format(int(amount) / 100.0, currency).strip()
    except (TypeError, ValueError):
        return str(amount)
