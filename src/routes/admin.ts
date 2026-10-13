import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import jwt from 'jsonwebtoken';
import { z } from 'zod/v4';
//import { getIndexerState, createIndex, deleteIndex } from '../ocfl.ts';
import { config } from '../configuration.ts';
import type { Repository } from '../repository.ts';

type AdminRole = 'ADMIN' | 'SUPER_ADMIN';

type AdminToken = jwt.JwtPayload & {
  id: string | number;
  email: string;
  role: AdminRole;
};

const isAdminRole = (role: unknown): role is AdminRole =>
  role === 'ADMIN' || role === 'SUPER_ADMIN';

export function verifyAdminToken(authorization: string | undefined): AdminToken | null {
  if (!config.apiAuthJwtSecret || !authorization?.startsWith('Bearer ')) {
    return null;
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) return null;

  try {
    const payload = jwt.verify(token, config.apiAuthJwtSecret, {
      algorithms: ['HS256']
    });

    if (typeof payload !== 'object' || !payload || !isAdminRole(payload.role)) {
      return null;
    }

    return payload as AdminToken;
  } catch {
    return null;
  }
}

export const admin: FastifyPluginAsync<{ prefix: string; repository: Repository }> = async (fastify, opts) => {
  //console.log(opts);
  const repo = opts.repository;
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', async (request, reply) => {
    if (!verifyAdminToken(request.headers.authorization)) {
      return reply.status(401).send({ message: 'Invalid or missing authentication token.' });
    }
  });

  app.get('/repository/', async (request, reply) => reply.redirect('../repository', 301));
  app.get('/repository', async (request, reply) => {
    const objects = [];
    for await (const repoObject of repo.objects()) {
      objects.push(repoObject);
    }
    return reply.send(objects);
  });

  app.get('/index/:crateId?', {
    schema: {
      summary: 'Get the state of the indexes for a given crate or all crates if no crateId is specified.',
      params: z.object({
        crateId: z.string().optional()
      })
    }
  }, async (request, reply) => {
    const { crateId } = request.params;
    const state = await repo.getIndexerState(crateId);
    return reply.send({ structural: [], opensearch: [] });
  });

  app.post('/index', async (request, reply) => reply.redirect('index/', 301));
  app.post('/index/:crateId/:type?',
    {
      schema: {
        summary: 'Index all creates or a specified crate from the OCFL repository.',
        description: 'If the index already exists, it will not be re-indexed unless the "force" query parameter is set to true.',
        params: z.object({
          crateId: z.string().optional(),
          type: z.string().optional(),
        }),
        querystring: z.object({ force: z.string().optional() })
      }
    }, async (request, reply) => {
      const { type, crateId } = request.params;
      const force = request.query.force != null;
      const state = await repo.getIndexerState(crateId, type);
      if (state) {
        try {
          if (state.isIndexed && !crateId && !force) {
            throw fastify.httpErrors.conflict('Index already exists, no changes has been made.');
          } else if (state.isDeleting) {
            throw fastify.httpErrors.conflict('Deleting is in progress.');
          }
          if (!state.isIndexing) {
            repo.createIndex(crateId ? new RegExp('^' + crateId) : undefined, type, force);
          }
          return reply.status(202).send(state);
        } catch (e) {
          const err = e as Error;
          app.log.error(err);
          return fastify.httpErrors.internalServerError({ message: `Error indexing [${type}] ${err.message}`, stack: err.stack });
        }
      } else {
        throw fastify.httpErrors.notFound('Indexer does not exist');
      }
    }
  );

  const deleteConfig = {
    config: {
      cors: {
        methods: ['GET', 'HEAD', 'POST', 'DELETE'], // Allow all origins for this route
      },
    }
  };
  app.delete('/index', deleteConfig, async (request, reply) => reply.redirect('index/*', 301));
  app.delete('/index/:crateId/:type?', {
    config: deleteConfig.config,
    schema: {
      summary: 'Delete the index of all creates or a specified crate.',
      params: z.object({
        crateId: z.string().optional(),
        type: z.string().optional(),
      })
    }
  }, async (request, reply) => {
    let { crateId, type } = request.params;
    if (crateId === 'all' || crateId === '*') crateId = undefined;
    repo.deleteIndex(crateId, type);
    return reply.send({ message: 'Deleting' });
  });

};
