import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { SERVICE_CATEGORIES } from '../../database/entities/service.entity';

type TestElement = {
  value: string;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  innerHTML: string;
  dataset: Record<string, string>;
  classList: { add: jest.Mock; remove: jest.Mock; toggle: jest.Mock };
  listeners: Map<string, (event: unknown) => unknown>;
  addEventListener: (
    name: string,
    handler: (event: unknown) => unknown,
  ) => void;
};

type FetchReply = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

describe('Service category UI contracts (isolated scripts, no server or database)', () => {
  function page(filename: 'index.html' | 'service.html') {
    const html = readFileSync(
      join(__dirname, '../../../public', filename),
      'utf8',
    );
    const nodes = new Map<string, TestElement>();
    const element = (id: string): TestElement => {
      if (!nodes.has(id)) {
        const listeners = new Map<string, (event: unknown) => unknown>();
        nodes.set(id, {
          value: '',
          disabled: false,
          hidden: false,
          textContent: '',
          innerHTML: '',
          dataset: {},
          classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() },
          listeners,
          addEventListener: (name, handler) => {
            listeners.set(name, handler);
          },
        });
      }
      return nodes.get(id)!;
    };
    const fetch = jest.fn<Promise<FetchReply>, [string, object]>(async () => ({
      ok: true,
      status: 200,
      json: async () => SERVICE_CATEGORIES,
    }));
    const context = createContext({
      document: {
        getElementById: element,
        querySelectorAll: () => [],
        addEventListener: jest.fn(),
      },
      fetch,
      URLSearchParams,
      categories: SERVICE_CATEGORIES,
      ServiceRequestImport: createRequire(__filename)(
        '../../../public/service-request-import.js',
      ),
    });
    // Disable automatic session bootstrap; tests invoke only the owned UI paths.
    for (const [, script] of html.matchAll(
      /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g,
    )) {
      runInContext(
        script.replace('void initializeAdminSession();', ''),
        context,
      );
    }
    const run = <T = unknown>(source: string): T =>
      runInContext(source, context) as T;
    return { html, element, fetch, run };
  }

  it.each(['index.html', 'service.html'] as const)(
    'adds only a stable compact A header logo to %s',
    (filename) => {
      const { html } = page(filename);
      expect(html).toContain(
        '<img src="/brand/auth-logo-128.png" alt="Auth" width="24" height="24" />',
      );
      expect(html).toContain('flex: 0 0 24px');
      expect(html).toContain(
        '<h1>' +
          (filename === 'index.html'
            ? 'Teddy Auth Admin'
            : 'Service Onboarding') +
          '</h1>',
      );
      expect(html).toContain('/api/service-categories');
    },
  );

  it('keeps the other default through early preview initialization and loads the shared catalog', async () => {
    const ui = page('service.html');
    expect(ui.run('state.serviceRequestDraft.category')).toBe('other');
    await ui.run<Promise<void>>('loadServiceCategoryOptions()');
    expect(ui.fetch).toHaveBeenCalledWith(
      '/api/service-categories',
      expect.any(Object),
    );
    expect(ui.element('requestServiceCategory').value).toBe('other');
    expect(ui.element('requestServiceCategory').disabled).toBe(false);
    for (const category of SERVICE_CATEGORIES) {
      expect(ui.element('requestServiceCategory').innerHTML).toContain(
        category.label,
      );
    }
    expect(ui.run('buildServiceRequestPayload().category')).toBe('other');
  });

  it('selects an imported category, includes it in JSON preview and tracks later selection changes', async () => {
    const ui = page('service.html');
    await ui.run<Promise<void>>('loadServiceCategoryOptions()');
    ui.run(
      `state.adminSession = { name: 'Admin', email: 'admin@example.com' }; state.credentialScopeOptions = [{ key: 'account.search' }];`,
    );
    expect(
      await ui.run<Promise<boolean>>(
        `importServiceRequestText('{"serviceKey":"test","name":"Test","category":"game","permissions":[]}', 'pasted JSON', 'paste')`,
      ),
    ).toBe(true);
    expect(ui.element('requestServiceCategory').value).toBe('game');
    expect(
      JSON.parse(ui.element('serviceRequestPreview').textContent),
    ).toMatchObject({ category: 'game' });
    ui.element('requestServiceCategory').value = 'education';
    ui.element('requestServiceCategory').listeners.get('change')!({});
    expect(
      JSON.parse(ui.element('serviceRequestPreview').textContent),
    ).toMatchObject({ category: 'education' });
    expect(
      ui.run('validateServiceRequestPayload(buildServiceRequestPayload())'),
    ).toEqual([]);
    ui.run('resetServiceRequestForm()');
    expect(ui.element('requestServiceCategory').value).toBe('other');
  });

  it('renders only five services per page and preserves the current page and row edits', () => {
    const ui = page('index.html');
    ui.run(
      `state.serviceCategoryOptions = categories; state.services = Array.from({length: 7}, (_, i) => ({ id: 's' + i, serviceKey: 'key' + i, name: 'Name ' + i, category: 'other', status: 'active', permissionSchemaVersion: 1 })); renderServices();`,
    );
    expect(
      ui.element('servicesBody').innerHTML.match(/data-service-category=/g),
    ).toHaveLength(5);
    ui.run(
      `state.listPages.services = 2; state.serviceCategoryEdits.s5 = { value: 'game', saving: false, message: '' }; renderServices();`,
    );
    const rows = ui.element('servicesBody').innerHTML;
    expect(rows.match(/data-service-category=/g)).toHaveLength(2);
    expect(rows).toContain('data-service-category="s5"');
    expect(rows).not.toContain('data-service-category="s0"');
    expect(rows).toContain('value="game" selected');
    expect(ui.run('state.listPages.services')).toBe(2);
  });

  it.each([true, false])(
    'sends category only and restores per-row state after save success=%s',
    async (success) => {
      const ui = page('index.html');
      ui.run(
        `state.serviceCategoryOptions = categories; state.services = [{ id: 's1', serviceKey: 'test', name: 'Test', category: 'other', status: 'active', permissionSchemaVersion: 1 }]; renderServices();`,
      );
      const select = {
        disabled: false,
        dataset: { serviceCategory: 's1' },
        value: 'game',
      };
      ui.element('servicesBody').listeners.get('change')!({
        target: { closest: () => select },
      });
      let resolve!: (reply: FetchReply) => void;
      ui.fetch.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const button = {
        disabled: false,
        dataset: { saveServiceCategory: 's1' },
      };
      const pending = ui.element('servicesBody').listeners.get('click')!({
        target: { closest: () => button },
      });
      expect(ui.element('servicesBody').innerHTML).toContain(
        'aria-busy="true"',
      );
      expect(ui.element('servicesBody').innerHTML).toContain('Saving...');
      expect(ui.fetch).toHaveBeenCalledWith(
        '/api/admin/services/s1',
        expect.objectContaining({
          method: 'PATCH',
          body: '{"category":"game"}',
        }),
      );
      resolve({
        ok: success,
        status: success ? 200 : 503,
        json: async () =>
          success ? { category: 'game' } : { message: 'Unavailable' },
      });
      await pending;
      expect(ui.run('state.serviceCategoryEdits.s1.saving')).toBe(false);
      expect(ui.run('state.services[0].category')).toBe(
        success ? 'game' : 'other',
      );
      expect(ui.element('servicesBody').innerHTML).toContain(
        success ? 'Saved' : 'Unavailable',
      );
      expect(ui.element('servicesBody').innerHTML).not.toContain('Saving...');
    },
  );
});
