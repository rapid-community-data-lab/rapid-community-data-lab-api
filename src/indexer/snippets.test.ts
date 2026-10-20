import type { Client } from '@opensearch-project/opensearch';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { FullTextQueryBuilder } from './query_builder.ts';
import {
  applySnippetRules,
  condenseSnippet,
  registerSnippetSearch,
  SNIPPET_MAX_WORDS,
  SNIPPETS_PER_RESULT,
  snippetHighlight,
  withSnippets,
} from './snippets.ts';

const receiptOfEvidence = (mark: string) =>
  `the proceedings, Judge McGuire invited Mr ${mark} AO, the then Chairman of the Indigenous Advisory Council, to act as an observer and assistant to the Court. Judge McGuire in the Court’s 1996-1997 Annual Report described the experience:721 ... Mr <mark>Bonner</mark>, at my suggestion spoke to the child and`;
const receiptOfEvidenceSnippet =
  'the proceedings, Judge McGuire invited Mr <mark>Neville Bonner</mark> AO, the then Chairman of the Indigenous Advisory Council, to act as an observer and assistant to the Court. Judge McGuire in the Court’s 1996-1997 Annual Report described the experience:721 ... Mr';

const wordCount = (snippet: string) =>
  snippet
    .replace(/<\/?mark>/g, '')
    .split(/\s+/)
    .filter(Boolean).length;
const markCount = (snippet: string) => (snippet.match(/<mark>/g) ?? []).length;
const filler = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');

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

describe('condenseSnippet', () => {
  it('keeps at most 40 words centred on a single highlighted keyword', () => {
    const fragment = `${filler('a', 60)} Mr <mark>Bonner</mark>, at my suggestion ${filler('b', 60)} <mark>Bonner</mark> end`;
    const snippet = condenseSnippet(fragment);
    expect(SNIPPET_MAX_WORDS).toBe(40);
    expect(wordCount(snippet)).toBe(40);
    expect(markCount(snippet)).toBe(1);
    expect(snippet).toContain('Mr <mark>Bonner</mark>, at my suggestion');
    expect(snippet.startsWith('a42 ')).toBe(true);
  });

  it('prefers the longest highlight and joins line-broken phrases', () => {
    const snippet = condenseSnippet(
      'Mr <mark>Bonner</mark> met Mr <mark>Neville\nBonner</mark> AO and Mr <mark>Bonner</mark>',
    );
    expect(snippet).toBe('Mr Bonner met Mr <mark>Neville Bonner</mark> AO and Mr Bonner');
  });

  it('joins highlighted words separated only by whitespace into one highlight', () => {
    expect(condenseSnippet('Mr <mark>Neville</mark>\n <mark>Bonner</mark>, <mark>Bonner</mark> AO')).toBe(
      'Mr <mark>Neville Bonner</mark>, Bonner AO',
    );
  });

  it.each([
    ['basic', '<mark>Neville Bonner</mark>'],
    ['advanced', '<mark>Neville</mark> <mark>Bonner</mark>'],
  ])('condenses the %s search fragment to the same single-highlight snippet', (_, mark) => {
    const snippet = condenseSnippet(receiptOfEvidence(mark));
    expect(snippet).toBe(receiptOfEvidenceSnippet);
    expect(markCount(snippet)).toBe(1);
  });

  it('keeps html entities intact and handles highlights at the edges', () => {
    expect(condenseSnippet('<mark>Drs</mark> S &amp; P Kershaw')).toBe('<mark>Drs</mark> S &amp; P Kershaw');
    const tail = condenseSnippet(`${filler('w', 80)} (<mark>Bonner</mark>)`);
    expect(wordCount(tail)).toBe(40);
    expect(tail.endsWith('(<mark>Bonner</mark>)')).toBe(true);
  });

  it('truncates fragments without a highlight and ignores empty ones', () => {
    expect(wordCount(condenseSnippet(filler('w', 55)))).toBe(40);
    expect(condenseSnippet(' \n ')).toBe('');
  });
});

describe('applySnippetRules', () => {
  const result: Parameters<typeof applySnippetRules>[0] = {
    total: 3,
    entities: [
      { id: 'a', searchExtra: { highlight: { _text: ['Mr <mark>Neville</mark> <mark>Bonner</mark>'] } } },
      { id: 'b', searchExtra: { highlight: { name: ['o-<mark>neill</mark>'] } } },
      { id: 'c', searchExtra: {} },
    ],
  };

  it('excludes basic keyword results without a document snippet and condenses snippets', () => {
    const applied = applySnippetRules(result, { searchType: 'basic', query: 'Neville Bonner' });
    expect(applied.total).toBe(1);
    expect(applied.entities.map((e) => e.id)).toEqual(['a']);
    expect(applied.entities[0]?.searchExtra?.highlight?._text).toEqual(['Mr <mark>Neville Bonner</mark>']);
    expect(applied.entities[0]).not.toHaveProperty('isBasedOn');
  });

  it('keeps only the top snippet for each result', () => {
    const applied = applySnippetRules(
      {
        total: 1,
        entities: [
          {
            id: 'a',
            searchExtra: {
              highlight: {
                _text: [' \n ', receiptOfEvidence('<mark>Neville Bonner</mark>'), 'Mr <mark>Bonner</mark> retired'],
              },
            },
          },
        ],
      },
      { searchType: 'advanced', query: '_text: (Neville Bonner)' },
    );
    expect(SNIPPETS_PER_RESULT).toBe(1);
    expect(snippetHighlight.fields._text.number_of_fragments).toBe(1);
    expect(applied.entities[0]?.searchExtra?.highlight?._text).toEqual([receiptOfEvidenceSnippet]);
  });

  it('keeps every result for browse and advanced searches', () => {
    expect(applySnippetRules(result, { searchType: 'basic', query: '' }).entities).toHaveLength(3);
    expect(applySnippetRules(result, { searchType: 'advanced', query: '_text: (law)' }).entities).toHaveLength(3);
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
                  _source: { id: 'a' },
                  highlight: {
                    _text: ['Mr <mark>Bonner</mark> and Mr <mark>Bonner</mark>', 'Mr <mark>Bonner</mark> AO'],
                  },
                },
                { _source: { id: 'b' } },
              ],
            },
          },
        };
      },
    }) as unknown as Client;

  it('injects the snippet highlight and condenses the search route response', async () => {
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
      _source: ['id'],
    });
    expect(response.json()).toEqual({
      total: 1,
      entities: [{ id: 'a', searchExtra: { highlight: { _text: ['Mr <mark>Bonner</mark> and Mr Bonner'] } } }],
    });
    await fastify.close();
  });
});
