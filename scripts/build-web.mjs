import {access, cp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compressProject} from './pack-project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'docs');
const output = path.join(root, 'dist');
if (path.dirname(output) !== root || path.basename(output) !== 'dist') throw new Error('Invalid build directory');
await rm(output, {recursive:true, force:true});
await mkdir(output, {recursive:true});
await cp(source, output, {recursive:true});
const projectPath = path.join(output, 'assets', 'project.json');
const original = await readFile(projectPath);
const compressed = compressProject(original);
await writeFile(projectPath + '.gz', compressed);
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Upstream runtime changed: expected exactly one ${before}`);
  return source.replace(before,after);
}
// Decode into the exact same JSON bytes before calling the original VM. Old
// browsers retain the original uncompressed loading path and all assets.
const runtimePath = path.join(output,'index.js');
let runtime = await readFile(runtimePath,'utf8');
runtime = replaceOnce(runtime,
  'const r=new XMLHttpRequest;r.onload=()=>{n(r.response)}',
  'const compressedProject=typeof DecompressionStream==="function",r=new XMLHttpRequest;r.onload=async()=>{try{const projectBytes=compressedProject?await new Response(new Blob([r.response]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer():r.response;document.documentElement.dataset.eewProjectEncoding=compressedProject?"gzip":"json";document.documentElement.dataset.eewProjectBytes=String(r.response.byteLength);n(projectBytes)}catch(error){a(error)}}');
runtime = replaceOnce(runtime, 'r.open("GET","./assets/project.json")', 'r.open("GET",compressedProject?"./assets/project.json.gz":"./assets/project.json")');
await writeFile(runtimePath,runtime);
const workerPath=path.join(output,'sw.js');
const workerSource=await readFile(workerPath,'utf8');
const shellList=workerSource.match(/const shellFiles = (\[[\s\S]*?\]);/);
if(!shellList) throw new Error('Static shell file list is missing');
for(const match of shellList[1].matchAll(/"([^"]+)"/g)) await access(path.join(output,match[1]));
const worker=replaceOnce(workerSource,'  "assets/project.json",','  typeof DecompressionStream === "function" ? "assets/project.json.gz" : "assets/project.json",');
await writeFile(workerPath,worker);
const files = [];
async function walk(dir) {
  for (const entry of (await readdir(dir, {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.isFile() && target !== path.join(output, 'hash')) files.push(target);
  }
}
await walk(output);
const hash = createHash('sha256');
for (const file of files) { hash.update(path.relative(output,file).replaceAll('\\','/') + '\0'); hash.update(await readFile(file)); hash.update('\0'); }
const release = hash.digest('hex');
await writeFile(path.join(output, 'hash'), release + '\n');
console.log(`Web build: ${files.length + 1} files; project download ${original.length} -> ${compressed.length} bytes (${(100 * (1-compressed.length/original.length)).toFixed(1)}% smaller); release ${release.slice(0,12)}`);
