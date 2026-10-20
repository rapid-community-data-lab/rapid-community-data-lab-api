import type { Client } from '@opensearch-project/opensearch';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { hasSearchTerms } from './query_builder.ts';

export const SNIPPET_FIELD = '_text';
export const SNIPPET_MAX_WORDS = 40;
export const SNIPPETS_PER_RESULT = 1;

const MARK_OPEN = '<mark>';
const MARK_CLOSE = '</mark>';

export const snippetHighlight = {
  pre_tags: [MARK_OPEN],
  post_tags: [MARK_CLOSE],
  encoder: 'html',
  fields: {
    [SNIPPET_FIELD]: {
      type: 'fvh',
      fragment_size: 300,
      number_of_fragments: SNIPPETS_PER_RESULT,
      order: 'score',
    },
  },
};

const RESULT_SOURCE_FIELDS = ['id'];

type SearchBody = { searchType?: string; query?: string };
type SearchEntity = { id: string; searchExtra?: { highlight?: Record<string, string[]> } };
type SearchResult = { total: number; entities: SearchEntity[] };
type Span = { start: number; end: number };

export function withSnippets(client: Client): Client {
  const search = (params: Parameters<Client['search']>[0], ...rest: unknown[]) =>
    (client.search as (...args: unknown[]) => unknown)(
      { ...params, body: { ...params?.body, highlight: snippetHighlight, _source: RESULT_SOURCE_FIELDS } },
      ...rest,
    );

  return new Proxy(client, {
    get: (target, property, receiver) => (property === 'search' ? search : Reflect.get(target, property, receiver)),
  });
}

const parseMarks = (fragment: string) => {
  const marks: Span[] = [];
  let text = '';
  let openedAt = -1;

  for (const part of fragment.split(/(<mark>|<\/mark>)/)) {
    if (part === MARK_OPEN) {
      const previous = marks.at(-1);
      if (previous && !text.slice(previous.end).trim()) {
        marks.pop();
        openedAt = previous.start;
      } else {
        openedAt = text.length;
      }
    } else if (part === MARK_CLOSE) {
      if (openedAt >= 0 && text.length > openedAt) marks.push({ start: openedAt, end: text.length });
      openedAt = -1;
    } else {
      text += part;
    }
  }

  return { text, marks };
};

export function condenseSnippet(fragment: string, maxWords = SNIPPET_MAX_WORDS) {
  const { text, marks } = parseMarks(fragment);
  const words: Span[] = [...text.matchAll(/\S+/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  if (!words.length) return '';

  const wordsInMark = (mark: Span) => words.filter((word) => word.start < mark.end && word.end > mark.start).length;
  const mark = marks.reduce<Span | undefined>(
    (best, candidate) => (wordsInMark(candidate) > (best ? wordsInMark(best) : 0) ? candidate : best),
    undefined,
  );

  let first = 0;
  let markFirst = -1;
  let markLast = -1;
  if (mark) {
    markFirst = words.findIndex((word) => word.end > mark.start);
    markLast = words.findLastIndex((word) => word.start < mark.end);
    const before = Math.max(0, Math.floor((maxWords - (markLast - markFirst + 1)) / 2));
    first = Math.max(0, Math.min(markFirst - before, words.length - maxWords));
  }
  const last = Math.min(words.length, first + maxWords) - 1;

  const markedFirst = Math.max(markFirst, first);
  const markedLast = Math.min(markLast, last);
  const opensAt = mark ? Math.max(mark.start, words[markedFirst].start) : -1;
  const closesAt = mark ? Math.min(mark.end, words[markedLast].end) : -1;

  return words
    .slice(first, last + 1)
    .map((word, offset) => {
      const index = first + offset;
      let value = text.slice(word.start, word.end);
      if (mark && index === markedLast) {
        const at = closesAt - word.start;
        value = value.slice(0, at) + MARK_CLOSE + value.slice(at);
      }
      if (mark && index === markedFirst) {
        const at = opensAt - word.start;
        value = value.slice(0, at) + MARK_OPEN + value.slice(at);
      }
      return value;
    })
    .join(' ');
}

const condenseHighlight = (entity: SearchEntity): SearchEntity => {
  const fragments = entity.searchExtra?.highlight?.[SNIPPET_FIELD];
  if (!fragments?.length) return entity;

  return {
    ...entity,
    searchExtra: {
      ...entity.searchExtra,
      highlight: {
        ...entity.searchExtra?.highlight,
        [SNIPPET_FIELD]: fragments
          .map((fragment) => condenseSnippet(fragment))
          .filter(Boolean)
          .slice(0, SNIPPETS_PER_RESULT),
      },
    },
  };
};

const isSearchResult = (result: unknown): result is SearchResult =>
  !!result && typeof result === 'object' && Array.isArray((result as SearchResult).entities);

export function applySnippetRules(result: SearchResult, body: SearchBody) {
  const snippetRequired = (body?.searchType ?? 'basic') === 'basic' && hasSearchTerms(body?.query ?? '');
  const entities = result.entities
    .filter((entity) => !snippetRequired || !!entity.searchExtra?.highlight?.[SNIPPET_FIELD]?.length)
    .map(condenseHighlight);

  return { ...result, total: Math.max(0, result.total - (result.entities.length - entities.length)), entities };
}

export function registerSnippetSearch(fastify: FastifyInstance) {
  fastify.addHook('onRoute', (route) => {
    if (route.url !== '/search' || route.method !== 'POST') return;

    const handler = route.handler as RouteHandlerMethod;
    route.handler = async function (request, reply) {
      const result = await handler.call(this, request, reply);
      return isSearchResult(result) ? applySnippetRules(result, request.body as SearchBody) : result;
    };
  });
}
