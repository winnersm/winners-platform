"""Pruebas del registro de llamadas a Meta en las automatizaciones.

    python3 -m unittest src.test_meta_calls -v
"""

import io
import json
import queue
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

from . import meta_calls
from .meta_calls import SEP, meta_urlopen

URL = "https://graph.facebook.com/v21.0/act_9/ads?access_token=token-secreto"


def http_error(cuerpo: bytes, codigo: int = 400) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(URL, codigo, "x", {}, io.BytesIO(cuerpo))


class MetaUrlopen(unittest.TestCase):
    def setUp(self):
        self.cola = queue.Queue()
        for nombre, valor in (("_cola", self.cola), ("_arrancar_hilo", mock.Mock())):
            parche = mock.patch.object(meta_calls, nombre, valor)
            parche.start()
            self.addCleanup(parche.stop)

    def campos(self):
        return [c.split(SEP)[:4] for _, _, c, _ in list(self.cola.queue)]

    def detalles(self):
        return [json.loads(d) for _, _, _, d in list(self.cola.queue)]

    def test_llamada_correcta(self):
        resp = object()
        with mock.patch("urllib.request.urlopen", return_value=resp) as abrir:
            req = urllib.request.Request(URL)
            self.assertIs(meta_urlopen(req, "META_CLEANUP", timeout=30), resp)
        abrir.assert_called_once_with(req, timeout=30)
        self.assertEqual(self.campos(), [["META_CLEANUP", "GET ads", "9", "ok"]])
        self.assertNotIn("token-secreto", repr(list(self.cola.queue)))

    def test_el_limite_de_meta_se_distingue_y_el_error_sigue_su_curso(self):
        error = http_error(json.dumps({"error": {"code": 17}}).encode())
        with mock.patch("urllib.request.urlopen", side_effect=error):
            with self.assertRaises(urllib.error.HTTPError):
                meta_urlopen(urllib.request.Request(URL), "BILLING_CHECK", timeout=30)
        self.assertEqual(self.campos(), [["BILLING_CHECK", "GET ads", "9", "limit"]])

    def test_un_cuerpo_ilegible_es_un_error_normal(self):
        with mock.patch("urllib.request.urlopen", side_effect=http_error(b"<html>")):
            with self.assertRaises(urllib.error.HTTPError):
                meta_urlopen(urllib.request.Request(URL), "UPDATE_SHEET", timeout=30)
        self.assertEqual(self.campos()[0][3], "error")

    def test_un_fallo_de_red_se_registra_y_se_propaga(self):
        with mock.patch("urllib.request.urlopen", side_effect=TimeoutError()):
            with self.assertRaises(TimeoutError):
                meta_urlopen(urllib.request.Request(URL), "META_AUTOPAUSE", timeout=30)
        self.assertEqual(self.campos()[0][3], "error")

    def test_el_batch_dice_que_lleva_y_nunca_el_token_de_sus_urls(self):
        lote = [{"method": "GET", "relative_url": "act_1/insights?level=ad&access_token=token-pagina"}] * 7
        cuerpo = urllib.parse.urlencode({"access_token": "token-secreto", "batch": json.dumps(lote)}).encode()
        with mock.patch("urllib.request.urlopen"):
            meta_urlopen(
                urllib.request.Request("https://graph.facebook.com/v21.0/", data=cuerpo, method="POST"),
                "UPDATE_SHEET", timeout=30,
            )
        d = self.detalles()[0]
        self.assertEqual(d["batch"]["n"], 7)
        self.assertEqual(d["batch"]["items"], ["GET act_1/insights"] * 5)
        self.assertTrue(d["route"].startswith("automations-worker"))
        crudo = repr(list(self.cola.queue))
        self.assertNotIn("token-secreto", crudo)
        self.assertNotIn("token-pagina", crudo)

    def test_batch_y_delete(self):
        with mock.patch("urllib.request.urlopen"):
            base = "https://graph.facebook.com/v21.0/"
            meta_urlopen(urllib.request.Request(base, data=b"x", method="POST"), "UPDATE_SHEET", timeout=30)
            meta_urlopen(urllib.request.Request(base + "123", data=b"x", method="DELETE"), "META_CLEANUP", timeout=30)
        self.assertEqual(self.campos(), [
            ["UPDATE_SHEET", "POST batch", "", "ok"],
            ["META_CLEANUP", "DELETE objeto", "", "ok"],
        ])


class TodaLlamadaPasaPorElRegistro(unittest.TestCase):
    def test_ningun_job_abre_graph_sin_registrar(self):
        carpeta = Path(__file__).parent
        for nombre in ("billing_check", "meta_autopause", "meta_cleanup", "update_sheet"):
            lineas = (carpeta / f"{nombre}.py").read_text(encoding="utf-8").splitlines()
            for i, linea in enumerate(lineas):
                if "urllib.request.Request" in linea and "graph.facebook.com" in linea:
                    self.assertIn("meta_urlopen", lineas[i + 1], f"{nombre}.py:{i + 1}")
            if nombre == "update_sheet":
                continue  # sus urlopen restantes son Slack y plataformas de afiliados
            sin_registro = [l for l in lineas if "urllib.request.urlopen(req" in l and "timeout=10" not in l]
            self.assertEqual(sin_registro, [], nombre)  # timeout=10 es Slack


if __name__ == "__main__":
    unittest.main()
