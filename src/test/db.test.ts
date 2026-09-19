import { assert } from 'https://deno.land/std@0.221.0/assert/mod.ts';
import { sql } from 'npm:drizzle-orm';
import db from '../db/db.ts';
import { config } from '../db/schema.ts';
import { eq } from 'npm:drizzle-orm';

Deno.test('数据库连接测试', async () => {
  try {
    // 测试基础查询
    const result = await db.select().from(config).limit(1);
    console.log('基础查询结果:', result);
    assert(result.length > 0, '应能获取有效查询结果');
    assert(typeof result[0].id === 'string', '结果应包含有效字段');
    
    const testQuery = await db.select({ count: sql<number>`count(*)` }).from(config);
    console.log('计数查询结果:', testQuery);
    assert(testQuery.length > 0 && Number(testQuery[0].count) >= 0, '应能获取有效计数');
    
    console.log('\x1b[32m✓ 数据库连接测试通过\x1b[0m');
  } catch (error) {
    console.error('\x1b[31m× 数据库连接测试失败:\x1b[0m', error);
    throw error;
  }
});