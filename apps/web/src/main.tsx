import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
  focusManager,
} from '@tanstack/react-query';
import { createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import Markdown from 'react-markdown';
import './style.css';
type Target = { kind: 'ITEM' | 'CATALOG_NODE'; id: string };
type Destination =
  | { target: Target }
  | { table: string; id?: string; template_id?: string; template_version?: number };
const titles: Record<string, string> = {
  households: '家庭',
  actors: '操作者',
  catalog_nodes: '目录记录',
  items: '物品记录',
  attribute_templates: '模板定义',
  notes: '文字笔记',
  events: '事件历史',
  operations: '操作记录',
  barcode_index: '条码索引',
  installations: '初始化信息',
  migrations: '迁移信息',
};
const label = (o: any) => o.display_name ?? o.name ?? o.catalog_name ?? o.id;
const attr = (o: any, id: string) => o.attributes?.find((a: any) => a.template_id === id)?.values;
async function request(path: string, input: unknown) {
  const r = await fetch(`${path}?input=${encodeURIComponent(JSON.stringify(input))}`);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message ?? '读取失败');
  return data;
}
const api = (op: string, input: unknown = {}) => request(`/api/read/${op}`, input);
async function all(op: string, input: object = {}) {
  const data: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await api(op, { ...input, limit: 200, ...(cursor ? { cursor } : {}) });
    data.push(...r.data);
    cursor = r.next_cursor ?? undefined;
  } while (cursor);
  return data;
}
function Json({ value, label: caption = '完整 JSON' }: { value: unknown; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="json" open>
      <summary>
        {caption}
        <button
          onClick={(e) => {
            e.preventDefault();
            void navigator.clipboard
              .writeText(JSON.stringify(value, null, 2))
              .then(() => setCopied(true));
          }}
        >
          {copied ? '已复制' : '复制 JSON'}
        </button>
      </summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
function targetFor(id: string): Destination | undefined {
  if (id.startsWith('item_')) return { target: { kind: 'ITEM', id } };
  if (id.startsWith('catalog_node_')) return { target: { kind: 'CATALOG_NODE', id } };
  for (const [prefix, table] of [
    ['household_', 'households'],
    ['actor_', 'actors'],
    ['note_', 'notes'],
    ['event_', 'events'],
    ['operation_', 'operations'],
  ])
    if (id.startsWith(prefix)) return { table, id };
}
// Only known structural fields are links; free text and template values remain opaque.
function References({ row, go }: { row: any; go: (d: Destination) => void }) {
  const refs = new Set<string>();
  for (const key of [
    'id',
    'household_id',
    'actor_id',
    'created_by',
    'parent_id',
    'catalog_node_id',
    'container_catalog_id',
    'item_id',
    'target_id',
    'operation_id',
  ])
    if (typeof row[key] === 'string' && targetFor(row[key])) refs.add(row[key]);
  if (row.result) {
    if (row.result.operation_id) refs.add(row.result.operation_id);
    if (row.result.note_id) refs.add(row.result.note_id);
    for (const o of row.result.affected_objects ?? []) refs.add(o.id);
    for (const id of row.result.event_ids ?? []) refs.add(id);
  }
  return (
    <div className="references">
      <small>关联跳转</small>
      {[...refs].map((id) => (
        <button
          key={id}
          onClick={() => {
            const d = targetFor(id);
            if (d) go(d);
          }}
        >
          {id}
        </button>
      ))}
      {row.template_id && (
        <button
          onClick={() =>
            go({
              table: 'attribute_templates',
              template_id: row.template_id,
              template_version: row.template_version,
            })
          }
        >
          {row.template_id} · v{row.template_version}
        </button>
      )}
    </div>
  );
}
function Records({
  table,
  target,
  filter = {},
  go,
}: {
  table: string;
  target?: Target;
  filter?: object;
  go: (d: Destination) => void;
}) {
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const [limit, setLimit] = useState(10);
  const input = {
    view: target ? 'object' : 'system',
    table,
    ...(target ? { target } : {}),
    ...filter,
    limit,
    cursor: pages.at(-1),
  };
  const q = useQuery({ queryKey: ['debug', input], queryFn: () => request('/api/debug', input) });
  return (
    <section className="panel records" data-testid={`records-${table}`}>
      <div className="section-title">
        <h2>
          {titles[table]} <code>{table}</code>
        </h2>
        <span>PostgreSQL 行记录</span>
      </div>
      <p className="muted">to_jsonb(t) · 保留全部列、null 与 JSONB；不含关联拼装或计算字段。</p>
      {q.error && <p role="alert">{q.error.message}</p>}
      {q.isPending && <p>读取中…</p>}
      {q.data && (
        <>
          <details>
            <summary>列类型与约束 · {q.data.columns.length} 列</summary>
            <table>
              <thead>
                <tr>
                  <th>列名</th>
                  <th>类型 / 底层类型</th>
                  <th>允许 null</th>
                  <th>数据库默认值</th>
                </tr>
              </thead>
              <tbody>
                {q.data.columns.map((c: any) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td>
                      {c.data_type} / {c.udt_name}
                    </td>
                    <td>{c.is_nullable}</td>
                    <td>
                      <code>{c.column_default === null ? 'null' : c.column_default}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Json value={q.data.constraints} label="数据库约束与外键" />
          </details>
          <div className="pager">
            <span>
              共 {q.data.total_count} 条 · 第 {pages.length} 页
            </span>
            <label>
              每页{' '}
              <select
                aria-label={`${table} 每页条数`}
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setPages([undefined]);
                }}
              >
                {[10, 25, 50, 200].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <button disabled={pages.length === 1} onClick={() => setPages((p) => p.slice(0, -1))}>
              上一页
            </button>
            <button
              disabled={!q.data.next_cursor}
              onClick={() => setPages((p) => [...p, q.data.next_cursor])}
            >
              下一页
            </button>
          </div>
          {!q.data.rows.length && <p className="empty">无记录</p>}
          {q.data.rows.map((row: any, i: number) => (
            <article className="record" key={i}>
              <References row={row} go={go} />
              <Json value={row} label={`${table} · 行 ${(pages.length - 1) * limit + i + 1}`} />
              {(table === 'items' || table === 'catalog_nodes') && (
                <section data-testid="embedded-attributes">
                  <h3>内嵌属性 · {table}.attributes</h3>
                  <p>以下展开核心行中的实际 JSONB，包含绑定时间；模板定义独立保存。</p>
                  {row.attributes.length === 0 && <p>未记录属性绑定</p>}
                  {row.attributes.map((binding: any, index: number) => (
                    <div className="binding" key={index}>
                      <References row={binding} go={go} />
                      <Json
                        value={binding}
                        label={`${binding.template_id} · v${binding.template_version}`}
                      />
                    </div>
                  ))}
                </section>
              )}
              {table === 'notes' && (
                <details className="note">
                  <summary>Markdown 安全预览</summary>
                  <Markdown skipHtml>{row.body}</Markdown>
                </details>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
function Tree({
  rows,
  kind,
  go,
  selected,
}: {
  rows: any[];
  kind: Target['kind'];
  go: (d: Destination) => void;
  selected?: string;
}) {
  const children = new Map<string | null, any[]>();
  for (const r of rows) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r]);
  const branch = (r: any): React.ReactNode => {
    const nodes = children.get(r.id) ?? [];
    const button = (
      <button
        className={`tree-node ${selected === r.id ? 'selected' : ''}`}
        onClick={() => go({ target: { kind, id: r.id } })}
      >
        <strong>{label(r)}</strong>
        <span>{r.kind ?? (attr(r, 'container')?.can_contain ? 'CONTAINER' : 'ITEM')}</span>
        <code>{r.id}</code>
      </button>
    );
    return (
      <li key={r.id}>
        {nodes.length ? (
          <details open>
            <summary>{button}</summary>
            <ul>{nodes.map(branch)}</ul>
          </details>
        ) : (
          button
        )}
      </li>
    );
  };
  return (
    <ul className="tree">
      {(children.get(null) ?? []).map(branch)}
      {!rows.length && <li>无记录</li>}
    </ul>
  );
}
function Inspector() {
  const cache = useQueryClient();
  const [destination, setDestination] = useState<Destination>({ table: 'households' });
  const [tab, setTab] = useState('core');
  const [filters, setFilters] = useState<any>({});
  const [status, setStatus] = useState('');
  const [date, setDate] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [showList, setShowList] = useState(true);
  const go = (d: Destination) => {
    setDestination(d);
    setTab('core');
    setShowList(false);
  };
  const target = 'target' in destination ? destination.target : undefined;
  const catalogs = useQuery({
    queryKey: ['catalogs'],
    queryFn: () => all('query_catalog_nodes', { include_hidden: true }),
  });
  const items = useQuery({ queryKey: ['items'], queryFn: () => all('query_items') });
  const resultInput = {
    ...filters,
    limit: 10,
    ...(cursor ? { cursor } : {}),
    attribute_filters: [
      ...(status ? [{ template_id: 'lifecycle', path: 'state', op: 'eq', value: status }] : []),
      ...(date ? [{ template_id: 'lifecycle', path: 'expiry.date', op: 'lte', value: date }] : []),
    ],
  };
  const results = useQuery({
    queryKey: ['results', resultInput],
    queryFn: () => api('query_items', resultInput),
    enabled: showList,
  });
  const detailInput =
    target?.kind === 'ITEM' ? { item_id: target.id } : { catalog_node_id: target?.id };
  const operation = target?.kind === 'ITEM' ? 'get_item' : 'get_catalog_node';
  const detail = useQuery({
    queryKey: ['detail', target],
    enabled: !!target,
    queryFn: () => api(operation, detailInput),
  });
  const derived = useQuery({
    queryKey: ['derived', target],
    enabled: !!target && tab === 'derived',
    queryFn: () => api(operation, { ...detailInput, include_path: true }),
  });
  const selectedRow = [...(catalogs.data ?? []), ...(items.data ?? [])].find(
    (o) => o.id === target?.id,
  );
  const title = target
    ? label(selectedRow ?? { id: target.id })
    : titles['table' in destination ? destination.table : ''];
  const objectTables =
    target?.kind === 'ITEM'
      ? ['items', 'attribute_templates', 'notes', 'events', 'operations']
      : ['catalog_nodes', 'attribute_templates', 'events', 'operations', 'barcode_index'];
  return (
    <div className="app">
      <aside>
        <a className="brand" href="/">
          Acornary <small>开发者数据检查器 · 只读</small>
        </a>
        <h2>CatalogNode 目录树</h2>
        <Tree rows={catalogs.data ?? []} kind="CATALOG_NODE" go={go} selected={target?.id} />
        <h2>Item 容纳树</h2>
        <Tree rows={items.data ?? []} kind="ITEM" go={go} selected={target?.id} />
        <h2>固定检查视图</h2>
        <nav>
          {[
            'households',
            'actors',
            'attribute_templates',
            'operations',
            'events',
            'notes',
            'barcode_index',
            'installations',
            'migrations',
          ].map((table) => (
            <button
              key={table}
              className={'table' in destination && destination.table === table ? 'selected' : ''}
              onClick={() => go({ table })}
            >
              {titles[table]} <code>{table}</code>
            </button>
          ))}
        </nav>
        <p className="muted">写入通过 MCP。当前视图每 5 秒、窗口聚焦时刷新。</p>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">LOCAL / READ ONLY</p>
            <h1>{title}</h1>
            {target && <code className="identity">{target.id}</code>}
          </div>
          <button onClick={() => void cache.invalidateQueries()}>刷新数据</button>
        </header>
        {[catalogs, items, detail]
          .filter((q) => q.error)
          .map((q, i) => (
            <p role="alert" key={i}>
              {q.error!.message}
            </p>
          ))}
        <section className="panel">
          <button aria-expanded={showList} onClick={() => setShowList((v) => !v)}>
            物品实例查询 {showList ? '收起' : '展开'}
          </button>
          {showList && (
            <>
              <div className="filters">
                <input
                  aria-label="搜索名称"
                  placeholder="名称"
                  value={filters.name ?? ''}
                  onChange={(e) => {
                    setFilters({ ...filters, name: e.target.value || undefined });
                    setCursor(undefined);
                  }}
                />
                <input
                  aria-label="查询条码"
                  placeholder="条码"
                  value={filters.barcode ?? ''}
                  onChange={(e) => {
                    setFilters({ ...filters, barcode: e.target.value || undefined });
                    setCursor(undefined);
                  }}
                />
                <select
                  aria-label="生命周期过滤"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setCursor(undefined);
                  }}
                >
                  <option value="">全部生命周期</option>
                  {['ACTIVE', 'CONSUMED', 'DISPOSED', 'LOST', 'ARCHIVED'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <label>
                  到期不晚于{' '}
                  <input
                    aria-label="到期日期上限"
                    type="date"
                    value={date}
                    onChange={(e) => {
                      setDate(e.target.value);
                      setCursor(undefined);
                    }}
                  />
                </label>
                <button
                  onClick={() => {
                    setFilters({});
                    setStatus('');
                    setDate('');
                    setCursor(undefined);
                  }}
                >
                  清除过滤
                </button>
              </div>
              {results.error && <p role="alert">{results.error.message}</p>}
              {results.data && (
                <>
                  <p>
                    matching_count: {results.data.matching_count} · current_count:{' '}
                    {results.data.current_count} · unknown_lifecycle_count:{' '}
                    {results.data.unknown_lifecycle_count}
                  </p>
                  <details>
                    <summary>剩余内容量汇总（独立于件数）</summary>
                    <Json value={results.data.content_totals} />
                  </details>
                  <table>
                    <thead>
                      <tr>
                        <th>物品 / 完整 ID</th>
                        <th>lifecycle.state</th>
                        <th>contents.remaining</th>
                        <th>revision</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.data.data.map((o: any) => (
                        <tr key={o.id}>
                          <td>
                            <button onClick={() => go({ target: { kind: 'ITEM', id: o.id } })}>
                              {label(o)}
                            </button>
                            <code className="identity">{o.id}</code>
                          </td>
                          <td>{attr(o, 'lifecycle')?.state ?? '未记录'}</td>
                          <td>
                            {attr(o, 'contents')?.remaining
                              ? JSON.stringify(attr(o, 'contents'))
                              : '未记录'}
                          </td>
                          <td>{o.revision}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button disabled={!cursor} onClick={() => setCursor(undefined)}>
                    回到首页
                  </button>
                  <button
                    disabled={!results.data.next_cursor}
                    onClick={() => setCursor(results.data.next_cursor)}
                  >
                    下一页实例
                  </button>
                </>
              )}
            </>
          )}
        </section>
        {target ? (
          <>
            <div className="actions">
              <button onClick={() => void navigator.clipboard.writeText(target.id)}>
                复制完整 ID
              </button>
              {target.kind === 'CATALOG_NODE' ? (
                <button
                  onClick={() => {
                    setFilters(
                      selectedRow?.kind === 'SKU'
                        ? { catalog_node_ids: [target.id] }
                        : { catalog_subtree_id: target.id },
                    );
                    setCursor(undefined);
                    setShowList(true);
                  }}
                >
                  查看关联物品
                </button>
              ) : (
                <>
                  <button
                    onClick={() => {
                      if (detail.data)
                        go({ target: { kind: 'CATALOG_NODE', id: detail.data.catalog_node_id } });
                    }}
                  >
                    查看商品定义
                  </button>
                  <button
                    onClick={() => {
                      setFilters({ within_item_id: target.id });
                      setCursor(undefined);
                      setShowList(true);
                    }}
                  >
                    查看容器子树
                  </button>
                </>
              )}
            </div>
            <div className="tabs">
              {['core', 'derived', 'api'].map((t) => (
                <button key={t} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>
                  {t === 'core'
                    ? '数据库记录'
                    : t === 'derived'
                      ? '派生结果（非存储）'
                      : 'API 响应'}
                </button>
              ))}
            </div>
            {tab === 'core' &&
              objectTables.map((table) => (
                <Records key={`${target.id}:${table}`} table={table} target={target} go={go} />
              ))}
            {tab === 'derived' && (
              <section className="panel" data-testid="derived">
                <h2>派生结果 · 非数据库列</h2>
                <p>
                  path_ids 由 parent_id 递归计算；商品名称来自关联
                  CatalogNode；提醒由已记录的生命周期日期计算。
                </p>
                {derived.error && <p role="alert">{derived.error.message}</p>}
                {derived.data && (
                  <>
                    <Json
                      value={{
                        path_ids: derived.data.path_ids,
                        ...(target.kind === 'ITEM'
                          ? {
                              catalog_name: derived.data.catalog_name,
                              reminder: derived.data.reminder,
                              calculation_facts: attr(derived.data, 'lifecycle') ?? null,
                            }
                          : {}),
                      }}
                    />
                    {derived.data.path_ids.map((id: string) => (
                      <button
                        className="identity"
                        key={id}
                        onClick={() => {
                          const d = targetFor(id);
                          if (d) go(d);
                        }}
                      >
                        {id}
                      </button>
                    ))}
                  </>
                )}
              </section>
            )}
            {tab === 'api' && (
              <section className="panel" data-testid="api-response">
                <h2>API 响应 · {operation}</h2>
                <p>以下是实际业务查询响应。关联属性和笔记可能由服务拼装；此处不是数据库行快照。</p>
                <Json value={detail.data} />
              </section>
            )}
          </>
        ) : (
          <Records
            key={JSON.stringify(destination)}
            table={'table' in destination ? destination.table : ''}
            filter={Object.fromEntries(Object.entries(destination).filter(([k]) => k !== 'table'))}
            go={go}
          />
        )}
      </main>
    </div>
  );
}
focusManager.setEventListener((handle) => {
  const refresh = () => handle(true);
  window.addEventListener('focus', refresh);
  const visibility = () => handle(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', visibility);
  return () => {
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', visibility);
  };
});
const client = new QueryClient({
  defaultOptions: {
    queries: { refetchInterval: 5000, refetchOnWindowFocus: 'always', retry: false },
  },
});
const rootRoute = createRootRoute({ component: Inspector });
const router = createRouter({ routeTree: rootRoute });
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
