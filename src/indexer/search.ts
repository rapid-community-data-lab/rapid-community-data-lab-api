import { Client } from '@opensearch-project/opensearch';
import type {
  Bulk_RequestBody,
  Search_Request,
  Search_RequestBody,
} from '@opensearch-project/opensearch/api/index.d.ts';
import type { ROCrate } from 'ro-crate';
import { config } from '../configuration.ts';
import { logger } from '../index.ts';
import { PromiseQueue, firstStringOrId } from '../utils.ts';
import type { CrateObject } from './indexer.ts';
import { Indexer, RecordType } from './indexer.ts';
import { dataTypeMapper, mapDefaultProperties, propertyMapper } from './search_mapper.ts';

/**
 * Notes:
 * Index properties:
 * - id must exists and be the same as the id used in postgres
 */
type searchParams = {
  index?: string;
  searchBody: Search_RequestBody;
  filterPath?: string | string[];
  explain?: boolean;
};

function isTransientPressure(error: any) {
  const status = error?.meta?.statusCode;
  const type = error?.meta?.body?.error?.type || error?.meta?.body?.error?.root_cause?.[0]?.type;
  return status === 429 || type === 'circuit_breaking_exception' || type === 'es_rejected_execution_exception';
}

async function withBackoff<T>(label: string, run: () => Promise<T>): Promise<T> {
  const { retryAttempts, retryDelayMs } = config.search;
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      attempt++;
      if (attempt > retryAttempts || !isTransientPressure(error)) throw error;
      const delay = retryDelayMs * 2 ** (attempt - 1);
      logger.warn(`[search] ${label}: search cluster under pressure, retry ${attempt}/${retryAttempts} in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function isText(entity: Record<string, any>) {
  return entity.encodingFormat?.some((ef: any) => typeof ef === 'string' && ef.startsWith('text/'));
}

function isFile(entity: Record<string, any>) {
  return entity['@type']?.includes('File');
}

function findExtractedTextPath(entity: Record<string, any>) {
  for (const property of config.extractedTextProperties) {
    for (const value of entity[property] || []) {
      const id = value?.['@id'];
      if (!id) continue;
      if (value.encodingFormat?.length && !isText(value)) continue;
      return id as string;
    }
  }
  return undefined;
}

type MapperParams = {
  properties?: Record<string, any>;
  entity: Record<string, any>;
  record: Record<string, any>;
  crate: ROCrate;
  crateObject?: CrateObject;
  /** An entity queue to be indexed one-by-one separately */
  deferredEntities?: Record<string, any>[];
};

/** The function mapped here may return an array of entities to be processed in batch  */
const typeMapper: Record<string, (params: MapperParams) => Record<string, any>> = Object.fromEntries(
  Object.entries(RecordType).map(([k, _v]) => [k, ({ record }) => record]),
);

const batchedTypeIndexer: Record<string, (params: MapperParams) => Promise<Record<string, any>>> = {
  File: async function ({ entity, record, crate, crateObject }) {
    //todo: check licence if it allows indexing content
    const entityId = entity['@id'];
    const textPath = isText(entity) ? entityId : findExtractedTextPath(entity);
    if (textPath) {
      try {
        record._text = (await crateObject?.text(textPath)) || '';
        logger.info(`[search] Indexing File: ${entityId} (text: ${textPath})`);
      } catch (e) {
        logger.error(`[search] Cannot read file: ${textPath}`);
        logger.error(e);
        record._error = 'file_not_found';
      }
    }
    return record;
  },
};

export class SearchIndexer extends Indexer {
  conf;
  client: Client;
  propertyMapper = { ...propertyMapper };
  //  conformsTo;
  constructor(opt: any) {
    super(opt);
    this.conf = opt.searchSettings;
    this.client = opt.client || new Client({ node: process.env.OPENSEARCH_URL });
    // this.conformsTo = {
    //   [configuration.api.conformsTo.collection]: mapCollection,
    //   [configuration.api.conformsTo.object]: mapObject
    //};
    const { properties } = this.conf.create.mappings;
    for (const name in properties) {
      const mapper = dataTypeMapper[properties[name].type];
      if (mapper && !this.propertyMapper[name]) {
        this.propertyMapper[name] = mapper;
      }
    }
  }

  async init() {
    logger.debug('Configure OpenSearch Cluster');
    try {
      const elastic = this.conf;
      await this.client.cluster.putSettings({ body: elastic.cluster });
      if (elastic?.log === 'debug') {
        const config = await this.client.cluster.getSettings();
        logger.debug('Current cluster setting: ' + JSON.stringify(config));
      }
    } catch (e) {
      logger.error('configureCluster');
      logger.error(e);
    }
  }

  async delete(crateId?: string) {
    try {
      if (crateId) {
        await this.client.deleteByQuery({
          index: this.conf.entityIndex,
          body: { query: { prefix: { rocrateRootId: { value: crateId } } } },
        });
      } else {
        await this.client.indices.delete({ index: this.conf.entityIndex });
      }
      logger.debug(`[search] Index ${crateId || '<all>'} deleted`);
    } catch (error) {
      if ((error as any).meta?.statusCode !== 404) {
        logger.error(error);
      }
    }
  }

  async count() {
    try {
      const res = await this.client.count({ index: this.conf.entityIndex });
      return res.body.count;
    } catch (e) {
      logger.error(e);
    }
    return 0;
  }

  async _index({ crateObject, crate, license, metadataLicense }: Parameters<Indexer['_index']>[0]) {
    // create indices if not exists
    const elastic = this.conf;
    try {
      await this.client.indices.create({
        index: elastic.entityIndex,
        body: elastic.create,
      });
      // await this.client.indices.putSettings({
      //   index: elastic.entityIndex,
      //   body: elastic.index
      // });
    } catch (error) {
      //logger.debug('search index already exists, ignore');
      if ((error as any).meta?.statusCode !== 400) {
        logger.debug(error);
      }
    }
    const { properties } = elastic.create.mappings;
    const operations: Bulk_RequestBody = [];
    const deferredEntities: any[] = []; // for individual updates
    const deriveId = (entityId: string) => this.deriveUniqueEntityId(crate.rootId, entityId);

    for (const entity of crate.entities()) {
      const entityTypes: string[] = entity['@type'];
      const matchedMappers = entityTypes.map((t) => !RecordType[t] || entity.conformsTo?.find(c => c['@id'] === RecordType[t]) ? typeMapper[t] : undefined).filter((fn) => !!fn);
      if (matchedMappers.length) {
        // create common index record
        const _id = deriveId(entity['@id']);
        // const license = resolveLicense(entity.license || parent?.license, crate, this.defaultLicense);
        // if (!license) {
        //   logger.error(`Skip indexing ${crateId} > ${entityId}, No License Found`);
        //   return;
        // }
        // const metadataLicense = resolveMetadataLicense(crate, this.defaultMetadataLicense);
        // doc._metadataIsPublic = metadataLicense?.metadataIsPublic;
        // doc._metadataLicense = metadataLicense;
        let record = createDoc(crate, entity, _id, license, metadataLicense, deferredEntities, this.propertyMapper);
        logger.debug(`[structural] Adding ${_id}`);
        // add additional information to record based on type
        for (const mapType of matchedMappers) {
          record = mapType({ properties, entity, record, crate, crateObject });
        }
        //console.log(record);
        if (isFile(entity) && findExtractedTextPath(entity)) {
          deferredEntities.push(entity);
        }
        operations.push({ update: { _index: elastic.entityIndex, _id } }, { doc: record, doc_as_upsert: true });
      }
    }
    try {
      const batchSize = elastic.bulkBatchSize * 2;
      while (operations.length) {
        const batch = operations.splice(0, batchSize);
        const result = await withBackoff('bulk', () => this.client.bulk({
          body: batch,
          refresh: false,
        }));
        if (result.body.errors) {
          logger.error(`[search] Bulk operation result errors:`);
          const items = result.body.items.filter((item) => item.update.error).map((item) => item.update.error?.reason);
          logger.error(items.join('\n'));
        }
      }
      await this.client.indices.refresh({ index: elastic.entityIndex });
      // index bigger data such as file content in a separate step to manage payload size
      const pq = new PromiseQueue(elastic.textIndexConcurrency, async (entity) => {
        try {
          const entityTypes: string[] = entity['@type'];
          const matchedIndexers = entityTypes.map((t) => batchedTypeIndexer[t]).filter((fn) => !!fn);
          let doc = {};
          for (const mapper of matchedIndexers) {
            doc = await mapper({ properties, entity, record: doc, crate, crateObject });
          }
          //console.log(doc);
          const result = await withBackoff(entity['@id'], () => this.client.update({
            index: elastic.entityIndex,
            id: deriveId(entity['@id']),
            body: { doc, doc_as_upsert: true },
          }));
          logger.debug(
            `[search] Batched operation result: ${result.body._id} ${result.body.result} ${result.statusCode}`,
          );
        } catch (error) {
          logger.error(`[search] Failed to index content of ${entity['@id']}`);
          logger.error(error);
        }
      });
      for (const entity of deferredEntities) {
        await pq.enqueue(entity);
      }
      await pq.done();
      await this.client.indices.refresh({ index: elastic.entityIndex });
    } catch (error) {
      logger.error('Error indexing ' + crate.rootId);
      logger.error(error);
    }
  }

  async search({ index = this.conf.entityIndex, searchBody, filterPath, explain }: searchParams) {
    try {
      logger.debug('----- searchBody ----');
      logger.debug(JSON.stringify(searchBody));
      logger.debug('----- searchBody ----');
      const opts: Search_Request = {
        index,
        body: searchBody,
        explain: explain,
      };
      if (filterPath) {
        opts.filter_path = filterPath;
      }
      logger.debug(JSON.stringify(opts));
      const result = await this.client.search(opts);
      return result.body;
    } catch (e) {
      logger.error(e);
      throw e;
    }
  }
}

/** Create entity basic record for bulk indexing */
function createDoc(
  crate: ROCrate,
  entity: Record<string, any>,
  _id: string,
  license: string,
  metadataLicense: string,
  deferredEntities: any[],
  propMapper: typeof propertyMapper = {},
) {
  const record: Record<string, any> = {
    rocrateRootId: crate.rootId, // The id of the entity that represent the original rocrate in the repository
    id: _id, // Prefixed entity id because each entity is being splited up logically into a separate rocrate doc
    entityId: entity['@id'], // Original entity id
    entityType: entity['@type'].map((t: string) => crate.getContextDefinition(t)),
    //entityType: entity['@type'].map((t:string) => RecordType[t as keyof typeof RecordType]),
    //memberOf: entity['pcdm:memberOf'] || entity.memberOf,
    rootCollection: crate.rootId,
    metadataLicenseId: metadataLicense,
    contentLicenseId: firstStringOrId(entity.license) || license,
    '@id': entity['@id'],
  };
  //handle inverse relations
  crate.addValues(entity, 'isPartOf', entity['@reverse'].hasPart);
  crate.addValues(entity, 'hasPart', entity['@reverse'].isPartOf);
  crate.addValues(entity, 'pcdm:memberOf', entity['@reverse']['pcdm:hasMember']);
  crate.addValues(entity, 'pcdm:hasMember', entity['@reverse']['pcdm:memberOf']);

  for (const propName in entity) {
    if (record[propName] == null && entity[propName] != null && entity[propName].length) {
      //console.log(propName, entity[propName]);
      const pm = propMapper[propName] || mapDefaultProperties;
      const values = [];
      for (const value of entity[propName]) {
        const properties = {};
        const res = pm(value, { deferredEntities, properties });
        for (const name in properties) {
          const vals = properties[name];
          if (vals == null) continue;
          if (record[name] == null) {
            record[name] = vals;
          } else {
            if (!Array.isArray(record[name])) record[name] = [record[name]];
            for (const v of vals) record[name].push(v);
          }
        }
        if (res != null) values.push(res);
      }
      if (values.length) record[propName] = values;
      //console.log(propName, record[propName]);
    }
  }

  return record;
}

/**
 * Find the license of an item with its id if not and id or undefined return a default license from
 * config, if passed an Id and not found it will also return a default license.
 */
function _resolveLicense(licenses: any[], crate: ROCrate, defaultLicense: any) {
  for (const license of licenses || []) {
    const id = typeof license === 'string' ? license : license['@id'];
    const entity = crate.getEntity(id);
    if (entity) {
      return entity;
    }
    logger.warn(`Invalid license: ${id}`);
  }
  return defaultLicense;
}

function _resolveMetadataLicense(crate, defaultMetadataLicense) {
  const metadataDescriptorLicense = crate.getEntity('ro-crate-metadata.json')?.license || [];
  const license = metadataDescriptorLicense[0];
  if (license) {
    return {
      metadataIsPublic: license.metadataIsPublic?.[0] || false,
      name: license.name?.[0],
      id: license['@id'],
      description: license.description?.[0],
    };
  } else {
    //default to cc-by-4
    return defaultMetadataLicense;
  }
}
