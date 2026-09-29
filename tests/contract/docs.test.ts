import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// SPEC-0021: what a first-time reader of the repository sees.
const root = fileURLToPath(new URL('../../', import.meta.url));

/** Tracked files plus new files that are not ignored, so a check covers work before its commit. */
const repositoryFiles = (...patterns: string[]) =>
  execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...patterns],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((file) => file && existsSync(join(root, file)));

const readme = () => readFileSync(join(root, 'README.md'), 'utf8');

/** Markdown without fenced or inline code, where bracketed text is not a link. */
const prose = (text: string) =>
  text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');

/** Inline links, images and reference definitions; footnote definitions are not links. */
const linkTargets = (text: string) => [
  ...[...text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(
    (match) => match[1]!,
  ),
  ...[...text.matchAll(/^ {0,3}\[(?!\^)[^\]]+\]:\s*<?(\S+?)>?(?:\s.*)?$/gm)].map(
    (match) => match[1]!,
  ),
];

const isLocal = (target: string) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#');

const localImages = (text: string) =>
  [...prose(text).matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)]
    .map((match) => match[1]!)
    .filter(isLocal);

test('0021-R01 the README opens with what it is, three reasons, a diagram, a quickstart, a comparison and the status', () => {
  const text = readme();
  const opening = /^# Orchvia\n\n([^\n#-][^\n]*)\n\n((?:- [^\n]+\n)+)\n!\[/.exec(text);
  assert.ok(opening, 'title, one sentence, a list of reasons, then the diagram');
  assert.equal(opening[2]!.trimEnd().split('\n').length, 3, 'three reasons');
  const headings = ['## Quickstart', '## How it compares', '## Status'].map((heading) =>
    text.indexOf(`\n${heading}\n`),
  );
  assert.ok(
    headings.every((at) => at > 0),
    `missing: ${headings.flatMap((at, index) => (at > 0 ? [] : [index]))}`,
  );
  assert.deepEqual(
    [...headings].sort((a, b) => a - b),
    headings,
    'quickstart, comparison, status',
  );
});

