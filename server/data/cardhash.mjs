// cardhash.mjs — the ONE card cache key, shared by the server, pregenerate and
// the daily pipeline.
//
// The key mixes TEMPLATE_VERSION (parsed from render/theme.py, the renderer's
// single source of truth) into the payload hash. Without it, bumping the card
// design changed nothing on disk: every existing ballot kept its old directory
// hash, pregenerate saw "already present" and skipped, and the server happily
// served the previous design forever. With it, a version bump makes every
// directory hash new — the next daily run regenerates the corpus and the old
// dirs simply stop being referenced.
import crypto from 'node:crypto';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readTemplateVersion() {
  const theme = fssync.readFileSync(path.join(ROOT, 'render', 'theme.py'), 'utf8');
  const m = /^TEMPLATE_VERSION\s*=\s*"([^"]+)"/m.exec(theme);
  if (!m) throw new Error('TEMPLATE_VERSION not found in render/theme.py');
  return m[1];
}

/** Read once at import: the renderer version cannot change under a running process. */
export const TEMPLATE_VERSION = readTemplateVersion();

/** Content-addressed cache key for one ballot's card artifacts. */
export function payloadHash(s) {
  return crypto.createHash('sha256')
    .update(TEMPLATE_VERSION + '|' + JSON.stringify(s))
    .digest('hex').slice(0, 12);
}
