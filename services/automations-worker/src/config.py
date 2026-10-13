"""
Configuración del worker: secretos cifrados y ajustes.

Antes esto era `SELECT key, value FROM config`, con los tokens de Meta y las
API keys de afiliados guardados en TEXTO PLANO. Ahora los secretos viven
cifrados en core.Secret y se descifran aquí, en memoria, solo cuando se usan.

El formato del cifrado es el mismo que usa la app (AES-256-GCM, con
iv + authTag + ciphertext en base64), para que ambas partes lean lo mismo.
"""

from __future__ import annotations

import base64
import logging
import os

import psycopg2
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

log = logging.getLogger(__name__)

IV_LEN = 16
TAG_LEN = 16


def _key() -> bytes:
    hex_key = os.environ.get("ENCRYPTION_KEY", "")
    if len(hex_key) != 64:
        raise RuntimeError("ENCRYPTION_KEY debe ser un hex de 64 caracteres")
    return bytes.fromhex(hex_key)


def _decrypt(ciphertext_b64: str) -> str:
    """Descifra un valor guardado por la app."""
    data = base64.b64decode(ciphertext_b64)
    iv = data[:IV_LEN]
    tag = data[IV_LEN : IV_LEN + TAG_LEN]
    encrypted = data[IV_LEN + TAG_LEN :]
    # AESGCM espera el tag al final del texto cifrado; la app lo guarda aparte.
    return AESGCM(_key()).decrypt(iv, encrypted + tag, None).decode("utf-8")


def load_config() -> dict:
    """
    Todos los valores que necesita el worker, con la misma forma que antes:
    un diccionario plano de clave → valor. Los secretos llegan descifrados.

    Se mantiene la firma para no tocar los cuatro jobs, que ya funcionan.
    """
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT key, value FROM core."Setting" WHERE value <> \'\'')
            valores = {k: v for k, v in cur.fetchall()}

            cur.execute('SELECT key, ciphertext FROM core."Secret"')
            secretos = cur.fetchall()
    finally:
        conn.close()

    fallidos = []
    for clave, cifrado in secretos:
        try:
            valores[clave] = _decrypt(cifrado)
        except Exception as e:
            # Un secreto ilegible no debe tumbar todo el ciclo: los jobs que no
            # dependan de él pueden seguir. Se registra sin exponer el valor.
            fallidos.append(clave)
            log.error("No se pudo descifrar el secreto %s: %s", clave, type(e).__name__)

    if fallidos:
        log.error("Secretos ilegibles: %s", ", ".join(fallidos))

    return valores


def set_setting(key: str, value: str) -> None:
    """Guarda un ajuste no secreto (p. ej. el cursor de JVZoo)."""
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO core."Setting" (key, value, section, "updatedAt")
                VALUES (%s, %s, 'internal', now())
                ON CONFLICT (key) DO UPDATE
                  SET value = EXCLUDED.value, "updatedAt" = now()
                """,
                (key, value),
            )
        conn.commit()
    finally:
        conn.close()