test('0021-R01 the offline quickstart runs two tasks on one warm session', () => {
  const run = spawnSync(process.execPath, ['examples/typescript/quickstart.ts'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1\. .*: completed, session /);
  assert.match(run.stdout, /2\. .*: completed, session /);
  assert.match(run.stdout, /reused the first agent's session: true/);
});

test('0021-R12 the Python quickstart runs the same two tasks on one warm session', () => {
  // The host that the example starts runs packages/cli/src/main.ts, not a file under examples/, so
  // the reserve guard of SPEC-0011 R10 applies to it: the test asks for the 4 KiB reserve.
  const args = ['--node', process.execPath, '--emergency-bytes', '4096'];
  const run = spawnSync('python3', ['examples/python/quickstart.py', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PYTHONPATH: join(root, 'python/src') },
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trimEnd().split('\n');
  const first = /^1\. "Draft the release notes": completed, session (\S+)$/.exec(lines[0] ?? '');
  const second = /^2\. "Tighten the draft you just wrote": completed, session (\S+)$/.exec(
    lines[1] ?? '',
  );
  assert.ok(first && second && lines.length === 3, run.stdout);
  assert.equal(second[1], first[1]);
  assert.equal(lines[2], "The second task reused the first agent's session: true");
});

test('0021-R02 0021-R06 0021-R08 the README carries no release evidence, price or paid judge, and stays within 15 KB', () => {
  const text = readme();
  assert.ok(Buffer.byteLength(text) <= 15 * 1024, `${Buffer.byteLength(text)} bytes`);
  const forbidden: [string, RegExp][] = [
    ['a test count', /\b\d+\s+(?:[A-Za-z.]+\s+)?tests?\b|\b(\d{2,})\/\1\b/i],
    ['a CI run id', /actions\/runs\/\d+|\brun\s+\d{8,}\b/i],
    ['a candidate version', /\brc\.?\d+\b/i],
    ['a commit hash', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
    ['a price', /\$\s?\d/],
    ['a paid judge', /\bJev\b|TypeSafe/],
  ];
  for (const [what, pattern] of forbidden)
    assert.doesNotMatch(text, pattern, `the README states ${what}`);
});

test('0021-R03 the README uses no internal term; docs/concepts.md explains them', () => {
  assert.doesNotMatch(
    readme(),
    /A\/Q\/R|quarantin|outcome_unknown|attestation|stopProof|stop proof|dispatch occupancy/i,
  );
  const concepts = readFileSync(join(root, 'docs/concepts.md'), 'utf8');
  for (const term of ['A/Q/R', 'quarantine', 'outcome_unknown', 'attestation'])
    assert.ok(concepts.includes(term), `docs/concepts.md explains ${term}`);
});

test('0021-R04 every relative link in the repository Markdown resolves', () => {
  const broken: string[] = [];
  for (const file of repositoryFiles('*.md')) {
    const text = prose(readFileSync(join(root, file), 'utf8'));
    for (const target of linkTargets(text).filter(isLocal)) {
      const path = decodeURIComponent(target.replace(/[?#].*$/, ''));
      if (!path) continue;
      const absolute = path.startsWith('/') ? join(root, path) : resolve(root, dirname(file), path);
      if (!existsSync(absolute)) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('0021-R05 the README embeds a diagram of at most 400 KB', () => {
  const images = localImages(readme());
  assert.ok(images.length > 0, 'one local diagram');
  for (const image of images) {
    const size = statSync(join(root, decodeURIComponent(image))).size;
    assert.ok(size <= 400 * 1024, `${image} is ${size} bytes`);
  }
});

/** CSS declarations, with the `font` shorthand split into its size, family and weight. */
function fontDeclarations(css: string) {
  const result: Record<string, string> = {};
  for (const declaration of css.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (name === 'font') {
      // [style] [weight] size[/line-height] family
      const shorthand = /^(?:(.*?)\s+)?([\d.]+px)(?:\/\S+)?\s+(.+)$/.exec(value);
      if (!shorthand) continue;
      result['font-size'] = shorthand[2]!;
      result['font-family'] = shorthand[3]!;
      if (shorthand[1]) result['font-weight'] = shorthand[1];
    } else if (name.startsWith('font-')) result[name] = value;
  }
  return result;
}

/** The font of each text in a hand-written SVG: attributes, then style rules, then inline style. */
function svgTextFonts(svg: string) {
  const rules = [...svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].flatMap(([, sheet]) =>
    [...sheet!.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selectors, body]) => ({
      selectors: selectors!.split(',').map((selector) => selector.trim()),
      font: fontDeclarations(body!),
    })),
  );
  return [...svg.matchAll(/<text\b([^>]*)>([^<]*)/g)].map(([, attributes, content]) => {
    const font: Record<string, string> = {};
    for (const [, name, value] of attributes!.matchAll(
      /\s(font-family|font-size|font-weight)="([^"]*)"/g,
    ))
      font[name!] = value!;
    const classes = /\sclass="([^"]*)"/.exec(attributes!)?.[1]!.split(/\s+/) ?? [];
    const applies = (selectors: string[]) =>
      classes.some((name) => selectors.includes(`.${name}`) || selectors.includes(`text.${name}`));
    for (const rule of rules) if (rule.selectors.includes('text')) Object.assign(font, rule.font);
    for (const rule of rules) if (applies(rule.selectors)) Object.assign(font, rule.font);
    const inline = /\sstyle="([^"]*)"/.exec(attributes!)?.[1];
    if (inline) Object.assign(font, fontDeclarations(inline));
    return {
      text: content!.trim(),
      family: font['font-family'],
      size: Number.parseFloat(font['font-size'] ?? ''),
    };
  });
}

test('0021-R11 the overview diagram sets the font of every text, stays legible at 900 px and names both ways a result is accepted', () => {
  const text = readme();
  const diagrams = localImages(text).filter((image) => image.endsWith('.svg'));
  assert.equal(diagrams.length, 1, 'the README embeds one SVG overview');
  const svg = readFileSync(join(root, decodeURIComponent(diagrams[0]!)), 'utf8');
  const problems: string[] = [];
  // SVG has no `font` attribute: browsers ignore it and draw the text in a serif 16 px regular.
  for (const [element] of svg.matchAll(/<[^>]*\sfont\s*=[^>]*>/g))
    problems.push(`a font attribute, which SVG does not have: ${element}`);
  const width = Number(/\sviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)/.exec(svg)?.[1]);
  if (!(width > 0 && width <= 1200)) problems.push(`a viewBox ${width} wide`);
  const fonts = svgTextFonts(svg);
  for (const font of fonts)
    if (!font.family || !(font.size >= 16))
      problems.push(`"${font.text}": ${font.family ?? 'no font family'}, ${font.size || 'no'} px`);
  const accepts = /a person or a registered check accepts each result/i;
  if (!accepts.test(/<desc\b[^>]*>([^<]*)</.exec(svg)?.[1] ?? ''))
    problems.push('the description does not name both ways a result is accepted');
  if (!fonts.some((font) => accepts.test(font.text)))
    problems.push('no text names both ways a result is accepted');
  if (!accepts.test(/!\[([^\]]*)\]\(\s*<?[^)\s>]+\.svg/.exec(text)?.[1] ?? ''))
    problems.push('the alternative text in the README does not name both ways');
  assert.deepEqual(problems, []);
});

// The names are stored as SHA-256 digests of lower-case words and word pairs, so this file does not
// contain them.
const INTERNAL_NAMES = new Set([
  '6e347238eb5efcb1c226e033c8aca5f333c5faeedf353766d9f265738b7f7c7b',
  'aa0ff7e35464568865fc95ab9a63f44af05776cc2ebd67806900a027f483e2e1',
  'b933a4046b43fb33a5a12274c3ca63a7bc2e7819c2aa2f967f0cafcd4e48acaa',
]);
const BINARY = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.wasm',
  '.sqlite',
]);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

