/**
 * Build — produit `index.html`, un fichier unique et autonome.
 *
 *   node build.mjs
 *
 * Le fichier de sortie s'ouvre directement depuis le disque : aucun serveur,
 * aucun module externe, aucune police à charger. Tout est dedans — three.js,
 * les polices en data URI, le CSS et les seize modules du projet.
 *
 * ── Pourquoi un bundler écrit à la main ────────────────────────────────────
 * Le projet n'a aucune dépendance, et en ajouter une pour produire un fichier
 * plat en serait une de trop. Le transform nécessaire tient en trois règles,
 * parce que les sources s'y tiennent : imports nommés uniquement, exports
 * nommés uniquement, pas d'import dynamique.
 *
 * Chaque module devient une IIFE qui retourne ses exports, enregistrée dans une
 * table. Les imports deviennent des déstructurations depuis cette table. Aucun
 * module ne partage donc sa portée avec un autre — c'est ce qui évite les
 * collisions de noms entre trois `DEG` et le `Sprite` de three.js.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.');
const ENTRY = 'src/main.js';
const OUTPUT = 'index.html';

const THREE_CORE = 'vendor/three.core.min.js';
const THREE_MODULE = 'vendor/three.module.min.js';

const read = (path) => readFile(join(ROOT, path), 'utf8');

/* ─────────────────────────────────────────────────────────────────────────────
 * Analyse des modules ES
 * ────────────────────────────────────────────────────────────────────────── */

/** `import { a, b as c } from './x.js';` — la seule forme utilisée ici. */
const IMPORT_RE = /^import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm;

/** Sépare `Public as local` en paire. */
function parseBindings(list) {
  return list
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [source, alias] = entry.split(/\s+as\s+/).map((s) => s.trim());
      return { source, local: alias ?? source };
    });
}

/**
 * Transforme un module du projet en IIFE enregistrée dans la table `__M`.
 * Retourne aussi ses dépendances internes, pour l'ordre de sortie.
 */
function transformModule(key, source) {
  const dependencies = [];
  let body = source.replace(IMPORT_RE, (_match, bindings, specifier) => {
    const names = parseBindings(bindings)
      .map(({ source: name, local }) => (name === local ? name : `${name}: ${local}`))
      .join(', ');

    // three.js vit dans la portée englobante : rien à câbler.
    if (specifier.includes('vendor/three')) return `const { ${names} } = __THREE;`;

    const target = normaliseKey(key, specifier);
    dependencies.push(target);
    return `const { ${names} } = __M['${target}'];`;
  });

  // `export const X` / `export function X` / `export class X` → collecte + retrait.
  const exported = [];
  body = body.replace(
    /^export\s+(const|let|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_match, keyword, name) => {
      exported.push(name);
      return `${keyword} ${name}`;
    }
  );

  assertClean(key, body);

  return {
    dependencies,
    code:
      `__M['${key}'] = (function () {\n` +
      `${body}\n` +
      `return { ${exported.join(', ')} };\n` +
      `})();\n`,
  };
}

/** Résout un specifier relatif en clé de module, relative à la racine. */
function normaliseKey(fromKey, specifier) {
  return relative(ROOT, resolve(ROOT, dirname(fromKey), specifier)).split('\\').join('/');
}

