import https from 'https';
import { PassThrough } from 'stream';
import { URL } from 'url';
import { gunzipSync } from 'zlib';

/**
 * Native HTTPS transport for jsforce v3, ported from the Emergence webapp's
 * proven integration (salesforce-https-transport.ts).
 *
 * jsforce's bundled node-fetch + StreamPromise hangs on some Node builds (the
 * response pipe never emits `finish`), so `_transport` is replaced with Node
 * `https.request`. The stream MUST carry the response body: jsforce's HttpApi
 * reads both the promise result and the stream.
 */

export interface SfHttpRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface SfHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type SfTransportPromise = Promise<SfHttpResponse> & {
  stream: () => PassThrough;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

function lowerHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
  }
  return out;
}

function decodeBody(headers: Record<string, string>, raw: Buffer): string {
  const encoding = headers['content-encoding'] ?? '';
  const buf = encoding.toLowerCase().includes('gzip') ? gunzipSync(raw) : raw;
  return buf.toString('utf8');
}

function redirectRequest(req: SfHttpRequest, statusCode: number, location: string): SfHttpRequest {
  const nextUrl = new URL(location, req.url).toString();
  const method = statusCode === 303 || statusCode === 302 ? 'GET' : (req.method ?? 'GET');
  const headers = { ...(req.headers ?? {}) };
  if (method === 'GET') {
    delete headers['content-length'];
    delete headers['Content-Length'];
  }
  const next: SfHttpRequest = { method, url: nextUrl, headers };
  if (method !== 'GET' && req.body !== undefined) {
    next.body = req.body;
  }
  return next;
}

function performHttpsRequest(req: SfHttpRequest): Promise<SfHttpResponse> {
  const { method = 'GET', url, headers = {}, body: reqBody } = req;
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    const nodeReq = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        path: parsed.pathname + parsed.search,
        method,
        headers,
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const resHeaders = lowerHeaders(res.headers);
            const body = decodeBody(resHeaders, Buffer.concat(chunks));
            resolve({
              statusCode: res.statusCode ?? 500,
              headers: resHeaders,
              body,
            });
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      },
    );

    nodeReq.on('error', reject);
    nodeReq.on('timeout', () => {
      nodeReq.destroy();
      reject(new Error(`Salesforce request timed out (30 s): ${method} ${url}`));
    });

    if (reqBody) nodeReq.write(reqBody);
    nodeReq.end();
  });
}

async function requestFollowingRedirects(
  req: SfHttpRequest,
  redirectsLeft = MAX_REDIRECTS,
): Promise<SfHttpResponse> {
  const response = await performHttpsRequest(req);
  const location = response.headers.location;
  if (REDIRECT_STATUSES.has(response.statusCode) && location && redirectsLeft > 0) {
    return requestFollowingRedirects(
      redirectRequest(req, response.statusCode, location),
      redirectsLeft - 1,
    );
  }
  return response;
}

export const nativeSalesforceTransport = {
  httpRequest(req: SfHttpRequest, _options: Record<string, unknown> = {}): SfTransportPromise {
    const stream = new PassThrough();

    const promise = requestFollowingRedirects(req).then(
      (response) => {
        if (!stream.destroyed) {
          stream.end(response.body);
        }
        return response;
      },
      (err: Error) => {
        if (!stream.destroyed) {
          stream.destroy(err);
        }
        throw err;
      },
    ) as SfTransportPromise;

    promise.stream = () => stream;
    return promise;
  },
};
