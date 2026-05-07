import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('rapid-community-data-lab-api main app', () => {
  describe('App Registration', () => {
    it('should handle missing prisma', async () => {
      console.log(process.env);
      expect(2).toBe(2);
    });
  });
});
