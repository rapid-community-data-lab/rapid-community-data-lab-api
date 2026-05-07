//import config from '../prisma.config.ts';
import cors from '@fastify/cors';
import fastifyRoutes from '@fastify/routes';
import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from "@prisma/adapter-pg";
import type { Options } from 'arocapi';
import arocapi, { AllPublicAccessTransformer, AllPublicFileAccessTransformer } from 'arocapi';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import rapidCommunityDataLabApi, { fileHandler } from './app.ts';
import { config } from './configuration.ts';
import { PrismaClient } from './generated/prisma/client.ts';

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl })
});
const opensearch = new Client({ node: config.opensearchUrl });

const fastify = Fastify({
  //logger: { level: 'debug' },
  logger: {
    level: config.logLevel,
    ...(config.isDev && { transport: { target: 'pino-pretty' } }),
    // routerOptions: {
    //   ignoreTrailingSlash: true,
    // }
  }
});
export const logger = fastify.log;

const appOpt: Options = {
  prisma,
  opensearch,
  disableCors: true,
  queryBuilderOptions: { aggregations: config.search.aggregations },
  accessTransformer: AllPublicAccessTransformer,
  fileAccessTransformer: AllPublicFileAccessTransformer,
  entityTransformers: [
    (entity, { fastify }) => {
      entity.accessControl = 'Public';
      entity.counts = {
        collections: 0,
        objects: 0,
        files: 0
      }
      return entity;
    }
  ],
  fileHandler,
  // Required: RO-Crate handler for serving RO-Crate metadata
  roCrateHandler: {
    get: async (entity) => {
      const jsonString = JSON.stringify(entity.meta.rocrate, null, 2);
      return {
        type: 'stream' as 'stream',
        stream: Readable.from([jsonString]),
        metadata: {
          contentType: 'application/ld+json',
          contentLength: Buffer.byteLength(jsonString),
        },
      };
    },
    head: async (entity) => ({
      contentType: 'application/ld+json',
      contentLength: Buffer.byteLength(JSON.stringify(entity.meta.rocrate)),
    }),
  }
};

//fastify.register(fastifySensible);
fastify.register(cors, {
  methods: ['HEAD', 'GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});
fastify.register(fastifyRoutes);

// OS-only RO-Crate fallback.
fastify.addHook('preHandler', async (request, reply) => {
  const m = request.url.match(/^\/entity\/([^/?]+)\/rocrate(?:\?.*)?$/);
  if (!m) return;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;

  let id: string;
  try { id = decodeURIComponent(m[1]!); } catch { return; }

  try {
    const exists = await prisma.entity.findUnique({ where: { id }, select: { id: true } });
    if (exists) return;
  } catch {
    return;
  }

  let src: Record<string, unknown> | undefined;
  try {
    const osRes = (await opensearch.get({ index: config.search.entityIndex, id })) as {
      body?: { found?: boolean; _source?: Record<string, unknown> };
    };
    if (!osRes?.body?.found || !osRes.body._source) return;
    src = osRes.body._source;
  } catch {
    return;
  }

  const rocrate = buildMinimalROCrateFromOS(id, src);
  const json = JSON.stringify(rocrate, null, 2);
  reply.header('Content-Type', 'application/ld+json');
  reply.header('Content-Length', String(Buffer.byteLength(json)));
  if (request.method === 'HEAD') {
    return reply.code(200).send();
  }
  return reply.code(200).send(json);
});

fastify.register(arocapi, appOpt);
fastify.register(rapidCommunityDataLabApi, appOpt);

function buildMinimalROCrateFromOS(id: string, src: Record<string, unknown>) {
  const toArr = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const reservedRoot = new Set([
    '@id', '@type', 'rocrateRootId', 'id', 'entityId', 'entityType',
    'rootCollection', '_text',
  ]);

  const types = toArr((src as any)['@type']).map(String).filter(Boolean);
  const root: Record<string, unknown> = {
    '@id': './',
    '@type': Array.from(new Set(['Dataset', ...types])),
    name: toArr(src.name).map(String),
  };
  if (src.description != null) root.description = toArr(src.description).map(String);
  if (src.metadataLicenseId) {
    root.metadataLicense = [{ '@id': String(src.metadataLicenseId) }];
  }
  if (src.contentLicenseId) {
    root.license = [{ '@id': String(src.contentLicenseId) }];
  }
  root.identifier = [{ name: ['id'], value: [String(src.entityId ?? id)] }];

  for (const [k, v] of Object.entries(src)) {
    if (reservedRoot.has(k) || k in root || v == null) continue;
    root[k] = Array.isArray(v) ? v : [v];
  }

  return {
    '@context': 'https://w3id.org/ro/crate/1.1/context',
    '@graph': [
      {
        '@id': 'ro-crate-metadata.json',
        '@type': 'CreativeWork',
        conformsTo: { '@id': 'https://w3id.org/ro/crate/1.1' },
        about: { '@id': './' },
      },
      root,
    ],
  };
}

// Run the server!
(async function () {
  try {
    await fastify.ready();
    await fastify.listen({ port: config.port, host: process.env.HOST || '0.0.0.0' })
    if (config.isDev) {
      fastify.log.info(`Server is running on development mode`);
    }
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})();

