import { OpensearchQueryBuilder } from 'arocapi';

const NAME_BOOST = 8;
const DESCRIPTION_BOOST = 4;
const NAME_PHRASE_BOOST = 12;
const TEXT_PHRASE_BOOST = 6;
const TEXT_TERMS_BOOST = 2;

export const hasSearchTerms = (query: string) => /[\p{L}\p{N}]/u.test(query);

export class FullTextQueryBuilder extends OpensearchQueryBuilder {
  override buildQuery(...args: Parameters<OpensearchQueryBuilder['buildQuery']>) {
    const [searchType, query] = args;
    const built = super.buildQuery(...args);

    if (searchType === 'basic') {
      if (!hasSearchTerms(query)) {
        return built;
      }

      return {
        bool: {
          ...built.bool,
          must: [
            {
              bool: {
                should: [
                  { match_phrase: { _text: { query, boost: TEXT_PHRASE_BOOST } } },
                  { match: { _text: { query, operator: 'and' as const, boost: TEXT_TERMS_BOOST } } },
                ],
                minimum_should_match: 1,
              },
            },
          ],
          should: [
            {
              multi_match: {
                query,
                fields: [`name^${NAME_BOOST}`, `description^${DESCRIPTION_BOOST}`],
                type: 'best_fields' as const,
                fuzziness: 'AUTO',
              },
            },
            { match_phrase: { name: { query, boost: NAME_PHRASE_BOOST } } },
          ],
        },
      };
    }

    built.bool.must = [
      {
        query_string: {
          query,
          fields: [`name^${NAME_BOOST}`, `description^${DESCRIPTION_BOOST}`, '_text'],
          default_operator: 'AND',
        },
      },
    ];

    return built;
  }
}