test('0021-R09 no repository file names a downstream product', () => {
  const found: string[] = [];
  for (const file of repositoryFiles()) {
    if (BINARY.has(extname(file).toLowerCase())) continue;
    const data = readFileSync(join(root, file));
    if (data.subarray(0, 8000).includes(0)) continue;
    const words =
      data
        .toString('utf8')
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? [];
    if (
      words.some(
        (word, index) =>
          INTERNAL_NAMES.has(digest(word)) ||
          (index > 0 && INTERNAL_NAMES.has(digest(`${words[index - 1]} ${word}`))),
      )
    )
      found.push(file);
  }
  assert.deepEqual(found, []);
});

test('0021-P10 no document states which version is the latest release', () => {
  // GitHub Releases names the latest release (D-rel-3); a sentence that does goes stale with the next.
  const claims = [
    /\bversion \d+\.\d+\.\d+\S* is published\b/i,
    /\b\d+\.\d+\.\d+\S* is published on\b/i,
    /\bthe latest (?:released )?version is \d+\.\d+\.\d+/i,
  ];
  const found: string[] = [];
  for (const file of repositoryFiles('*.md', '.claude/*.md'))
    for (const claim of claims)
      if (claim.test(readFileSync(join(root, file), 'utf8'))) found.push(`${file}: ${claim}`);
  assert.deepEqual(found, []);
});

test('0043-L02 the status table lists exactly the specifications, and its summary names no older range', async () => {
  const { readdirSync } = await import('node:fs');
  const status = readFileSync(join(root, 'docs/status.md'), 'utf8');
  const linked = [...status.matchAll(/\| \[SPEC-[^\]]+\]\(specs\/([^)]+)\)/g)].map((m) => m[1]!);
  const files = readdirSync(join(root, 'docs/specs')).filter((name) => name.endsWith('.md'));
  assert.deepEqual([...new Set(linked)].sort(), files.sort());
  const newest = Math.max(...files.map((name) => Number(name.slice(0, 4))));
  for (const [, end] of status.matchAll(/SPEC-0001 to SPEC-(\d{4})/g))
    assert.equal(Number(end), newest, `the summary says SPEC-0001 to SPEC-${end}`);
});

test('0043-L03 the verified Codex versions, TESTED_CODEX_VERSIONS and CI agree', async () => {
  const { TESTED_CODEX_VERSIONS } = await import('../../packages/adapter-codex/src/local.ts');
  const workflow = readFileSync(join(root, '.github/workflows/offline.yml'), 'utf8');
  const installed = [
    ...new Set([...workflow.matchAll(/@openai\/codex@(\d+\.\d+\.\d+)/g)].map((m) => m[1]!)),
  ];
  const ledger = readFileSync(join(root, 'docs/acceptance/readiness.md'), 'utf8');
  const line = /Codex CLI versions verified in CI: ([^\n]+)/.exec(ledger)?.[1];
  assert.ok(line, 'the ledger names the Codex versions CI verifies');
  const listed = [...line.matchAll(/\d+\.\d+\.\d+/g)].map((m) => m[0]);
  const sort = (list: readonly string[]) =>
    [...list].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  assert.deepEqual(sort(listed), sort(installed));
  assert.deepEqual(sort(TESTED_CODEX_VERSIONS), sort(installed));
});
