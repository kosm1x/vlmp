import { SignJWT, jwtVerify } from "jose";
import type { Config } from "../config.js";

export interface TokenPayload {
  sub: string;
  username: string;
  role: string;
}

const secretCache = new WeakMap<Config, Uint8Array>();

function getSecret(config: Config): Uint8Array {
  let secret = secretCache.get(config);
  if (!secret) {
    secret = new TextEncoder().encode(config.jwtSecret);
    secretCache.set(config, secret);
  }
  return secret;
}

export async function issueToken(
  payload: TokenPayload,
  config: Config,
): Promise<string> {
  return new SignJWT({ username: payload.username, role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(config.jwtExpiresIn)
    .sign(getSecret(config));
}

export async function verifyToken(
  token: string,
  config: Config,
): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, getSecret(config));
  return {
    sub: payload.sub as string,
    username: payload.username as string,
    role: payload.role as string,
  };
}
