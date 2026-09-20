'use strict';

// Screenshot runner (T4).
//
// Loops over the cities in the T2 registry (`GET /locations`), applies
// per-city quiet hours, and for each due city:
//   1. renders + screenshots via screenshot.js (UNCHANGED, not touched here)
//   2. converts to 1-bit (default) or 2-bit (opt-in) PNG with ImageMagick
//   3. validates geometry (800x480) and bit depth with `identify`
//   4. uploads to Netlify Blobs at the live `{slug}` key
//   5. reads /img/{slug} back and asserts the bytes are byte-identical
//      (Content-Length is a warning: Netlify always responds chunked)
//
// Per-city failures are caught and logged; they do not stop other cities.
// The process exits non-zero if any (non-skipped) city failed.
//
// See docs/tickets/T4-runner-rewrite.md (wetterstation repo) for the spec.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const schedule = require('./lib/schedule.js');

const REPO_ROOT = __dirname;
const SLUG_RE = /^[a-z0-9-]+$/;

function envOrDefault(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

// ---- Deliverable 1: read the registry from /locations (T2 shape) ----

async function loadRegistry() {
  const fixturePath = process.env.LOCATIONS_FIXTURE;
  let raw;
  let source;

  if (fixturePath) {
    source = `fixture:${fixturePath}`;
    raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  } else {
    const base = envOrDefault('BASE_URL', 'https://wetterdirect.netlify.app');
    const url = `${base}/locations`;
    source = url;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`GET ${url} -> HTTP ${res.status}`);
    }
    raw = await res.json();
  }

  if (Array.isArray(raw) || Array.isArray(raw && raw.locations)) {
    throw new Error(
      `${source} returned the OLD /locations shape (a bare array). ` +
      `This runner requires the T2 registry shape ({ default, locations: { <slug>: {...} } }). ` +
      `T2 has not shipped yet on the live endpoint -- use LOCATIONS_FIXTURE to point at a local ` +
      `fixture matching the new shape (see fixtures/locations.sample.json) until it has.`
    );
  }
  if (!raw || typeof raw.locations !== 'object' || raw.locations === null) {
    throw new Error(`${source} did not return a { locations: {...} } registry object.`);
  }

  return raw;
}

// ---- city selection ----

function selectCities(registry, onlySlug) {
  const entries = Object.entries(registry.locations)
    .filter(([, cfg]) => cfg && cfg.trmnl === true);

  if (!onlySlug) return entries;

  const match = entries.find(([slug]) => slug === onlySlug);
  if (match) return [match];

  if (Object.prototype.hasOwnProperty.call(registry.locations, onlySlug)) {
    throw new Error(`"${onlySlug}" exists in the registry but has trmnl:false -- it has no TRMNL dashboard to screenshot.`);
  }
  throw new Error(`"${onlySlug}" is not a known location in the registry.`);
}

// ---- Deliverable 2: depth resolution (default MUST stay 1) ----

function resolveDepth(cityConfig, override) {
  let depth = 1;
  if (cityConfig && cityConfig.depth !== undefined) {
    depth = Number(cityConfig.depth);
  }
  // An explicit workflow_dispatch input wins over the registry's per-city
  // value -- it exists precisely so a human can force one-off grayscale
  // runs without editing the registry. Not specified by the ticket; this
  // precedence is a judgment call, called out in the report.
  if (override !== undefined && override !== null && override !== '') {
    depth = Number(override);
  }
  if (depth !== 1 && depth !== 2) {
    throw new Error(`Invalid depth "${depth}" -- only 1 (default) or 2 (opt-in grayscale) are supported.`);
  }
  return depth;
}

// ---- Deliverable 3: convert + validate + upload + read-back verify ----

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });
  if (result.error) {
    throw new Error(`${cmd} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}\n${result.stderr || ''}`);
  }
  return result;
}

// screenshot.js treats OUTPUT_FILE as a BASE name and derives its own outputs
// from it (see screenshot.js: `outputFile.replace(/\.png$/, ...)`):
//   `X.png`  ->  `X-raw.png`   the actual screenshot
//   `X.png`  ->  `X-meta.json` the extracted LAST UPDATE time
// It never writes OUTPUT_FILE itself. Callers must therefore pass `{slug}.png`,
// NOT `{slug}-raw.png` -- the latter double-suffixes to `{slug}-raw-raw.png`
// and the convert step then fails on a missing file. Keep this derivation in
// one place so the two files cannot drift apart again.
function screenshotPaths(slug) {
  const outputFile = `${slug}.png`;
  return {
    outputFile,
    rawFile: outputFile.replace(/\.png$/, '-raw.png'),
    metaFile: outputFile.replace(/\.png$/, '-meta.json'),
  };
}

