import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  can,
  visibleModules,
  canAccessOperation,
  moduleForPath,
  landingPath,
  canScope,
  scopeForPath,
  MODULES,
  CLONER_API_GET,
  CLONER_API_POST,
  type Level,
  type Principal,
} from "./index.ts";

function principal(over: Partial<Principal> = {}): Principal {
  return {
    id: "u1",
    email: "test@winnersmastermind.com",
    role: "OPERATOR",
    grants: [],
    operations: [],
    ...over,
  };
}

describe("rol OWNER", () => {
  const owner = principal({ role: "OWNER" });

  test("puede todo en todos los módulos aunque no tenga concesiones", () => {
    assert.equal(can(owner, "META", "ADMIN"), true);
    assert.equal(can(owner, "ADMIN", "ADMIN"), true);
    assert.equal(can(owner, "LINKS", "WRITE"), true);
  });

  test("ve todos los módulos en el menú", () => {
    // Contra MODULES y no contra un número: añadir un módulo no debe hacer
    // fallar un test que no tiene nada que ver con él.
    assert.equal(visibleModules(owner).length, MODULES.length);
  });

  test("accede a cualquier operación sin ser miembro", () => {
    assert.equal(canAccessOperation(owner, "op-cualquiera"), true);
  });
});

describe("concesiones por módulo", () => {
  test("sin concesión no hay acceso", () => {
    assert.equal(can(principal(), "META"), false);
  });

  test("READ permite leer pero no escribir", () => {
    const p = principal({ grants: [{ module: "META", level: "READ" }] });
    assert.equal(can(p, "META", "READ"), true);
    assert.equal(can(p, "META", "WRITE"), false);
  });

  test("ADMIN de módulo implica WRITE y READ", () => {
    const p = principal({ grants: [{ module: "LINKS", level: "ADMIN" }] });
    assert.equal(can(p, "LINKS", "READ"), true);
    assert.equal(can(p, "LINKS", "WRITE"), true);
    assert.equal(can(p, "LINKS", "ADMIN"), true);
  });

  test("una concesión no se filtra a otro módulo", () => {
    const p = principal({ grants: [{ module: "META", level: "ADMIN" }] });
    assert.equal(can(p, "LINKS", "READ"), false);
  });

  test("NONE explícito bloquea", () => {
    const p = principal({ grants: [{ module: "META", level: "NONE" }] });
    assert.equal(can(p, "META", "READ"), false);
  });
});

describe("restricciones de rol", () => {
  test("VIEWER nunca escribe, aunque su concesión diga ADMIN", () => {
    const p = principal({ role: "VIEWER", grants: [{ module: "META", level: "ADMIN" }] });
    assert.equal(can(p, "META", "READ"), true);
    assert.equal(can(p, "META", "WRITE"), false);
    assert.equal(can(p, "META", "ADMIN"), false);
  });

  test("SERVICE no navega por ningún módulo", () => {
    const p = principal({ role: "SERVICE", grants: [{ module: "META", level: "ADMIN" }] });
    assert.equal(can(p, "META", "READ"), false);
    assert.deepEqual(visibleModules(p), []);
  });

  test("ADMIN no entra al módulo ADMIN sin ser OWNER", () => {
    const p = principal({ role: "ADMIN", grants: [{ module: "ADMIN", level: "ADMIN" }] });
    assert.equal(can(p, "ADMIN", "READ"), false);
  });
});

describe("operaciones (tenants)", () => {
  test("solo ve las operaciones de las que es miembro", () => {
    const p = principal({ operations: ["op-winners"] });
    assert.equal(canAccessOperation(p, "op-winners"), true);
    assert.equal(canAccessOperation(p, "op-jv"), false);
  });
});

