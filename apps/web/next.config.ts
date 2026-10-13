import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Salida mínima para Docker: solo lo necesario para arrancar.
  output: "standalone",
  // En un monorepo hay que decirle dónde está la raíz, o incluye de más.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),

  // Paquetes que deben ejecutarse en Node y no pasar por el bundler.
  serverExternalPackages: [
    "bcryptjs",
    "bullmq",
    "ioredis",
    "facebook-nodejs-business-sdk",
    "@prisma/client",
    "@prisma/adapter-pg",
    "pg",
  ],
};

export default nextConfig;
