import { test, expect } from '@playwright/test';
test('database rows, foreign keys, derived paths, APIs, notes and fixed registry views', async ({
  page,
}) => {
  const errors: string[] = [];
  const methods: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().includes('/api/')) {
      methods.push(r.method());
      expect(r.headers().authorization).toBeUndefined();
    }
  });
  page.on('dialog', () => {
    throw new Error('Unsafe note HTML');
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CatalogNode 目录树' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Item 容纳树' })).toBeVisible();
  await page.getByLabel('搜索名称').fill('牛奶');
  const rows = page.locator('main > .panel').first().locator('tbody tr');
  await expect(rows).toHaveCount(6);
  await page.getByLabel('生命周期过滤').selectOption('ACTIVE');
  await expect(rows).toHaveCount(0);
  await page.getByLabel('生命周期过滤').selectOption('');
  await page.getByLabel('到期日期上限').fill('2026-09-30');
  await expect(rows).toHaveCount(0);
  await page.getByLabel('到期日期上限').fill('2026-10-01');
  await page.getByLabel('查询条码').fill('TEST-MILK-1L');
  await expect(rows).toHaveCount(6);
  await rows.first().getByRole('button').click();
  const core = page.getByTestId('records-items');
  await expect(core).toBeVisible();
  await expect(core.locator('.record > .json pre')).toContainText('item_');
  await expect(core.locator('.record > .json pre')).not.toContainText('path_ids');
  await expect(core.locator('.record > .json pre')).toContainText('attributes');
  const response = await page.request.get(
    '/api/debug?input=' +
      encodeURIComponent(JSON.stringify({ view: 'system', table: 'items', limit: 200 })),
  );
  const db = (await response.json()).rows;
  const raw = JSON.parse((await core.locator('.record > .json pre').textContent())!);
  expect(raw).toEqual(db.find((r: any) => r.id === raw.id));
  const sets = page.getByTestId('embedded-attributes');
  await expect(sets.locator('.binding')).toHaveCount(2);
  for (const pre of await sets.locator('.binding pre').all()) {
    const binding = JSON.parse((await pre.textContent())!);
    expect(binding).not.toHaveProperty('id');
    expect(binding.created_at).toBeTruthy();
    expect(binding.updated_at).toBeTruthy();
    expect(raw.attributes).toContainEqual(binding);
  }
  const notes = page.getByTestId('records-notes');
  await expect(notes.locator('.record pre')).toContainText('已核对');
  await notes.getByText('Markdown 安全预览', { exact: true }).click();
  await expect(notes.locator('.note')).toContainText('800 mL');
  await expect(notes.locator('script')).toHaveCount(0);
  await expect(page.getByTestId('records-events')).toContainText('NOTE_UPDATE');
  await expect(page.getByTestId('records-operations')).toContainText('fingerprint_format');
  await page.screenshot({ path: 'output/playwright/database-records.png', fullPage: true });
  await page.getByRole('button', { name: '派生结果（非存储）', exact: true }).click();
  await expect(page.getByTestId('derived')).toContainText('path_ids');
  const derived = JSON.parse((await page.getByTestId('derived').locator('pre').textContent())!);
  expect(derived.path_ids).toHaveLength(3);
  expect(derived.path_ids.every((s: string) => s.startsWith('item_'))).toBe(true);
  await page.getByRole('button', { name: 'API 响应', exact: true }).click();
  await expect(page.getByTestId('api-response')).toContainText('attributes');
  expect(
    JSON.parse((await page.getByTestId('api-response').locator('pre').textContent())!),
  ).not.toHaveProperty('object_kind');
  const projection = JSON.parse(
    (await page.getByTestId('api-response').locator('pre').textContent())!,
  );
  for (const a of projection.attributes)
    expect(Object.keys(a).sort()).toEqual(['template_id', 'template_version', 'values']);
  await page.getByRole('button', { name: '数据库记录', exact: true }).click();
  await core
    .locator('.references button')
    .filter({ hasText: /^catalog_node_/ })
    .click();
  await expect(page.getByTestId('records-catalog_nodes')).toBeVisible();
  await page.getByRole('button', { name: '查看关联物品' }).click();
  await expect(rows).toHaveCount(6);
  await page
    .getByTestId('embedded-attributes')
    .locator('.references button')
    .filter({ hasText: 'product · v1' })
    .click();
  await expect(page.getByTestId('records-attribute_templates').locator('.record')).toHaveCount(1);
  await page.locator('nav button').filter({ hasText: '操作记录' }).click();
  const ops = page.getByTestId('records-operations');
  await expect(ops.locator('.record')).toHaveCount(10);
  await ops.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(ops).toContainText('第 2 页');
  await ops.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(ops).toContainText('第 1 页');
  await page.locator('nav button').filter({ hasText: '迁移信息' }).click();
  await expect(page.getByTestId('records-migrations')).toContainText('003_embed_attributes.sql');
  await page.screenshot({ path: 'output/playwright/inspector.png', fullPage: true });
  expect(new Set(methods)).toEqual(new Set(['GET']));
  expect(errors).toEqual([]);
  await expect(page.locator('button').filter({ hasText: /保存|删除|上传|入库/ })).toHaveCount(0);
});
test('polling, focus and manual refresh remain read-only', async ({ page }) => {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) seen.push(r.url());
  });
  await page.goto('/');
  await expect(page.getByTestId('records-households').locator('.record')).toHaveCount(1);
  await page.waitForLoadState('networkidle');
  const count = seen.length;
  await expect.poll(() => seen.length, { timeout: 8000 }).toBeGreaterThan(count);
  await page.waitForLoadState('networkidle');
  const after = seen.length;
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
  await expect.poll(() => seen.length, { timeout: 2000 }).toBeGreaterThan(after);
  await page.waitForLoadState('networkidle');
  const manual = seen.length;
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await expect.poll(() => seen.length, { timeout: 2000 }).toBeGreaterThan(manual);
});
