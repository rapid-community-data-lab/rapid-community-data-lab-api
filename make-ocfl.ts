import ocfl from '@ocfl/ocfl-fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repository = ocfl.storage({
  root: process.env.OCFL_PATH || '/opt/storage/oni/ocfl',
  workspace: process.env.OCFL_SCRATCH || '/opt/storage/oni/scratch-ocfl',
  layout: {
    extensionName: '000N-path-direct-storage-layout'
  },
  fixityAlgorithms: ['crc32']
});
try {
  await repository.load();
} catch (e) {
  await repository.create();
}

const directories = await readdir('./test-data');
for (let name of directories) {
  const base = join('./test-data', name);
  try {
    const meta = JSON.parse(await readFile(join(base, 'ro-crate-metadata.json'), { encoding: 'utf-8' }));
    const objectName = meta['@graph'][0].about['@id'];
    const o = repository.object(objectName);
    await o.import(base);
  } catch (error) {
  }
}
