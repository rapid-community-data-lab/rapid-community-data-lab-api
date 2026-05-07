import type { OcflObject } from '@ocfl/ocfl';
import ocfl from '@ocfl/ocfl-fs';
import { createCRC32 } from 'hash-wasm';
import { ROCrate } from 'ro-crate';
import { config } from './configuration.ts';
import { logger } from './index.ts';
import type { CrateObject, Indexer } from './indexer/indexer.ts';
import { SearchIndexer } from './indexer/search.ts';
import { StructuralIndexer } from './indexer/structural.ts';
import { PromiseQueue } from './utils.ts';

const ocflConf = {
  ocflPath: process.env.OCFL_PATH || '/opt/storage/oni/ocfl',
  ocflPathInternal: '/ocfl',
  ocflScratch: process.env.OCFL_SCRATCH || '/opt/storage/oni/scratch-ocfl',
  ocflTestPath: '/opt/storage/oni/test/ocfl',
  ocflTestScratch: '/opt/storage/oni/test/scratch-ocfl',
  catalogFilename: 'ro-crate-metadata.json',
  hashAlgorithm: 'md5',
  create: {
    repoName: 'RAPID_COMMUNITY_DATA_LAB',
    collections: '../test-data/ingest-crate-list.development.json',
  },
  previewPath: '/opt/storage/oni/temp/ocfl/previews/',
  previewPathInternal: '/ocfl/previews',
};

const { defaultLicense, defaultMetadataLicense } = config;
const ocflPath = ocflConf.ocflPath;
const ocflPathInternal = 'ocfl';

let INDEXER: { [key: string]: Indexer };
let repository: ReturnType<typeof ocfl.storage>;

export async function init(opts: any) {
  logger.info('Initializing OCFL repository and indexers');
  INDEXER = {
    structural: await StructuralIndexer.create({
      defaultLicense,
      defaultMetadataLicense,
      ocflPath,
      ocflPathInternal,
    }),
    search: await SearchIndexer.create({
      defaultLicense,
      defaultMetadataLicense,
      searchSettings: config.search,
      client: opts.opensearchClient,
    }),
  };
  repository = ocfl.storage({
    root: ocflConf.ocflPath,
    workspace: ocflConf.ocflScratch,
    ocflVersion: '1.1',
    fixityAlgorithms: ['crc32'],
    layout: {
      extensionName: '000N-path-direct-storage-layout',
    },
  });
  try {
    await repository.load();
  } catch (e) {
    logger.error('=======================================');
    logger.error('Repository Error: please check your OCFL');
    logger.error((e as Error).message);
    logger.error(JSON.stringify(ocflConf));
    logger.error('=======================================');
    throw e;
  }
}

function wrap(ocflObject: OcflObject): CrateObject {
  return {
    root: ocflObject.root,
    async text(path: string) {
      return await ocflObject.getFile({ logicalPath: path }).text();
    },
    async file(path: string) {
      const file = ocflObject.getFile({ logicalPath: path });
      // getFile returns undefined when the path is not a logical entry (e.g. external URLs).
      if (!file) return { size: undefined as unknown as number, crc32: '' };
      const knownCrc32 = file.fixity?.crc32;
      const knownSize = file.size ?? file.fixity?.size;
      // Fast path: both values present in the inventory/fixity block.
      if (knownSize != null && knownCrc32) {
        return { size: Number(knownSize), crc32: knownCrc32 };
      }
      // Fallback: read content once, derive whichever value is missing.
      const buf: Buffer = await file.buffer();
      const size = knownSize != null ? Number(knownSize) : buf.length;
      let crc32hex = knownCrc32;
      if (!crc32hex) {
        // Fresh hasher per call so concurrent indexer tasks don't interleave.
        const c = await createCRC32();
        c.init();
        c.update(buf);
        crc32hex = c.digest('hex');
      }
      return { size, crc32: crc32hex };
    }
  };
}

export async function getIndexerState(_crateId?: string, _typee?: string) {
  return {
    isIndexed: false,
    isIndexing: false,
    isDeleting: false,
  };
}

async function indexObject(ocflObject: OcflObject, types: string[], force?: boolean) {
  if (!ocflObject) return;
  try {
    await ocflObject.load();
    logger.debug(`Found OFCL object: ${ocflObject.id}`);
    const jsonContent = await ocflObject.getFile({ logicalPath: 'ro-crate-metadata.json' }).text();
    const rawCrate = JSON.parse(jsonContent);
    const crate = await ROCrate.create(rawCrate);
    for (const t of types) {
      const indexer = INDEXER[t];
      if (indexer) {
        try {
          if (force) await indexer.delete(crate.rootId);
          const crateObject = wrap(ocflObject);
          await indexer.index({ crateObject, crate });
          // counts[t]++;
        } catch (error) {
          logger.error(error);
        }
      }
    }
  } catch (e) {
    logger.error(e);
  }
}

export async function createIndex(crateId?: string | RegExp, type?: string, force?: boolean) {
  logger.debug('Indexing started');
  const types = type ? [type] : ['structural', 'search'];
  if (typeof crateId === 'string') {
    await indexObject(repository.object(crateId), types, force);
  } else {
    // process IO in parallel
    const fn =
      crateId instanceof RegExp
        ? // if crateId is specified, index just the object and the subcollections and child objects
        // by checking just the structure implied in the crate id
        async (ocflObject: unknown) =>
          (await ocflObject.getInventory())?.id.match(crateId) ? indexObject(ocflObject, types, force) : undefined
        : // otherwise, index everything
        async (ocflObject: unknown) => indexObject(ocflObject, types, force);
    const pq = new PromiseQueue(4, fn);
    for await (const ocflObject of repository) {
      await pq.enqueue(ocflObject);
    }
    await pq.done();
  }
  logger.debug('Indexing finished');
}

export async function deleteIndex(crateId?: string, type?: string | string[]) {
  const indexers = type
    ? ([] as string[])
      .concat(type)
      .map((t) => INDEXER[t])
      .filter((i) => !!i)
    : Object.values(INDEXER);
  await Promise.allSettled(indexers.map((indexer) => indexer.delete(crateId)));
}

export async function* objects(_base: string) {
  //TODO: implement listing only top-level collections
  for await (const ocflObject of repository) {
    try {
      const inv = await ocflObject.getInventory();
      const jsonContent = await ocflObject.getFile({ logicalPath: 'ro-crate-metadata.json' }).text();
      const jsonParsed = JSON.parse(jsonContent);
      const name = jsonParsed['@graph'].find((e: any) => e['@id'] === inv.id)?.name?.toString();
      yield { id: inv.id, name, path: ocflObject.root };
    } catch (error) {
      logger.error(error);
    }
  }
}

export async function getFile(entityId: string, storagePath: string) {
  const crateId = (storagePath && entityId.endsWith('/' + storagePath)) ? entityId.slice(0, -storagePath.length - 1) : entityId;
  try {
    const object = repository.object(crateId);
    await object.load();
    const file = object.getFile({ logicalPath: storagePath });
    return {
      path: repository.objectRoot(crateId) + '/' + file.contentPath,
      stream: async () => file.stream(),
    };
  } catch (error) {
    logger.error(error);
  }
}
