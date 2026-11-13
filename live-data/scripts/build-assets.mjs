import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const files = ['observatories/seismic/index.html', 'observatories/transit/index.html', 'css/editorial.css', 'css/observatory.css', 'js/observatory.js', 'js/observatory-map.js', 'assets/vendor/leaflet/leaflet.js', 'assets/vendor/leaflet/leaflet.css', 'assets/vendor/leaflet/LICENSE', 'assets/vendor/leaflet/images/layers.png', 'assets/vendor/leaflet/images/layers-2x.png', 'assets/vendor/leaflet/images/marker-icon.png', 'assets/vendor/leaflet/images/marker-icon-2x.png', 'assets/vendor/leaflet/images/marker-shadow.png', 'assets/vendor/d3.v7.min.js'];
for (const name of files) { const target = resolve(root, 'live-data/public', name); await mkdir(dirname(target), { recursive: true }); await copyFile(resolve(root, name), target); }
await writeFile(resolve(root, 'live-data/public/index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live Data Lab | Chinmay Arora</title><h1>Live Data Lab</h1><p><a href="/observatories/seismic/">Seismic observatory</a></p><p><a href="/observatories/transit/">Transit reliability lab</a></p></html>\n');
console.log(`Built ${files.length} deploy assets from the portfolio source.`);
