import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  // Sin cabecera que revele la tecnología: este servicio está expuesto a
  // internet y no necesita anunciarse.
  poweredByHeader: false,
};

export default nextConfig;
