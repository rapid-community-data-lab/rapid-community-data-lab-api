import { OpensearchQueryBuilder } from 'arocapi';

const NAME_BOOST = 8;
const DESCRIPTION_BOOST = 4;
const NAME_PHRASE_BOOST = 12;
const TEXT_PHRASE_BOOST = 6;
const TEXT_TERMS_BOOST = 2;

export class FullTextQueryBuilder extends OpensearchQueryBuilder {
  override buildQuery(...args: Parameters<OpensearchQueryBuilder['buildQuery']>) {
    const [searchType, query] = args;
    const built = super.buildQuery(...args);

    built.bool.must =
      searchType === 'basic'
        ? [
            {
              bool: {
                should: [
                  {
                    multi_match: {
                      query,
                      fields: [`name^${NAME_BOOST}`, `description^${DESCRIPTION_BOOST}`],
                      type: 'best_fields',
                      fuzziness: 'AUTO',
                      zero_terms_query: 'all',
                    },
                  },
                  { match_phrase: { name: { query, boost: NAME_PHRASE_BOOST } } },
                  { match_phrase: { _text: { query, boost: TEXT_PHRASE_BOOST } } },
                  { match: { _text: { query, operator: 'and', boost: TEXT_TERMS_BOOST } } },
                ],
                minimum_should_match: 1,
              },
            },
          ]
        : [
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
