import { ROCrate } from 'ro-crate';
import { logger, prisma } from '../index.ts';
import { PromiseQueue, firstStringOrId } from '../utils.ts';
import { Indexer, RecordType } from './indexer.ts';

export class StructuralIndexer extends Indexer {
  ocflPath: string;
  ocflPathInternal: string;
  memberOfField: string;

  constructor(opt: any) {
    super(opt);
    this.ocflPath = opt.ocflPath;
    this.ocflPathInternal = opt.ocflPathInternal;
    this.memberOfField = opt.memberOfField || 'pcdm:memberOf';
  }

  override async _index({ crateObject, crate, license, metadataLicense }: Parameters<Indexer['_index']>[0]) {
    //await ocflObject.load();
    const crateId = crate.rootId;
    //console.log(`${crateId} license: ${lic}`);
    //const objectRoot = ocflObject.root;
    //logger.info(`[structural] Indexing ${crateId}`);
    let count = 0;
    const pq = new PromiseQueue(4, async (opt: any) => {
      for (const tableName in opt) {
        const data = opt[tableName];
        if (data) {
          // @ts-ignore
          await prisma[tableName].upsert({ where: { id: data.id }, create: data, update: data });
        }
      }
    });

    for (const entity of crate.entities()) {
      const entityType = entity['@type'].find((t) => t in RecordType); // only the first matching entity type is used
      if (!entityType) {
        continue;
      }
      const mustHaveConformsTo = RecordType[entityType as keyof typeof RecordType];
      if (mustHaveConformsTo) {
        const conformsTo = entity.conformsTo?.find((c) => c['@id'] === mustHaveConformsTo);
        if (!conformsTo) {
          continue;
        }
      }
      logger.debug(`[structural] Indexing ${crateId} ${entity['@id']}`);
      count++;
      const entityId = this.deriveUniqueEntityId(crateId, entity['@id']);
      const rocrate = entityAsCrate(crate, entity);
      const param = {
        entity: {
          id: entityId,
          name: entity.name?.join('; ') || entityId,
          description: entity.description?.join('; ') || '',
          entityType: crate.getContextDefinition(entityType) || RecordType[entityType as keyof typeof RecordType],
          memberOf: pickSingleMemberOf(entity),
          rootCollection: crate.rootId,
          metadataLicenseId: metadataLicense,
          contentLicenseId: firstStringOrId(entity.license) || license,
          meta: { rocrate },
        }
      };
      if (entityType.endsWith('://schema.org/MediaObject') || entityType === 'File') {
        const storagePath = entity['@id'];
        const f = await crateObject.file(storagePath);
        // contentSize from RO-Crate is typically a string (often wrapped in an array); Prisma expects BigInt.
        const rawSize = (Array.isArray(entity.contentSize) ? entity.contentSize[0] : entity.contentSize) ?? f.size ?? 0;
        const sizeBig = typeof rawSize === 'bigint' ? rawSize : BigInt(Math.max(0, Math.trunc(Number(rawSize)) || 0));
        /* @ts-ignore */
        param.file = {
          id: entityId,
          filename: storagePath.split('/').pop(),
          mediaType: entity.encodingFormat?.find(v => typeof v === 'string') || 'application/octet-stream',
          size: sizeBig,
          meta: {
            storagePath,
            crc32: f.crc32
          }
        };
      }
      await pq.enqueue(param);
    }
    await pq.done();
    // const relRoot = relative(this.ocflPath, objectRoot);
    // let count = 0;
    // for await (let f of await ocflObject.files()) {
    //   try {
    //     await File.create({
    //       path: join(relRoot, f.contentPath),
    //       logicalPath: f.logicalPath,
    //       crateId,
    //       size: f.size,
    //       crc32: hash,
    //       lastModified: f.lastModified
    //     });
    //     logger.debug(`[structural] [${rec.crateId}] Indexed file ${f.logicalPath}`);
    //     count++;
    //   } catch (error) {
    //     logger.error(error.message);
    //   }
    // }

    logger.info(`[structural] Indexed ${crateId}: entities=${count}`);
  }

  async delete(crateId?: string) {
    const where = crateId ? { id: { startsWith: crateId } } : {};
    //const truncate = !crateId;
    await prisma.file.deleteMany({ where });
    await prisma.entity.deleteMany({ where });
    logger.debug(`[structural] Index ${crateId || '<all>'} deleted`);
    //await File.destroy({ truncate, where });
  }

  async count(crateId?: string) {
    let opt;
    if (crateId) {
      opt = {
        where: { id: crateId },
      };
    }
    return await prisma.entity.count(opt);
  }
}

function entityAsCrate(crate: ROCrate, entity: any) {
  const newCrate = new ROCrate({ array: true, link: true });
  for (const key in entity) {
    newCrate.root[key] = entity[key];
  }
  newCrate.root['@type'].push('Dataset');
  if (!entity.conformsTo) {
    newCrate.root.conformsTo = crate.root.conformsTo;
  }
  return newCrate.toJSON();
}

function pickSingleMemberOf(entity: any) {
  return entity['pcdm:memberOf']?.[0]['@id'] ||
    entity.memberOf?.[0]['@id'] ||
    entity['@reverse']['pcdm:hasMember']?.[0]?.['@id'] ||
    entity['@reverse'].hasMember?.[0]?.['@id'] ||
    entity.isPartOf?.find((e) => e['@type'].includes('RepositoryObject'))?.['@id'] ||
    entity['@reverse'].hasPart?.find((e) => e['@type'].includes('RepositoryObject'))?.['@id'] ||
    entity.isPartOf?.[0]['@id'] ||
    entity['@reverse'].hasPart?.[0]?.['@id'] ||
    null;
}