import { parse } from 'cookie';
import type { Request } from 'express';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  return parse(header)[name];
}
