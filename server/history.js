'use strict';

const fs = require('fs/promises');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'history.json');
const MAX_ENTRIES = 50;

let writeChain = Promise.resolve();

async function readAll() {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function writeAll(entries) {
  writeChain = writeChain.then(async () => {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entries));
    await fs.rename(tmp, FILE);
  });
  return writeChain;
}

async function add(entry) {
  const all = await readAll();
  all.unshift(entry);
  await writeAll(all.slice(0, MAX_ENTRIES));
}

async function list() {
  const all = await readAll();
  return all.map(({ items, ...summary }) => summary);
}

async function get(id) {
  const all = await readAll();
  return all.find((e) => e.id === id) || null;
}

async function clear() {
  await writeAll([]);
}

module.exports = { add, list, get, clear };