function takeScreenshot(slug, dashboardUrl, outputFile) {
  const result = spawnSync('node', ['screenshot.js'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env, SCREENSHOT_URL: dashboardUrl, OUTPUT_FILE: outputFile },
  });
  if (result.error) {
    throw new Error(`screenshot.js failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`screenshot.js exited ${result.status}`);
  }
}

function convertImage(rawFile, outFile, depth) {
  const args = depth === 2
    ? [rawFile, '-colorspace', 'Gray', '-ordered-dither', 'o4x4,4', '-depth', '2', '-strip', `png:${outFile}`]
    : [rawFile, '-monochrome', '-colors', '2', '-depth', '1', '-strip', `png:${outFile}`];
  run('convert', args);
}

function validateImage(outFile, expectedDepth) {
  const result = run('identify', ['-format', '%w %h %z', outFile]);
  const [w, h, z] = result.stdout.trim().split(/\s+/).map(Number);
  if (w !== 800 || h !== 480) {
    throw new Error(`geometry mismatch: got ${w}x${h}, expected 800x480`);
  }
  if (z !== expectedDepth) {
    throw new Error(`depth mismatch: got depth=${z}, expected depth=${expectedDepth}`);
  }
  return { width: w, height: h, depth: z };
}

async function uploadNext(base, slug, buffer, token) {
  const url = `${base}/upload/${slug}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'image/png',
      'Content-Length': String(buffer.length),
    },
    body: buffer,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`POST ${url} -> HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res;
}

/**
 * Fetch /img/{slug} once and compare it to what we just uploaded.
 * Throws on anything wrong; returns {contentLength, bytes} on success.
 */
async function readbackOnce(base, slug, uploaded) {
  const url = `${base}/img/${slug}`;
  // Accept-Encoding: identity mimics the TRMNL device, which does not
  // negotiate compression. Without it undici sends
  // `accept-encoding: gzip, deflate, br`; if the edge then compresses,
  // undici transparently DECOMPRESSES and DROPS content-length, because the
  // header no longer describes the decoded body. The check would then fail on
  // a response the device never actually receives. Asking for identity makes
  // this verify the bytes and headers the device will really get.
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
    headers: { 'Accept-Encoding': 'identity' },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status}`);
  }
  const contentLength = res.headers.get('content-length');
  const bodyBuf = Buffer.from(await res.arrayBuffer());

  // Content-Length is a WARNING, not a failure. Netlify serves function
  // responses with `Transfer-Encoding: chunked`, and HTTP/1.1 forbids
  // sending both -- so the header img.js sets is stripped by the platform
  // and no change on our side restores it. Run #14011 confirmed this:
  // content-encoding=none, transfer-encoding=chunked.
  //
  // Failing on it would block the pipeline on something that demonstrably
  // works: /img/{slug} has been the live delivery path for months, with the
  // Redirect plugin pointing at it, and the device renders from it fine.
  // usetrmnl/trmnl-firmware#156 describes endpoints that send neither a
  // length nor chunked framing; chunked is a valid, self-delimiting body.
  //
  // The byte-identity check below is the real guarantee and stays hard.
  if (!contentLength) {
    const te = res.headers.get('transfer-encoding') || 'none';
    console.warn(
      `  note: ${url} sent no Content-Length (transfer-encoding=${te}). ` +
      `Expected on Netlify Functions; body verified by byte comparison.`);
  } else if (Number(contentLength) !== bodyBuf.length) {
    throw new Error(`Content-Length (${contentLength}) does not match actual body length (${bodyBuf.length})`);
  }
  if (bodyBuf.length !== uploaded.length || !bodyBuf.equals(uploaded)) {
    throw new Error(`read-back bytes differ from uploaded bytes (uploaded ${uploaded.length}B, read back ${bodyBuf.length}B)`);
  }
  return { contentLength: contentLength ? Number(contentLength) : null, bytes: bodyBuf.length };
}

// Netlify Blobs is eventually consistent. A read taken ~1s after a write can
// be served the PREVIOUS version -- observed in runs #14014/#14016/#14017 as
// "read-back bytes differ (uploaded 5351B, read back 5367B)", a whole prior
// image, interleaved with passes on the identical commit.
//
// consistency: 'strong' is NOT the fix: it is unavailable in Lambda-compat
// functions (no uncachedEdgeURL) and fails closed, which broke uploads
// entirely in run #14018.
//
// So: retry the read, briefly. This is a propagation delay, not a masked
// bug -- the bytes we wrote are correct, they just have not landed on the
// edge we are reading from. A retry that succeeds is still logged, so if
// propagation ever gets slow enough to matter it shows up rather than being
// silently absorbed. The device is not affected either way: it fetches on
// its own ~15-minute cadence, never a second after a write.
const READBACK_ATTEMPTS = 4;
const READBACK_DELAY_MS = 1500;

async function verifyReadback(base, slug, uploaded, opts = {}) {
  const attempts = opts.attempts ?? READBACK_ATTEMPTS;
  const delayMs = opts.delayMs ?? READBACK_DELAY_MS;
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await readbackOnce(base, slug, uploaded);
      if (attempt > 1) {
        console.warn(
          `  note: read-back for ${slug} matched on attempt ${attempt}/${attempts} ` +
          `(~${((attempt - 1) * delayMs) / 1000}s of blob propagation delay).`);
      }
      return result;
    } catch (err) {
      lastErr = err;
      // Only a stale-read looks like this. A wrong status, a bad
      // Content-Length or a genuinely corrupt body will not fix itself by
      // waiting, so fail those immediately rather than burning the budget.
      if (!/read-back bytes differ/.test(err.message) || attempt === attempts) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function readMeta(metaFile) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return meta.lastUpdate || null;
  } catch {
    return null;
  }
}

