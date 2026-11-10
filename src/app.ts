import type { Client } from '@opensearch-project/opensearch';
import type { PrismaClient } from '@prisma/client/extension';
import type { AccessTransformer, EntityTransformer, FileHandler, FileMetadata } from 'arocapi';
import pkg from "../package.json" with { type: "json" };

import type { FastifyPluginAsync } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { File } from './generated/prisma/client.ts';
import { logger } from './index.ts';
import { initRepository, type Repository } from './repository.ts';
import { admin } from './routes/admin.ts';

// declare module 'fastify' {
//   interface FastifyInstance {
//     repository: Repository;
//   }
// }

export type LdacapiOptions = {
  prisma: PrismaClient;
  opensearch: Client;
  disableCors?: boolean;
  accessTransformer: AccessTransformer;
  entityTransformers?: EntityTransformer[];
};

let repository: Repository;

const ldacapi: FastifyPluginAsync<LdacapiOptions> = async (fastify, options: LdacapiOptions) => {
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
  repository = await initRepository('ocfl', { opensearchClient: options.opensearch });
  fastify.decorate('repository', repository);

  // Declare a route
  fastify.get('/', async function handler(request, reply) {
    const routes = fastify.routes.keys().toArray();
    return {
      about: 'Example implementation of mounting an ROCrate API in a fastify app',
      routes,
    };
  });

  const { version } = pkg;
  fastify.get('/version', async () => ({ version }));
  fastify.register(admin, { prefix: '/admin', repository });

};

export default ldacapi;

function fileMetadata(file: File): FileMetadata {
  return {
    contentType: file.mediaType,
    contentLength: file.size as unknown as number,
  };
}

export const fileHandler: FileHandler = {
  get: async (file, { request }) => {
    logger.debug(`Get object file`);
    logger.debug(file);
    const metadata = fileMetadata(file);
    const rf = await repository.getFile(file.id, file.meta.storagePath);
    //if (!rf) return fastify.httpErrors.notFound(`File not found: ${file.id}`);
    if (!rf) return false;
    if (request.headers.via?.includes('nginx')) {
      // try to auto-detect nginx proxy using `via` header
      // if detected, use the x-accel feature to let nginx serve the requested file directly
      const path = encodeURI('/ocfl/' + rf.path);
      return { type: 'file', metadata, path, accelPath: path };
    } else {
      return { type: 'stream', metadata, stream: await rf.stream() };
    }
  },
  head: async (file) => fileMetadata(file),
}
