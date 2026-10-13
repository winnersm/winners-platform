import { createDecipheriv } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

function decrypt(b64, hexKey) {
  const data = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), data.subarray(0, 16));
  d.setAuthTag(data.subarray(16, 32));
  return Buffer.concat([d.update(data.subarray(32)), d.final()]).toString("utf8");
}

const conns = await prisma.$queryRaw`
  SELECT name, "encryptedToken", "tokenLast4", "createdAt"
  FROM legacy_links."MetaConnection" ORDER BY "createdAt" DESC`;

for (const c of conns) {
  const token = decrypt(c.encryptedToken, process.env.OLD_KEY);
  const r = await fetch(
    `https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name&limit=3&access_token=${token}`,
  ).then((x) => x.json());
  const estado = r.error ? `BLOQUEADO — ${r.error.message}` : `OK (${(r.data ?? []).length} cuentas)`;
  console.log(`  ${c.name.padEnd(22)} ····${c.tokenLast4}  ${estado}`);
}
await prisma.$disconnect();
