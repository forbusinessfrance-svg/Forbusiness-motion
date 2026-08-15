/**
 * Serveur statique minimal — zéro dépendance.
 *
 * Sert la version modulaire (`dev.html`), qui charge des modules ES et des
 * polices via `fetch` — ce que le protocole `file://` interdit.
 *
 * Le livrable `index.html`, lui, n'a besoin de rien : il s'ouvre directement.
 *
 *   node serve.mjs        →  http://localhost:5173/dev.html
 *   node serve.mjs 8080   →  port personnalisé
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.');
const PORT = Number(process.argv[2]) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

  // Empêche toute remontée hors du dossier du projet.
  const target = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const file = await readFile(target);
    response.writeHead(200, {
      'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
      // Pas de cache : on itère sur le rendu, chaque rechargement doit être frais.
      'Cache-Control': 'no-store',
    });
    response.end(file);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
});

server.listen(PORT, () => {
  console.log(`ForBusinessFrance — motion  ·  http://localhost:${PORT}`);
});
