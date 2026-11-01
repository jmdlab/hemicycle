/**
 * Download a whole file even when the server drops the connection mid-transfer.
 *
 * The AN open-data host (data.assemblee-nationale.fr) has been cutting large downloads at a random point
 * (0.4–5 MB of 29 MB, Nov 2026), so a single fetch fails every time. It supports byte ranges: keep what
 * arrived, ask for the rest with `Range`, and tie each resume to the same file version with `If-Range`
 * (a changed file answers 200 and the download restarts from zero). The result is checked against the
 * announced length before it is returned.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string | ((attempt: number) => string)} url  a function gets a fresh URL per request (cache-busting)
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.attempts]  request budget, first request included
 * @param {number} [opts.backoffMs] base pause between attempts (doubles, capped at 8×)
 * @param {(res: Response) => boolean} [opts.accept] called on every full (200) response; false = stop (body cancelled)
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ buf: Buffer|null, etag: string|null, lastModified: string|null, attempts: number }>}
 *   buf is null when `accept` declined the response.
 */
export async function downloadResumable(url, opts = {}) {
  const {
    headers = {},
    attempts = 40,
    backoffMs = 500,
    accept,
    fetchImpl = fetch,
    log = () => {},
  } = opts;

  const urlFor = typeof url === 'function' ? url : () => url;
  const chunks = [];
  let have = 0;
  let total = null; // full size, once known
  let validator = null; // etag (strong) or last-modified, for If-Range
  let etag = null;
  let lastModified = null;
  let lastErr = null;

  for (let n = 1; n <= attempts; n++) {
    const h = { ...headers };
    if (have > 0 && validator) {
      h.Range = `bytes=${have}-`;
      h['If-Range'] = validator;
    }
    let res;
    try {
      res = await fetchImpl(urlFor(n), { headers: h });
    } catch (err) {
      lastErr = err;
      log(`tentative ${n} : connexion en échec (${err.cause?.code || err.message})`);
      await sleep(Math.min(backoffMs * 2 ** (n - 1), backoffMs * 8));
      continue;
    }

    if (res.status === 200) {
      // Fresh full body: first request, no validator to resume with, or the file changed (If-Range miss).
      if (have > 0) log(`tentative ${n} : le serveur renvoie le fichier entier, reprise à zéro`);
      chunks.length = 0;
      have = 0;
      etag = res.headers.get('etag');
      lastModified = res.headers.get('last-modified');
      // A weak ETag can't be used with If-Range; Last-Modified can.
      validator = etag && !etag.startsWith('W/') ? etag : lastModified;
      const len = Number(res.headers.get('content-length'));
      total = Number.isFinite(len) && len > 0 ? len : null;
      if (accept && !accept(res)) {
        await res.body?.cancel();
        return { buf: null, etag, lastModified, attempts: n };
      }
    } else if (res.status === 206 && have > 0) {
      const range = res.headers.get('content-range') || '';
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range);
      if (!m || Number(m[1]) !== have) {
        // Not the part we asked for: drop it and start over cleanly.
        await res.body?.cancel();
        log(`tentative ${n} : plage inattendue « ${range} », reprise à zéro`);
        chunks.length = 0;
        have = 0;
        validator = null;
        continue;
      }
      if (m[3] !== '*') total = Number(m[3]);
    } else if (res.status === 416 && total !== null && have === total) {
      break; // already complete
    } else {
      await res.body?.cancel();
      throw new Error(`${urlFor(n)} -> HTTP ${res.status}`);
    }

    try {
      for await (const chunk of res.body) {
        chunks.push(Buffer.from(chunk));
        have += chunk.length;
      }
    } catch (err) {
      lastErr = err;
      log(`tentative ${n} : coupé à ${(have / 1048576).toFixed(1)} Mo${total ? ` / ${(total / 1048576).toFixed(1)}` : ''} (${err.cause?.code || err.message})`);
      if (!validator) {
        // Nothing to tie a resume to: the next request starts from zero.
        chunks.length = 0;
        have = 0;
      }
      await sleep(Math.min(backoffMs * 2 ** (n - 1), backoffMs * 8));
      continue;
    }

    if (total === null || have === total) {
      return { buf: Buffer.concat(chunks, have), etag, lastModified, attempts: n };
    }
    if (have > total) {
      chunks.length = 0;
      have = 0;
      validator = null;
      log(`tentative ${n} : plus d’octets que prévu, reprise à zéro`);
      continue;
    }
    // Body ended cleanly but short: resume.
    log(`tentative ${n} : fin prématurée à ${have} / ${total} octets`);
  }

  if (total !== null && have === total) {
    return { buf: Buffer.concat(chunks, have), etag, lastModified, attempts };
  }
  const why = lastErr ? ` (${lastErr.cause?.code || lastErr.message})` : '';
  throw new Error(`téléchargement incomplet après ${attempts} tentatives : ${have}${total ? ` / ${total}` : ''} octets${why}`);
}
