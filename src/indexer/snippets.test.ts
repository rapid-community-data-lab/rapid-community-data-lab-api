import type { Client } from '@opensearch-project/opensearch';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { FullTextQueryBuilder } from './query_builder.ts';
import { applySnippetRules, registerSnippetSearch, snippetHighlight, withSnippets } from './snippets.ts';

const builder = new FullTextQueryBuilder();

describe('FullTextQueryBuilder', () => {
  it('requires a document text match for basic keyword searches and keeps filters', () => {
    const built = builder.buildQuery('basic', 'Neville Bonner', { inLanguage: ['English'] }) as any;
    expect(built.bool.must).toEqual([
      {
        bool: {
          should: [
            { match_phrase: { _text: { query: 'Neville Bonner', boost: 6 } } },
            { match: { _text: { query: 'Neville Bonner', operator: 'and', boost: 2 } } },
          ],
          minimum_should_match: 1,
        },
      },
    ]);
    expect(built.bool.should).toHaveLength(2);
    expect(built.bool.filter).toEqual([{ terms: { inLanguage: ['English'] } }]);
  });

  it.each(['', '   ', '*'])('keeps the browse-all query when the keyword %j has no terms', (query) => {
    const built = builder.buildQuery('basic', query) as any;
    expect(built.bool.must[0].multi_match.zero_terms_query).toBe('all');
    expect(built.bool.should).toBeUndefined();
  });

  it('searches name, description and document text for advanced searches', () => {
    const built = builder.buildQuery('advanced', 'name: (law)') as any;
    expect(built.bool.must[0].query_string.fields).toEqual(['name^8', 'description^4', '_text']);
  });
});

describe('applySnippetRules', () => {
  const result = {
    total: 3,
    entities: [
      { id: 'a', searchExtra: { highlight: { _text: ['Mr <mark>Neville</mark> <mark>Bonner</mark>'] } } },
      { id: 'b', searchExtra: { highlight: { name: ['o-<mark>neill</mark>'] } } },
      { id: 'c', searchExtra: {} },
    ],
  };
  const sources = new Map([
    [
      'a',
      {
        id: 'a',
        isBasedOn: [
          { '@value': 'https://example.org/wp53.pdf' },
          { '@id': 'https://example.org/a' },
          'https://example.org/b',
        ],
      },
    ],
  ]);

  it('excludes basic keyword results without a document snippet and adds isBasedOn', () => {
    const applied = applySnippetRules(result, { searchType: 'basic', query: 'Neville Bonner' }, sources);
    expect(applied.total).toBe(1);
    expect(applied.entities.map((e) => e.id)).toEqual(['a']);
    expect((applied.entities[0] as any).isBasedOn).toEqual([
      'https://example.org/wp53.pdf',
      'https://example.org/a',
      'https://example.org/b',
    ]);
  });

  it('keeps every result for browse and advanced searches', () => {
    expect(applySnippetRules(result, { searchType: 'basic', query: '' }, sources).entities).toHaveLength(3);
    expect(applySnippetRules(result, { searchType: 'advanced', query: 'law' }, sources).entities).toHaveLength(3);
  });
});

describe('registerSnippetSearch', () => {
  const fakeClient = (calls: unknown[]) =>
    ({
      name: 'fake',
      search: async (params: unknown) => {
        calls.push(params);
        return {
          body: {
            hits: {
              hits: [
                {
                  _source: { id: 'a', isBasedOn: [{ '@value': 'https://example.org/wp53.pdf' }] },
                  highlight: { _text: ['<mark>Bonner</mark>'] },
                },
                { _source: { id: 'b' } },
              ],
            },
          },
        };
      },
    }) as unknown as Client;

  it('injects the snippet highlight and enriches the search route response', async () => {
    const calls: any[] = [];
    const client = withSnippets(fakeClient(calls));
    expect((client as any).name).toBe('fake');

    const fastify = Fastify();
    registerSnippetSearch(fastify);
    fastify.post('/search', async () => {
      const response = await client.search({ index: 'entities', body: { query: { match_all: {} } } });
      const hits = (response.body as any).hits.hits;
      return {
        total: hits.length,
        entities: hits.map((hit: any) => ({ id: hit._source.id, searchExtra: { highlight: hit.highlight } })),
      };
    });

    const response = await fastify.inject({ method: 'POST', url: '/search', payload: { query: 'Bonner' } });
    expect(calls[0].body).toEqual({
      query: { match_all: {} },
      highlight: snippetHighlight,
      _source: ['id', 'isBasedOn'],
    });
    expect(response.json()).toEqual({
      total: 1,
      entities: [
        {
          id: 'a',
          searchExtra: { highlight: { _text: ['<mark>Bonner</mark>'] } },
          isBasedOn: ['https://example.org/wp53.pdf'],
        },
      ],
    });
    await fastify.close();
  });
});
