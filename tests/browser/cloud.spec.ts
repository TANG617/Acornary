import { test, expect } from '@playwright/test';
test('cloud login, private records and logout', async ({ page }) => {
  test.skip(!process.env.ACORNARY_E2E_CLOUD, 'Cloud-only access boundary');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Acornary 登录' })).toBeVisible();
  expect((await page.request.get('/api/context')).status()).toBe(401);
  await page.getByLabel('邮箱').fill('browser@example.test');
  await page.getByLabel('密码').fill('Browser-test-password-123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'CatalogNode 目录树' })).toBeVisible();
  expect((await page.request.get('/api/context')).status()).toBe(200);
  expect((await page.request.post('/api/read/create_items', { data: {} })).status()).toBe(404);
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: 'Acornary 登录' })).toBeVisible();
  expect((await page.request.get('/api/context')).status()).toBe(401);
});