async function runCity(slug, cityConfig, opts) {
  const { base, dashboardBase, token, depthOverride, now, dryRun } = opts;
  const startedAt = Date.now();

  if (!SLUG_RE.test(slug)) {
    return { slug, ok: false, skipped: false, elapsedMs: 0, error: `refusing unsafe slug "${slug}"` };
  }

  if (!schedule.shouldRun(cityConfig, now)) {
    return { slug, ok: true, skipped: true, reason: 'quiet-hours', elapsedMs: 0 };
  }

  const depth = resolveDepth(cityConfig, depthOverride);
  const names = screenshotPaths(slug);
  const rawFile = path.join(REPO_ROOT, names.rawFile);
  // Local scratch file only -- never a blob key. Named distinctly from the
  // committed `{slug}.png` fallback so a stray write cannot clobber it.
  const outFile = path.join(REPO_ROOT, `${slug}-out.png`);
  const metaFile = path.join(REPO_ROOT, names.metaFile);
  const dashboardUrl = `${dashboardBase}/${slug}`;

  try {
    takeScreenshot(slug, dashboardUrl, names.outputFile);
    convertImage(rawFile, outFile, depth);
    validateImage(outFile, depth);

    const buffer = fs.readFileSync(outFile);
    if (buffer.length >= 1_000_000) {
      throw new Error(`output is ${buffer.length} bytes, expected < 1MB`);
    }

    if (!dryRun) {
      if (!token) {
        throw new Error('UPLOAD_TOKEN is not set -- refusing to attempt an unauthenticated upload');
      }
      await uploadNext(base, slug, buffer, token);
      await verifyReadback(base, slug, buffer);
    }

    return {
      slug,
      ok: true,
      skipped: false,
      elapsedMs: Date.now() - startedAt,
      size: buffer.length,
      depth,
      lastUpdate: readMeta(metaFile),
    };
  } catch (err) {
    return {
      slug,
      ok: false,
      skipped: false,
      elapsedMs: Date.now() - startedAt,
      depth,
      error: err.message,
    };
  }
}

// ---- main ----

function printSummary(results) {
  console.log('\n=== Run summary ===');
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${r.slug}: SKIPPED (${r.reason})`);
    } else if (r.ok) {
      console.log(`  ${r.slug}: OK depth=${r.depth} size=${r.size}B elapsed=${r.elapsedMs}ms lastUpdate=${r.lastUpdate || '-'}`);
    } else {
      console.log(`  ${r.slug}: FAILED (${r.elapsedMs}ms) -- ${r.error}`);
    }
  }

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const rows = results.map(r => {
      if (r.skipped) return `| ${r.slug} | skipped | - | - | ${r.reason} |`;
      if (r.ok) return `| ${r.slug} | ok | ${r.depth} | ${r.elapsedMs} | size=${r.size}B lastUpdate=${r.lastUpdate || '-'} |`;
      return `| ${r.slug} | **FAILED** | ${r.depth || '-'} | ${r.elapsedMs} | ${r.error} |`;
    });
    const md = [
      '## Screenshot run summary',
      '',
      '| slug | status | depth | elapsed (ms) | detail |',
      '|---|---|---|---|---|',
      ...rows,
      '',
    ].join('\n');
    fs.appendFileSync(summaryFile, md);
  }
}

async function main() {
  const base = envOrDefault('BASE_URL', 'https://wetterdirect.netlify.app');
  const dashboardBase = envOrDefault('DASHBOARD_BASE_URL', base);
  const token = process.env.UPLOAD_TOKEN;
  const only = envOrDefault('ONLY', '') || undefined;
  const depthOverride = envOrDefault('DEPTH_OVERRIDE', '');
  const dryRun = envOrDefault('DRY_RUN', '') === '1';

  const registry = await loadRegistry();
  const cities = selectCities(registry, only);

  if (cities.length === 0) {
    console.log('No TRMNL-enabled cities matched -- nothing to do.');
    return;
  }

  const now = new Date();
  const results = [];
  for (const [slug, cityConfig] of cities) {
    console.log(`\n--- ${slug} ---`);
    const result = await runCity(slug, cityConfig, { base, dashboardBase, token, depthOverride, now, dryRun });
    results.push(result);
  }

  printSummary(results);

  const anyFailed = results.some(r => !r.skipped && !r.ok);
  if (anyFailed) {
    process.exitCode = 1;
  }
}

module.exports = {
  loadRegistry, selectCities, resolveDepth, convertImage, validateImage,
  uploadNext, verifyReadback, runCity, main, screenshotPaths,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  });
}
