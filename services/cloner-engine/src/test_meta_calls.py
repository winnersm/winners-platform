"""Pruebas del registro de llamadas a Meta en el Clonador.

Un fallo aquí no se ve hasta que alguien mira el reporte y le faltan llamadas, o
hasta que el token acaba en Redis.

  python3 -m unittest src.test_meta_calls
"""

from __future__ import annotations

import queue
import unittest
from unittest import mock

import requests

from . import fbapi, meta_calls
from .fbapi import ApiError, Graph
from .meta_calls import SEP, describir_llamada, resultado_de

BASE = "https://graph.facebook.com/v23.0"


class Respuesta:
    def __init__(self, cuerpo, ok=True):
        self.cuerpo, self.ok = cuerpo, ok

    def json(self):
        if isinstance(self.cuerpo, Exception):
            raise self.cuerpo
        return self.cuerpo


class Formato(unittest.TestCase):
    """Debe clasificar igual que describeMetaCall y outcomeOf de meta-calls.ts."""

    def test_tipo_de_llamada_y_cuenta(self):
        casos = [
            ("{}/act_123/ads?access_token=x", "GET", "GET ads", "123"),
            ("{}/act_123", "GET", "GET cuenta", "123"),
            ("{}/456/ads", "GET", "GET ads", ""),
            ("{}/456", "POST", "POST objeto", ""),
            ("{}/", "POST", "POST batch", ""),
            ("{}/me/adaccounts", "GET", "GET me/adaccounts", ""),
            ("{}/act_1/insights?level=ad&date_preset=today", "GET", "GET insights ad today", "1"),
            ("{}/act_1/insights?time_range=x", "GET", "GET insights rango", "1"),
        ]
        for url, metodo, endpoint, cuenta in casos:
            self.assertEqual(describir_llamada(url.format(BASE), metodo), (endpoint, cuenta))

    def test_los_parametros_aparte_cuentan_igual_que_en_la_url(self):
        endpoint, _ = describir_llamada(BASE + "/act_1/insights", "GET", {"level": "ad", "date_preset": "today"})
        self.assertEqual(endpoint, "GET insights ad today")

    def test_resultado(self):
        self.assertEqual(resultado_de(True, {"data": []}), "ok")
        self.assertEqual(resultado_de(False, {"error": {"code": 17}}), "limit")
        self.assertEqual(resultado_de(False, {"error": {"code": 80004}}), "limit")
        self.assertEqual(resultado_de(False, {"error": {"code": 100}}), "error")
        self.assertEqual(resultado_de(True, {"error": {"code": 190}}), "error")
        self.assertEqual(resultado_de(False, None), "error")
        self.assertEqual(resultado_de(False, {"error": "raro"}), "error")

    def test_mismas_claves_y_retencion_que_la_web(self):
        pipe = mock.Mock()
        cliente = mock.Mock()
        cliente.pipeline.return_value = pipe
        campo = SEP.join(("CLONER", "GET ads", "1", "ok"))

        meta_calls._escribir(cliente, [("2026-11-06", "9", campo)] * 2)

        self.assertEqual(pipe.hincrby.call_args_list, [
            mock.call("meta:calls:2026-11-06", campo, 1),
            mock.call("meta:calls:2026-11-06:hours", "9", 1),
            mock.call("meta:calls:2026-11-06:hours", "total", 1),
        ] * 2)
        pipe.expire.assert_has_calls([
            mock.call("meta:calls:2026-11-06", 90 * 86400),
            mock.call("meta:calls:2026-11-06:hours", 90 * 86400),
        ])
        pipe.execute.assert_called_once()


class RegistroDelGraph(unittest.TestCase):
    def setUp(self):
        self.g = Graph("token-secreto")
        self.g.session = mock.Mock()
        self.cola = queue.Queue()
        for nombre, valor in (("_cola", self.cola), ("_arrancar_hilo", mock.Mock())):
            parche = mock.patch.object(meta_calls, nombre, valor)
            parche.start()
            self.addCleanup(parche.stop)

    def campos(self):
        return [c.split(SEP) for _, _, c in list(self.cola.queue)]

    def test_cuenta_cada_pagina_y_nunca_guarda_el_token(self):
        self.g.session.request.return_value = Respuesta({
            "data": [1], "paging": {"next": BASE + "/act_9/ads?access_token=token-secreto&after=x"}})
        self.g.session.get.return_value = Respuesta({"data": [2]})

        self.assertEqual(self.g.get_all("act_9/ads"), [1, 2])

        self.assertEqual(self.campos(), [["CLONER", "GET ads", "9", "ok"]] * 2)
        self.assertNotIn("token-secreto", repr(list(self.cola.queue)))

    def test_cada_reintento_es_otra_llamada(self):
        self.g.session.request.side_effect = [
            Respuesta({"error": {"code": 17}}, ok=False),
            Respuesta({"id": "1"}),
        ]
        with mock.patch.object(fbapi.time, "sleep"):
            self.g.get("act_9")

        self.assertEqual(self.campos(), [
            ["CLONER", "GET cuenta", "9", "limit"],
            ["CLONER", "GET cuenta", "9", "ok"],
        ])

    def test_el_error_de_meta_se_registra_y_sigue_su_curso(self):
        self.g.session.request.return_value = Respuesta({"error": {"code": 100}}, ok=False)
        with self.assertRaises(ApiError):
            self.g.post("act_9/ads", name="x")
        self.assertEqual(self.campos(), [["CLONER", "POST ads", "9", "error"]])

    def test_un_fallo_de_red_se_registra_y_se_propaga(self):
        self.g.session.request.side_effect = requests.ConnectionError()
        with self.assertRaises(requests.ConnectionError):
            self.g.get("act_9")
        self.assertEqual(self.campos(), [["CLONER", "GET cuenta", "9", "error"]])

    def test_una_pagina_que_no_es_json_se_registra_y_se_propaga(self):
        self.g.session.request.return_value = Respuesta({"data": [], "paging": {"next": BASE + "/act_9/ads"}})
        self.g.session.get.return_value = Respuesta(ValueError("no es json"))
        with self.assertRaises(ValueError):
            self.g.get_all("act_9/ads")
        self.assertEqual(self.campos()[-1], ["CLONER", "GET ads", "9", "error"])


class NuncaRompeLaLlamada(unittest.TestCase):
    def test_cola_llena(self):
        llena = queue.Queue(maxsize=1)
        llena.put_nowait("x")
        with mock.patch.object(meta_calls, "_cola", llena):
            meta_calls.registrar_llamada("CLONER", "GET", BASE + "/act_1", "ok")

    def test_url_rara(self):
        with mock.patch.object(meta_calls, "describir_llamada", side_effect=ValueError):
            meta_calls.registrar_llamada("CLONER", "GET", "http://[", "ok")


if __name__ == "__main__":
    unittest.main()
