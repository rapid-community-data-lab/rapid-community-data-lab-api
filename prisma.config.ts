import { env, loadEnvFile } from 'node:process';
import { PrismaPg } from '@prisma/adapter-pg';
import { defineConfig } from 'prisma/config';

try {
  const prefix = env.NODE_ENV ? `.${env.NODE_ENV}` : '';
  loadEnvFile(`./.env${prefix}`);
} catch (error) {
  if (!env.DATABASE_URL) {
    console.log(error);
    env.DATABASE_URL = 'postgresql://rapid_community_data_lab_api:bzGFj7D3SUKRASQHPvmhXQ==@localhost:5432/rapid-community-data-lab?schema=public';
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
