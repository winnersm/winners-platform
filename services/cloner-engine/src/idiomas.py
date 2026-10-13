"""Lectura y edicion del contenido por idioma de un creative dinamico.

Un creative multi-idioma de Meta se organiza asi:

  asset_feed_spec.bodies / titles / descriptions / link_urls / videos
      -> listas de assets, cada uno etiquetado con uno o varios `adlabels`
  asset_feed_spec.asset_customization_rules
      -> una regla por idioma; dice que label usar para cada tipo de asset
         y a que `locales` (ids numericos de Meta) aplica

Editar "el texto del aleman" es por tanto: localizar la regla cuyo locale es
aleman, mirar que label usa para bodies, y cambiar el asset con ese label.

Trampa importante: un mismo label puede estar compartido por varias reglas
(en las campanas reales, un video en ingles suele servir a 15 idiomas). Si se
edita sin mas, se cambia el contenido de todos esos idiomas a la vez. Por eso
al editar se DESDOBLA el label: se crea uno nuevo exclusivo para ese idioma.
"""

import copy
from typing import Any, Dict, List, Optional, Tuple

# tipo de asset -> (lista dentro de asset_feed_spec, clave de la regla, campo con el contenido)
TIPOS = {
    "body":        ("bodies",       "body_label",        "text"),
    "title":       ("titles",       "title_label",       "text"),
    "description": ("descriptions", "description_label", "text"),
    "link_url":    ("link_urls",    "link_url_label",    "website_url"),
    "video":       ("videos",       "video_label",       "video_id"),
}


def cargar_locales(graph) -> Dict[int, str]:
    """Mapa {id_locale: nombre legible} segun el catalogo de Meta."""
    try:
        datos = graph.get_all("search", type="adlocale", limit=1000)
        return {int(d["key"]): d["name"] for d in datos if d.get("key") is not None}
    except Exception:
        return {}


def _label_de(regla: Dict[str, Any], clave: str) -> Optional[str]:
    lb = regla.get(clave)
    if isinstance(lb, dict):
        return lb.get("name")
    return None


def _buscar_asset(afs: Dict[str, Any], lista: str, label: Optional[str]) -> Optional[Dict[str, Any]]:
    """Primer asset de `lista` etiquetado con `label`."""
    if not label:
        return None
    for asset in afs.get(lista) or []:
        for lb in asset.get("adlabels") or []:
            if lb.get("name") == label:
                return asset
    return None


def _reglas_que_usan(afs: Dict[str, Any], clave_label: str, label: str) -> int:
    return sum(
        1 for r in afs.get("asset_customization_rules") or []
        if _label_de(r, clave_label) == label
    )


def extraer(afs: Dict[str, Any], nombres_locales: Optional[Dict[int, str]] = None) -> List[Dict[str, Any]]:
    """Devuelve el contenido actual agrupado por regla (= por idioma)."""
    nombres_locales = nombres_locales or {}
    bloques: List[Dict[str, Any]] = []

    for i, regla in enumerate(afs.get("asset_customization_rules") or []):
        spec = regla.get("customization_spec") or {}
        locales = spec.get("locales") or []
        bloque: Dict[str, Any] = {
            "indice": i,
            "locales": locales,
            "idioma": ", ".join(nombres_locales.get(int(l), "locale {}".format(l)) for l in locales)
                      or ("por defecto" if regla.get("is_default") else "sin locale"),
            "is_default": bool(regla.get("is_default")),
            "campos": {},
        }
        for tipo, (lista, clave_label, campo) in TIPOS.items():
            label = _label_de(regla, clave_label)
            asset = _buscar_asset(afs, lista, label)
            bloque["campos"][tipo] = {
                "label": label,
                "valor": (asset or {}).get(campo, ""),
                # Si el label lo usan varias reglas, editarlo afectaria a todas
                # salvo que se desdoble (lo hace `aplicar`).
                "compartido_con": _reglas_que_usan(afs, clave_label, label) - 1 if label else 0,
            }
            if tipo == "video" and asset:
                # Para poder ver de que video se trata sin salir de la app.
                bloque["campos"][tipo]["miniatura"] = asset.get("thumbnail_url") or ""
        bloques.append(bloque)
    return bloques


def _nuevo_nombre_label(afs: Dict[str, Any], base: str) -> str:
    """Nombre de label libre, derivado de `base`."""
    usados = set()
    for lista, _, _ in TIPOS.values():
        for asset in afs.get(lista) or []:
            for lb in asset.get("adlabels") or []:
                if lb.get("name"):
                    usados.add(lb["name"])
    i = 2
    while "{}_v{}".format(base, i) in usados:
        i += 1
    return "{}_v{}".format(base, i)


def aplicar(afs: Dict[str, Any], ediciones: List[Dict[str, Any]]) -> Tuple[Dict[str, Any], List[str]]:
    """Aplica ediciones y devuelve (asset_feed_spec nuevo, notas).

    Cada edicion: {"indice": int, "tipo": "body"|"title"|..., "valor": str}
    """
    nuevo = copy.deepcopy(afs)
    reglas = nuevo.get("asset_customization_rules") or []
    notas: List[str] = []

    for ed in ediciones:
        tipo = ed.get("tipo")
        if tipo not in TIPOS:
            notas.append("tipo desconocido: {}".format(tipo))
            continue
        idx = ed.get("indice")
        if not isinstance(idx, int) or idx < 0 or idx >= len(reglas):
            notas.append("indice de regla fuera de rango: {}".format(idx))
            continue

        lista, clave_label, campo = TIPOS[tipo]
        regla = reglas[idx]
        label = _label_de(regla, clave_label)
        asset = _buscar_asset(nuevo, lista, label)
        if asset is None:
            notas.append("la regla {} no tiene asset de tipo {}".format(idx, tipo))
            continue

        if str(asset.get(campo, "")) == str(ed.get("valor", "")):
            continue  # sin cambios

        compartido = label and _reglas_que_usan(nuevo, clave_label, label) > 1
        if compartido:
            # Desdoblar: copia del asset con label propio, solo para esta regla.
            nombre_nuevo = _nuevo_nombre_label(nuevo, label)
            copia = copy.deepcopy(asset)
            copia["adlabels"] = [{"name": nombre_nuevo}]
            copia[campo] = ed.get("valor", "")
            nuevo.setdefault(lista, []).append(copia)
            regla[clave_label] = {"name": nombre_nuevo}
            notas.append("{} de la regla {}: label '{}' estaba compartido, se creo '{}' "
                         "para no afectar a los demas idiomas".format(tipo, idx, label, nombre_nuevo))
        else:
            asset[campo] = ed.get("valor", "")

    return nuevo, notas


def resumen(afs: Dict[str, Any]) -> Dict[str, int]:
    """Conteo rapido de assets por tipo."""
    return {tipo: len(afs.get(lista) or []) for tipo, (lista, _, _) in TIPOS.items()}
