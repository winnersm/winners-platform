"""
Pruebas del filtro de cuentas.

Merecen existir porque un fallo aquí no da error: simplemente pausa campañas
de una cuenta que debía quedar fuera, o deja de limpiar una que sí tocaba.
Se descubriría días después, mirando anuncios.

    python3 -m unittest src.test_tasks -v
"""

import unittest

from .tasks import Task


def task(mode: str, accounts: list[str]) -> Task:
    return Task(
        name="prueba",
        display_name="Prueba",
        cron="0 8 * * *",
        timezone="America/Bogota",
        enabled=True,
        scope_mode=mode,
        scope_accounts=accounts,
    )


CUENTAS = {
    "act_111": "Cuenta A",
    "act_222": "Cuenta B",
    "act_333": "Cuenta C",
}


class TestAlcance(unittest.TestCase):
    def test_todas_no_filtra_nada(self):
        t = task("ALL", [])
        self.assertEqual(t.filter_accounts(CUENTAS), CUENTAS)

    def test_solo_estas_deja_las_elegidas(self):
        t = task("INCLUDE", ["act_111", "act_333"])
        self.assertEqual(set(t.filter_accounts(CUENTAS)), {"act_111", "act_333"})

    def test_todas_menos_excluye_las_elegidas(self):
        t = task("EXCLUDE", ["act_222"])
        self.assertEqual(set(t.filter_accounts(CUENTAS)), {"act_111", "act_333"})

    def test_el_prefijo_act_es_indiferente(self):
        # Meta devuelve los ids unas veces con "act_" y otras sin él; guardar
        # uno y comparar con el otro dejaría el filtro sin efecto.
        self.assertTrue(task("INCLUDE", ["111"]).applies_to("act_111"))
        self.assertTrue(task("INCLUDE", ["act_111"]).applies_to("111"))
        self.assertFalse(task("EXCLUDE", ["111"]).applies_to("act_111"))

    def test_incluir_sin_cuentas_no_deja_ninguna(self):
        # "solo estas" sin ninguna elegida significa ninguna, no todas.
        # Si devolviera todas, vaciar la lista pasaría a tocarlo todo.
        self.assertEqual(task("INCLUDE", []).filter_accounts(CUENTAS), {})

    def test_excluir_sin_cuentas_las_deja_todas(self):
        self.assertEqual(task("EXCLUDE", []).filter_accounts(CUENTAS), CUENTAS)

    def test_una_cuenta_desconocida_en_la_lista_no_estorba(self):
        t = task("INCLUDE", ["act_111", "act_999"])
        self.assertEqual(set(t.filter_accounts(CUENTAS)), {"act_111"})

    def test_excluirlas_todas_no_deja_ninguna(self):
        t = task("EXCLUDE", list(CUENTAS))
        self.assertEqual(t.filter_accounts(CUENTAS), {})


if __name__ == "__main__":
    unittest.main()