/** Le transform est exact ou il échoue — il ne doit jamais produire un à-peu-près. */
function assertClean(key, body) {
  const leftover = body.match(/^\s*(import|export)\s/m);
  if (leftover) {
    throw new Error(
      `${key} : syntaxe de module non transformée (« ${leftover[0].trim()} »). ` +
        'Le bundler ne gère que les imports et exports nommés.'
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * three.js
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Emballe un fichier de three dans une IIFE qui retourne ses exports.
 *
 * Trois formes à traiter, et l'ordre compte :
 *
 *   import{A as a}from"…"          → liaison locale depuis le module source
 *   export{X}from"…"               → réexport *transitant* : X n'existe pas
 *                                    localement, il vient du module source
 *   export{loc as Public}          → export depuis la portée locale
 *
 * Le réexport doit être traité avant l'export local : sinon le motif de
 * l'export local mord dessus et laisse un `from"…"` orphelin dans le corps.
 *
 * La build minifiée exporte sous alias (`export{ca as WebGLRenderer}`), donc
 * les noms publics n'existent nulle part dans la portée du fichier — d'où la
 * reconstruction explicite de la table publique.
 *
 * @param {string} source
 * @param {string|null} dependency expression JS du module importé
 */
function wrapEsModule(source, dependency) {
  const returned = [];
  let body = source;

  body = body.replace(
    /^import\s*\{([^{}]*)\}\s*from\s*['"][^'"]*['"]\s*;?/gm,
    (_match, list) => {
      if (!dependency) throw new Error('Import inattendu dans un module sans dépendance.');
      const names = parseBindings(list)
        .map(({ source: name, local }) => (name === local ? name : `${name}: ${local}`))
        .join(', ');
      return `const { ${names} } = ${dependency};`;
    }
  );

  body = body.replace(
    /export\s*\{([^{}]*)\}\s*from\s*['"][^'"]*['"]\s*;?/g,
    (_match, list) => {
      if (!dependency) throw new Error('Réexport inattendu dans un module sans dépendance.');
      for (const { source: name, local } of parseBindings(list)) {
        returned.push(`${local}: ${dependency}.${name}`);
      }
      return '';
    }
  );

  body = body.replace(/export\s*\{([^{}]*)\}\s*;?/g, (_match, list) => {
    for (const { source: name, local } of parseBindings(list)) {
      returned.push(`${local}: ${name}`);
    }
    return '';
  });

  if (!returned.length) throw new Error('Aucun export trouvé — le fichier three attendu a changé.');
  assertClean('three', body);

  return `(function () {\n${body}\nreturn { ${returned.join(', ')} };\n})()`;
}

function wrapThree(coreSource, moduleSource) {
  return (
    `const __THREE_CORE = ${wrapEsModule(coreSource, null)};\n` +
    `const __THREE = ${wrapEsModule(moduleSource, '__THREE_CORE')};\n`
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Build
 * ────────────────────────────────────────────────────────────────────────── */

/** Parcours en profondeur : un module est écrit après ses dépendances. */
async function collectModules(entry) {
  const modules = new Map();
  const ordered = [];
  const visiting = new Set();

  const visit = async (key) => {
    if (modules.has(key)) return;
    if (visiting.has(key)) throw new Error(`Cycle d'imports sur ${key}.`);
    visiting.add(key);

    const transformed = transformModule(key, await read(key));
    for (const dependency of transformed.dependencies) await visit(dependency);

    visiting.delete(key);
    modules.set(key, transformed);
    ordered.push(key);
  };

  await visit(entry);
  return ordered.map((key) => modules.get(key).code);
}

async function dataUri(path, type) {
  const buffer = await readFile(join(ROOT, path));
  return `data:${type};base64,${buffer.toString('base64')}`;
}

async function build() {
  const [shell, css, coreSource, moduleSource] = await Promise.all([
    read('dev.html'),
    read('styles/app.css'),
    read(THREE_CORE),
    read(THREE_MODULE),
  ]);

  const [displayFont, textFont] = await Promise.all([
    dataUri('fonts/InterDisplay-ExtraBold.woff2', 'font/woff2'),
    dataUri('fonts/Inter-Bold.woff2', 'font/woff2'),
  ]);

  const modules = await collectModules(ENTRY);

  const script =
    `(function () {\n'use strict';\n` +
    `globalThis.__FBF_FONTS = {\n` +
    `  display: '${displayFont}',\n` +
    `  text: '${textFont}',\n` +
    `};\n` +
    wrapThree(coreSource, moduleSource) +
    `const __M = {};\n` +
    modules.join('\n') +
    `})();\n`;

  // Toutes les substitutions passent par une fonction : un remplacement par
  // chaîne interpréterait les motifs `$&` et `$'`, et le three.js minifié en
  // contient — il se réinjecterait des morceaux de lui-même.
  const head = shell
    // Le CSS et les polices sont embarqués : plus rien à aller chercher.
    .replace(/^.*<link rel="stylesheet"[^>]*>\n/m, () => `<style>\n${css}</style>\n`)
    .replace(/^.*<link rel="preload"[^>]*>\n/gm, () => '')
    .replace(' (dev)</title>', () => '</title>');

  const html = head.replace(
    /^.*<script type="module"[^>]*><\/script>\n/m,
    () => `  <script>\n${script}  </script>\n`
  );

  if (html.includes('<link rel="stylesheet"') || html.includes('type="module"')) {
    throw new Error('Le shell contient encore une référence externe.');
  }

  await writeFile(join(ROOT, OUTPUT), html);

  const megabytes = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
  console.log(`${OUTPUT} — ${megabytes} Mo, ${modules.length} modules, autonome.`);
}

build().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