describe("rutas", () => {
  test("asocia cada prefijo con su módulo", () => {
    assert.equal(moduleForPath("/meta"), "META");
    assert.equal(moduleForPath("/meta/campaigns"), "META");
    assert.equal(moduleForPath("/admin/audit"), "ADMIN");
    assert.equal(moduleForPath("/login"), null);
  });

  test("no confunde un prefijo con otra ruta que empiece igual", () => {
    // /metabase no debe resolver a META
    assert.equal(moduleForPath("/metabase"), null);
  });

  test("manda a cada quien a su primer módulo disponible", () => {
    const p = principal({ grants: [{ module: "LINKS", level: "READ" }] });
    assert.equal(landingPath(p), "/links");
  });

  test("sin ningún módulo va a /sin-acceso, no a una página en blanco", () => {
    assert.equal(landingPath(principal()), "/sin-acceso");
  });
});

describe("secciones dentro de un módulo (scopes)", () => {
  test("sin scopes, la concesión cubre todo el módulo", () => {
    const p = principal({ grants: [{ module: "META", level: "WRITE" }] });
    assert.equal(canScope(p, "META", "campaigns"), true);
    assert.equal(canScope(p, "META", "fanpages"), true);
  });

  test("con scopes, solo las secciones listadas", () => {
    // Caso real: dev externo con acceso únicamente a Fanpages
    const p = principal({ grants: [{ module: "META", level: "WRITE", scopes: ["fanpages"] }] });
    assert.equal(canScope(p, "META", "fanpages"), true);
    assert.equal(canScope(p, "META", "campaigns"), false);
    assert.equal(canScope(p, "META", "accounts"), false);
  });

  test("los scopes no eluden el nivel: WRITE no se concede si solo hay READ", () => {
    const p = principal({ grants: [{ module: "META", level: "READ", scopes: ["fanpages"] }] });
    assert.equal(canScope(p, "META", "fanpages", "READ"), true);
    assert.equal(canScope(p, "META", "fanpages", "WRITE"), false);
  });

  test("el dueño no se ve limitado por scopes", () => {
    const p = principal({ role: "OWNER", grants: [{ module: "META", level: "READ", scopes: ["fanpages"] }] });
    assert.equal(canScope(p, "META", "campaigns", "ADMIN"), true);
  });

  test("sin concesión al módulo, ningún scope pasa", () => {
    assert.equal(canScope(principal(), "META", "fanpages"), false);
  });
});

describe("módulo Clonador", () => {
  test("cada ruta del clonador exige su propia sección", () => {
    assert.equal(moduleForPath("/cloner"), "CLONER");
    assert.equal(moduleForPath("/cloner/tokens"), "CLONER");
    assert.equal(scopeForPath("/cloner"), "clonar");
    assert.equal(scopeForPath("/cloner/plantillas"), "plantillas");
    assert.equal(scopeForPath("/cloner/tokens"), "tokens");
    assert.equal(scopeForPath("/cloner/historial"), "historial");
  });

  test("clonar no da acceso a los tokens de Meta", () => {
    // Es la razón de que los tokens sean una sección aparte: se puede dejar que
    // alguien clone campañas sin darle las credenciales con las que se clona.
    const p = principal({
      grants: [{ module: "CLONER", level: "WRITE", scopes: ["clonar", "plantillas"] }],
    });
    assert.equal(canScope(p, "CLONER", "clonar", "WRITE"), true);
    assert.equal(canScope(p, "CLONER", "plantillas", "WRITE"), true);
    assert.equal(canScope(p, "CLONER", "tokens"), false);
    assert.equal(canScope(p, "CLONER", "historial"), false);
  });

  test("tener Meta no da el Clonador: son módulos distintos", () => {
    // Meta duplica dentro de una cuenta; el Clonador mueve entre cuentas y BMs
    // resubiendo cada asset. No es el mismo permiso.
    const p = principal({ grants: [{ module: "META", level: "ADMIN" }] });
    assert.equal(can(p, "CLONER"), false);
  });

  test("solo lectura no puede lanzar una clonación", () => {
    const p = principal({
      role: "VIEWER",
      grants: [{ module: "CLONER", level: "ADMIN" }],
    });
    assert.equal(canScope(p, "CLONER", "clonar", "READ"), true);
    assert.equal(canScope(p, "CLONER", "clonar", "WRITE"), false);
  });

  test("quien solo tiene el clonador aterriza en él", () => {
    const p = principal({ grants: [{ module: "CLONER", level: "WRITE" }] });
    assert.equal(landingPath(p), "/cloner");
  });
});

