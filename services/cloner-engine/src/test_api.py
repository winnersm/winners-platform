"""Pruebas de lo que el motor añade por encima de opwinners.

El motor de clonado en sí (`clonado.py`) viene probado contra gasto real desde
antes y no se ha tocado. Lo que sí es nuevo es cómo se reparten los vídeos
subidos a mano entre varias cuentas destino, y ahí un fallo es caro: un anuncio
que apunta al vídeo de otra cuenta se crea igual, parece correcto y queda
colgando de un asset ajeno.

  python3 -m unittest src.test_api
"""

from __future__ import annotations

import os
import unittest

os.environ.setdefault("CLONER_ENGINE_TOKEN", "test")
os.environ.setdefault("DATABASE_URL", "postgresql://test/test")
os.environ.setdefault("ENCRYPTION_KEY", "a" * 64)

from .api import _extra_de  # noqa: E402


class VideosDeAdsetsAnadidos(unittest.TestCase):
    """`adsets_extra[].videos` llega anidado por cuenta y hay que aplanarlo."""

    def setUp(self):
        self.extra = [
            {
                "base": "a1",
                "nombre": "nuevo",
                "presupuesto": "",
                "videos": {
                    "act_1": {"v_viejo": "v_en_1"},
                    "act_2": {"v_viejo": "v_en_2"},
                },
            }
        ]

    def test_cada_cuenta_recibe_su_propio_video(self):
        uno = _extra_de(self.extra, "act_1")
        dos = _extra_de(self.extra, "act_2")
        self.assertEqual(uno[0]["videos"], {"v_viejo": "v_en_1"})
        self.assertEqual(dos[0]["videos"], {"v_viejo": "v_en_2"})

    def test_nunca_se_cuela_el_video_de_otra_cuenta(self):
        uno = _extra_de(self.extra, "act_1")
        self.assertNotIn("v_en_2", uno[0]["videos"].values())

    def test_una_cuenta_sin_subida_se_queda_sin_videos(self):
        # Mejor sin vídeo (el motor lo resube del origen) que con el de otra.
        r = _extra_de(self.extra, "act_jamas_vista")
        self.assertEqual(r[0]["videos"], {})

    def test_el_resto_del_adset_viaja_intacto(self):
        r = _extra_de(self.extra, "act_1")
        self.assertEqual(r[0]["base"], "a1")
        self.assertEqual(r[0]["nombre"], "nuevo")

    def test_no_muta_lo_que_recibe(self):
        # El mismo body se reutiliza para cada cuenta destino de la corrida.
        _extra_de(self.extra, "act_1")
        self.assertEqual(
            self.extra[0]["videos"],
            {"act_1": {"v_viejo": "v_en_1"}, "act_2": {"v_viejo": "v_en_2"}},
        )

    def test_acepta_el_formato_plano_anterior(self):
        plano = [{"base": "a1", "videos": {"v_viejo": "v_nuevo"}}]
        self.assertEqual(_extra_de(plano, "act_1")[0]["videos"], {"v_viejo": "v_nuevo"})

    def test_sin_videos_y_sin_adsets(self):
        self.assertEqual(_extra_de([{"base": "a1"}], "act_1")[0]["videos"], {})
        self.assertEqual(_extra_de([], "act_1"), [])



class PaginacionCuandoMetaPideMenos(unittest.TestCase):
    """El código 1 de Meta significa dos cosas y solo una se arregla esperando."""

    def test_distingue_pedir_de_mas_de_estar_saturado(self):
        from .fbapi import ApiError

        grande = ApiError(
            {"code": 1, "message": "Please reduce the amount of data you're asking for, "
                                   "then retry your request"}, "x")
        saturado = ApiError(
            {"code": 1, "message": "An unexpected error has occurred. "
                                   "Please retry your request later"}, "x")
        self.assertTrue(grande.pedir_menos)
        self.assertFalse(saturado.pedir_menos)

    def test_baja_el_tamano_de_pagina_hasta_que_entra(self):
        from .fbapi import ApiError, Graph

        g = Graph("token-falso")
        intentos = []

        def recorrer(path, limit, params):
            intentos.append(limit)
            # Meta solo acepta páginas de 10 o menos para esta campaña.
            if limit > 10:
                raise ApiError(
                    {"code": 1, "message": "Please reduce the amount of data you're "
                                           "asking for, then retry your request"}, path)
            return [{"id": "ad_1"}, {"id": "ad_2"}]

        g._recorrer = recorrer
        datos = g.get_all("campana/ads", limit=100)

        self.assertEqual(intentos, [100, 25, 10])
        self.assertEqual(len(datos), 2)

    def test_un_error_que_no_es_de_tamano_no_se_reintenta(self):
        from .fbapi import ApiError, Graph

        g = Graph("token-falso")
        intentos = []

        def recorrer(path, limit, params):
            intentos.append(limit)
            raise ApiError({"code": 190, "message": "Invalid OAuth access token"}, path)

        g._recorrer = recorrer
        with self.assertRaises(ApiError):
            g.get_all("campana/ads", limit=100)
        self.assertEqual(intentos, [100], "un token inválido no mejora con páginas pequeñas")

    def test_si_ni_la_pagina_mas_pequena_entra_se_rinde_con_el_error_de_meta(self):
        from .fbapi import ApiError, Graph

        g = Graph("token-falso")
        intentos = []

        def recorrer(path, limit, params):
            intentos.append(limit)
            raise ApiError(
                {"code": 1, "message": "Please reduce the amount of data you're asking for"},
                path)

        g._recorrer = recorrer
        with self.assertRaises(ApiError):
            g.get_all("campana/ads", limit=100)
        self.assertEqual(intentos, [100, 25, 10, 5, 2])

if __name__ == "__main__":
    unittest.main()


class ColaDeClonaciones(unittest.TestCase):
    """La cola es lo que impide que dos clonaciones se pisen.

    Dos a la vez comparten el directorio temporal donde el motor descarga los
    vídeos (`_DIR_TEMP` es global del módulo) y la que termina primero se lo
    borra a la otra. Por eso van de una en una.
    """

    def test_el_motor_de_clonado_sigue_compartiendo_estado_global(self):
        # Si algún día deja de ser global, la cola puede dejar de ser necesaria
        # y este test avisará de que se puede revisar la decisión.
        from . import clonado

        self.assertTrue(hasattr(clonado, "_DIR_TEMP"))
        self.assertTrue(hasattr(clonado, "_ARCHIVOS_LIMPIOS"))

    def test_los_estados_se_traducen_para_el_usuario(self):
        from .store import ESTADOS

        self.assertEqual(ESTADOS["queued"], "en cola")
        self.assertEqual(ESTADOS["running"], "en curso")
        self.assertEqual(ESTADOS["done"], "terminado")
        self.assertEqual(ESTADOS["cancelled"], "cancelado")

    def test_una_clonacion_se_guarda_entera_y_una_lectura_no(self):
        # La clonación espera en cola y luego hay que ejecutarla tal cual, así
        # que sus ediciones de idioma tienen que sobrevivir a la espera.
        from .store import _sin_secretos

        entrada = {"campana": "c1", "ediciones": {"ad1": [{"tipo": "body", "valor": "x"}]}}
        self.assertNotIn("ediciones", _sin_secretos(entrada))
        self.assertIn("ediciones", entrada, "no debe mutar lo que recibe")
