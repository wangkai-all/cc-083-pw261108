// 演示种子数据：在浏览器控制台执行
//   import('/src/ui/seed.js').then(m => m.seedDemo())
// 或在地址栏进入应用后，通过本模块导出的 seedDemo() 写入一套完整示例。

import { registry } from './state.js';
import { notify } from './state.js';

const ORDER_V1 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OrderEvent',
  type: 'object',
  additionalProperties: false,
  required: ['orderId', 'amount', 'status'],
  properties: {
    orderId: { type: 'string', description: '订单号' },
    amount: { type: 'number' },
    status: { type: 'string', enum: ['CREATED', 'PAID', 'CANCELLED'] },
    currency: { type: 'string', default: 'CNY' },
    remark: { type: ['string', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sku', 'qty'],
        properties: {
          sku: { type: 'string' },
          qty: { type: 'integer' },
          price: { type: 'number' }
        }
      }
    }
  }
};

const ORDER_V2 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OrderEvent',
  type: 'object',
  additionalProperties: false,
  required: ['orderNo', 'amount', 'status', 'channel'],
  properties: {
    orderNo: { type: 'string', 'x-aliases': ['orderId'] },
    amount: { type: 'number' },
    status: { type: 'string', enum: ['CREATED', 'PAID', 'CANCELLED', 'REFUNDED'] },
    currency: { type: 'string', default: 'USD' },
    remark: { type: 'string' },
    channel: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sku', 'qty'],
        properties: {
          sku: { type: 'string' },
          qty: { type: 'integer' },
          price: { type: 'integer' }
        }
      }
    }
  }
};

const BROKEN = { type: 'record', name: 'Broken', fields: [{ name: 'id' }] };

export async function seedDemo() {
  const ds = registry.createDataset({
    name: '订单事件 OrderEvent（演示）',
    owner: 'data-platform',
    description: '演示数据集：包含两个可比较版本与一个解析失败的未评估版本。'
  });
  const v1 = await registry.importDefinition({
    datasetId: ds.id, version: '1.0.0', fileName: 'order.v1.json',
    text: JSON.stringify(ORDER_V1, null, 2)
  });
  const v2 = await registry.importDefinition({
    datasetId: ds.id, version: '1.1.0', fileName: 'order.v2.json',
    text: JSON.stringify(ORDER_V2, null, 2)
  });
  await registry.importDefinition({
    datasetId: ds.id, version: '0.9.0-broken', fileName: 'broken.avro.json',
    text: JSON.stringify(BROKEN, null, 2)
  });
  registry.publishVersion(ds.id, v1.version.id);
  registry.publishVersion(ds.id, v2.version.id);
  notify();
  return { datasetId: ds.id, v1: v1.version.id, v2: v2.version.id };
}
