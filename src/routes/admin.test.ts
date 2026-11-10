import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it } from 'vitest';

const sharedSecret = 'admin-and-lab-api-test-secret';
process.env.API_AUTH_JWT_SECRET = sharedSecret;
const { admin, verifyAdminToken } = await import('./admin.ts');
const makeToken = (role: 'ADMIN' | 'SUPER_ADMIN', secret = sharedSecret) =>
  jwt.sign(
    { id: 1, email: `${role.toLowerCase()}@example.com`, role },
    secret,
    { expiresIn: '1h' }
  );

/***
 *** Tests for the admin routes and JWT authentication.
 ***/
describe('admin JWT authentication', () => {
  beforeAll(() => {
    process.env.API_AUTH_JWT_SECRET = sharedSecret;
  });

  it.each(['ADMIN', 'SUPER_ADMIN'] as const)('accepts a %s token', (role) => {
    expect(verifyAdminToken(`Bearer ${makeToken(role)}`)?.role).toBe(role);
  });

  it('rejects a token signed with a different secret', () => {
    const token = makeToken('ADMIN', 'a-different-secret');
    expect(verifyAdminToken(`Bearer ${token}`)).toBeNull();
  });

  it('rejects a token with an unsupported role', () => {
    const token = jwt.sign(
      { id: 1, email: 'user@example.com', role: 'USER' },
      sharedSecret
    );
    expect(verifyAdminToken(`Bearer ${token}`)).toBeNull();
  });

  it('protects admin routes with the same JWT', async () => {
    const repository = {
      async *objects() {},
      getIndexerState: async () => null,
      createIndex: () => undefined,
      deleteIndex: () => undefined,
    };
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(admin, { prefix: '/admin', repository });

    const unauthorized = await app.inject({
      method: 'GET',
      url: '/admin/repository'
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'GET',
      url: '/admin/repository',
      headers: { authorization: `Bearer ${makeToken('SUPER_ADMIN')}` }
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual([]);
  });
});
