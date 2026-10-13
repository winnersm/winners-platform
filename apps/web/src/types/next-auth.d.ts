import type { DefaultSession } from "next-auth";
import type { Grant, Role } from "@winners/auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
      grants: Grant[];
      operations: string[];
      mustChangePassword: boolean;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: Role;
    grants: Grant[];
    operations: string[];
    mustChangePassword: boolean;
  }
}
