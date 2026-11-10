// Identity tokens for calling Interview IQ's own private Cloud Run services (the code runner, and the model and
// speech services when they scale to zero apart from the app). The metadata server signs them for the app's
// service account; each service only admits that account. Tokens last an hour and are refreshed well before.
const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
const cache = new Map<string, { token: string; until: number }>();
// Concurrent calls to one service share a single token request.
const pending = new Map<string, Promise<string>>();

export class IdentityTokenError extends Error {}

async function fetchToken(audience: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${METADATA}?audience=${encodeURIComponent(audience)}`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
  } catch { throw new IdentityTokenError('Could not reach the metadata server for an identity token.'); }
  if (!response.ok) throw new IdentityTokenError('Could not get an identity token.');
  const token = (await response.text()).trim();
  cache.set(audience, { token, until: Date.now() + 45 * 60_000 });
  return token;
}

export async function identityToken(audience: string): Promise<string> {
  const cached = cache.get(audience);
  if (cached && cached.until > Date.now()) return cached.token;
  let request = pending.get(audience);
  if (!request) {
    request = fetchToken(audience).finally(() => pending.delete(audience));
    pending.set(audience, request);
  }
  return request;
}

// A fetch that signs every request for one service, for SDK clients that accept a custom fetch.
export function signedFetch(audience: string): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${await identityToken(audience)}`);
    return fetch(input, { ...init, headers });
  };
}

export const clearIdentityTokens = () => { cache.clear(); pending.clear(); };
