import { env, loadEnvFile } from 'node:process';
import { PrismaPg } from '@prisma/adapter-pg';
import { defineConfig } from 'prisma/config';

try {
  const prefix = env.NODE_ENV ? `.${env.NODE_ENV}` : '';
  loadEnvFile(`./.env${prefix}`);
} catch (error) {
  if (!env.DATABASE_URL) {
    console.log(error);
  }
}

export default defineConfig({
  schema: 'prisma',
  datasource: {
    url: env.DATABASE_URL || '',
  },
  migrations: {
    path: 'prisma/migrations',
    adapter: async () => new PrismaPg({ connectionString: env.DATABASE_URL || '' }),
  },
});
