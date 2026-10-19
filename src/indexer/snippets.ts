import { AsyncLocalStorage } from 'node:async_hooks';
import type { Client } from '@opensearch-project/opensearch';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { hasSearchTerms } from './query_builder.ts';

export const SNIPPET_FIELD = '_text';

export const snippetHighlight = {
  pre_tags: ['<mark>'],
  post_tags: ['</mark>'],
  encoder: 'html',
  fields: {
    [SNIPPET_FIELD]: {
      type: 'fvh',
      fragment_size: 300,
      number_of_fragments: 3,
      order: 'score',
    },
  },
};

const RESULT_SOURCE_FIELDS = ['id', 'isBasedOn'];

type SearchSource = { id?: string; isBasedOn?: unknown[] };
type SearchBody = { searchType?: string; query?: string };
type SearchEntity = { id: string; searchExtra?: { highlight?: Record<string, string[]> } };
type SearchResult = { total: number; entities: SearchEntity[] };
type SearchResponse = { body?: { hits?: { hits?: { _source?: SearchSource }[] } } };

const searchSources = new AsyncLocalStorage<Map<string, SearchSource>>();

export function withSnippets(client: Client): Client {
  const search = async (params: Parameters<Client['search']>[0], ...rest: unknown[]) => {
    const body = { ...params?.body, highlight: snippetHighlight, _source: RESULT_SOURCE_FIELDS };
    const response = await (client.search as (...args: unknown[]) => Promise<SearchResponse>)(
      { ...params, body },
      ...rest,
    );
    const sources = searchSources.getStore();
    for (const hit of response?.body?.hits?.hits ?? []) {
      if (sources && hit._source?.id) {
        sources.set(hit._source.id, hit._source);
      }
    }
    return response;
  };

  return new Proxy(client, {
    get: (target, property, receiver) => (property === 'search' ? search : Reflect.get(target, property, receiver)),
  });
}

const toUrlList = (values: unknown[] = []) =>
  values
    .map((value) => {
      if (typeof value === 'string') return value;
      const item = value as { '@value'?: unknown; '@id'?: unknown } | null;
      return item?.['@value'] ?? item?.['@id'];
    })
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

const isSearchResult = (result: unknown): result is SearchResult =>
  !!result && typeof result === 'object' && Array.isArray((result as SearchResult).entities);

export function applySnippetRules(result: SearchResult, body: SearchBody, sources: Map<string, SearchSource>) {
  const snippetRequired = (body?.searchType ?? 'basic') === 'basic' && hasSearchTerms(body?.query ?? '');
  const entities = result.entities
    .filter((entity) => !snippetRequired || !!entity.searchExtra?.highlight?.[SNIPPET_FIELD]?.length)
    .map((entity) => {
      const isBasedOn = toUrlList(sources.get(entity.id)?.isBasedOn);
      return isBasedOn.length ? { ...entity, isBasedOn } : entity;
    });

  return { ...result, total: Math.max(0, result.total - (result.entities.length - entities.length)), entities };
}

export function registerSnippetSearch(fastify: FastifyInstance) {
  fastify.addHook('onRoute', (route) => {
    if (route.url !== '/search' || route.method !== 'POST') return;

    const handler = route.handler as RouteHandlerMethod;
    route.handler = function (request, reply) {
      const sources = new Map<string, SearchSource>();
      return searchSources.run(sources, async () => {
        const result = await handler.call(this, request, reply);
        return isSearchResult(result) ? applySnippetRules(result, request.body as SearchBody, sources) : result;
      });
    };
  });
}