describe("permisos de la API del clonador", () => {
  // Contra la tabla real que usa la ruta: si alguien añade un endpoint y se
  // olvida de darle permiso, o se lo da de menos, aquí se ve.
  const pasa = (p: Principal, r: { scope: string; level: Level }) =>
    canScope(p, "CLONER", r.scope, r.level);

  test("sin el módulo CLONER no pasa ninguna ruta", () => {
    const p = principal({ grants: [{ module: "META", level: "ADMIN" }] });
    for (const [nombre, r] of Object.entries({ ...CLONER_API_GET, ...CLONER_API_POST })) {
      assert.equal(pasa(p, r), false, `${nombre} no debería pasar`);
    }
  });

  test("dar el clonador sin la sección de tokens no da los tokens", () => {
    const p = principal({
      grants: [{ module: "CLONER", level: "WRITE", scopes: ["clonar", "plantillas"] }],
    });
    assert.equal(pasa(p, CLONER_API_POST["clonar"]), true);
    assert.equal(pasa(p, CLONER_API_POST["video"]), true);
    assert.equal(pasa(p, CLONER_API_POST["plantillas"]), true);
    assert.equal(pasa(p, CLONER_API_POST["tokens"]), false);
    assert.equal(pasa(p, CLONER_API_POST["tokens/borrar"]), false);
    assert.equal(pasa(p, CLONER_API_GET["historial"]), false);
  });

  test("solo lectura pasa lo que lee y nada de lo que escribe", () => {
    // Un VIEWER puede mirarlo todo, incluida la lectura en segundo plano, pero
    // ninguna ruta que toque Meta, por mucho que su concesión diga ADMIN.
    const p = principal({ role: "VIEWER", grants: [{ module: "CLONER", level: "ADMIN" }] });
    const todas = { ...CLONER_API_GET, ...CLONER_API_POST };
    for (const [nombre, r] of Object.entries(todas)) {
      assert.equal(
        pasa(p, r),
        r.level === "READ",
        `${nombre} (${r.level}) no se comporta como debe con solo lectura`,
      );
    }
  });

  test("con READ se miran campañas pero no se clona", () => {
    const p = principal({ grants: [{ module: "CLONER", level: "READ" }] });
    assert.equal(pasa(p, CLONER_API_GET["campanas"]), true);
    assert.equal(pasa(p, CLONER_API_POST["clonar"]), false);
  });

  test("una cuenta de servicio no entra por la web", () => {
    const p = principal({ role: "SERVICE", grants: [{ module: "CLONER", level: "ADMIN" }] });
    assert.equal(pasa(p, CLONER_API_GET["campanas"]), false);
  });

  test("toda ruta que escribe exige WRITE, ninguna se queda en READ", () => {
    // `campana/cargar` va por POST pero solo lee: la campaña se pide en el
    // cuerpo y la lectura tarda más de lo que aguanta Cloudflare, así que se
    // hace en segundo plano. No escribe nada en Meta.
    const soloLeen = new Set(["campana/cargar"]);
    for (const [nombre, r] of Object.entries(CLONER_API_POST)) {
      if (soloLeen.has(nombre)) continue;
      assert.equal(r.level, "WRITE", `${nombre} escribe: no puede pedir solo ${r.level}`);
    }
  });

  test("la lectura en segundo plano no exige más que la lectura directa", () => {
    const p = principal({ grants: [{ module: "CLONER", level: "READ" }] });
    assert.equal(pasa(p, CLONER_API_GET["campana"]), true);
    assert.equal(pasa(p, CLONER_API_POST["campana/cargar"]), true);
  });
});
