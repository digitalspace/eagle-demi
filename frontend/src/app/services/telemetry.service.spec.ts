import { TestBed } from '@angular/core/testing';
import type { ITelemetryItem } from '@microsoft/applicationinsights-web';
import { TelemetryService, correlationHosts, errorsOnly, type SdkLoader } from './telemetry.service';

const item = (baseType: string, baseData: Record<string, unknown>): ITelemetryItem =>
  ({ name: baseType, baseType, baseData }) as ITelemetryItem;

describe('TelemetryService', () => {
  let service: TelemetryService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TelemetryService] });
    service = TestBed.inject(TelemetryService);
  });

  it('stays off without a connection string', async () => {
    expect(await service.init(undefined, 'eagle-demi-frontend', [])).toBe(false);
    expect(await service.init('', 'eagle-demi-frontend', [])).toBe(false);
  });

  it('resolves false, not rejects, when the SDK chunk fails to load', async () => {
    const load = (() => Promise.reject(new Error('stale chunk'))) as unknown as SdkLoader;
    await expectAsync(service.init('InstrumentationKey=0-0-0-0-0', 'eagle-demi-frontend', [], load))
      .toBeResolvedTo(false);
    expect(() => service.trackException(new Error('after failed init'))).not.toThrow();
  });

  it('trackException before init is held, not thrown away', () => {
    expect(() => service.trackException(new Error('boom'))).not.toThrow();
    expect(() => service.trackException('a string')).not.toThrow();
  });

  it('flushes errors raised before the SDK loaded, newest past 20 dropped', async () => {
    const sent: { exception: Error; properties?: Record<string, string> }[] = [];
    const fake = {
      loadAppInsights: () => undefined,
      addTelemetryInitializer: () => undefined,
      trackException: (telemetry: { exception: Error; properties?: Record<string, string> }) => {
        sent.push(telemetry);
      }
    };
    const load = (() =>
      Promise.resolve({ ApplicationInsights: function () { return fake; } })) as unknown as SdkLoader;

    const early = new Error('early');
    service.trackException(early, { componentStack: 'at MapExplorer' });
    for (let i = 0; i < 25; i++) {
      service.trackException(new Error(`later ${i}`));
    }

    expect(await service.init('InstrumentationKey=0-0-0-0-0', 'eagle-demi-frontend', [], load)).toBe(true);

    expect(sent.length).toBe(20);
    const flushed = sent.filter(telemetry => telemetry.exception === early);
    expect(flushed.length).toBe(1);
    expect(flushed[0].properties).toEqual({ componentStack: 'at MapExplorer' });

    service.trackException(new Error('after init'));
    expect(sent.length).toBe(21);
  });

  it('blocks the SDK config-sync plugin from calling out on init', async () => {
    let capturedConfig: { config?: { extensionConfig?: unknown } } | undefined;
    const fake = { loadAppInsights: () => undefined, addTelemetryInitializer: () => undefined };
    const load = (() =>
      Promise.resolve({
        ApplicationInsights: function (config: { config?: { extensionConfig?: unknown } }) {
          capturedConfig = config;
          return fake;
        }
      })) as unknown as SdkLoader;

    await service.init('InstrumentationKey=0-0-0-0-0', 'eagle-demi-frontend', [], load);

    expect(capturedConfig?.config?.extensionConfig).toEqual({
      AppInsightsCfgSyncPlugin: { cfgUrl: '', blkCdnCfg: true }
    });
  });
});

describe('errorsOnly', () => {
  const keep = errorsOnly('eagle-demi-frontend');

  it('drops a successful dependency and keeps a failed one', () => {
    expect(keep(item('RemoteDependencyData', { uri: '/api/projects', success: true }))).toBe(false);
    expect(keep(item('RemoteDependencyData', { uri: '/api/projects', success: undefined }))).toBe(false);
    expect(keep(item('RemoteDependencyData', { uri: '/api/projects', success: false }))).toBe(true);
  });

  it('keeps exceptions', () => {
    expect(keep(item('ExceptionData', { message: 'boom' }))).toBe(true);
  });

  it('strips query strings from the fields that carry them', () => {
    const failed = item('RemoteDependencyData', {
      success: false,
      uri: 'https://demi.example/api/search?q=x',
      target: 'demi.example?q=x',
      name: 'GET /api/search?q=x',
      message: 'failed /api/search?q=x'
    });
    keep(failed);
    const data = failed.baseData as Record<string, string>;
    expect(data['uri']).toBe('https://demi.example/api/search');
    expect(data['target']).toBe('demi.example');
    expect(data['name']).toBe('GET /api/search');
    expect(data['message']).toBe('failed /api/search');
  });

  it('strips a query value across colons, leaving only prose question marks alone', () => {
    // A query value can hide a colon (an ISO date, a stack line:col) — the whole value must still go.
    const stackFrame = item('ExceptionData', { message: 'x.js?v=1:42:9)' });
    keep(stackFrame);
    expect((stackFrame.baseData as Record<string, string>)['message']).toBe('x.js)');

    const prose = item('ExceptionData', { message: "Unexpected token '?' at line 3" });
    keep(prose);
    expect((prose.baseData as Record<string, string>)['message']).toBe("Unexpected token '?' at line 3");

    const token = item('ExceptionData', { message: '/api/projects?token=SECRET 401' });
    keep(token);
    expect((token.baseData as Record<string, string>)['message']).toBe('/api/projects 401');

    const multi = item('ExceptionData', { message: '/x?a=1&b=2 tail' });
    keep(multi);
    expect((multi.baseData as Record<string, string>)['message']).toBe('/x tail');

    const dated = item('ExceptionData', { message: '/r?date=2026-09-02T10:00:00Z&sig=SECRET 401' });
    keep(dated);
    expect((dated.baseData as Record<string, string>)['message']).toBe('/r 401');
  });

  it('cuts a query string out of an exception, wherever it sits', () => {
    const crash = item('ExceptionData', {
      exceptions: [
        {
          message: 'HTTP GET /api/projects?token=SECRET 401',
          stack: 'Error: HTTP GET /api/projects?token=SECRET 401\n    at x (http://h/app.js?v=1:1:1)',
          parsedStack: [{ fileName: 'http://h/app.js?v=1', assembly: 'app.js?v=1' }]
        }
      ]
    });
    keep(crash);

    const [exception] = (crash.baseData as { exceptions: any[] }).exceptions;
    expect(exception.stack).not.toMatch(/token=SECRET|\?v=1/);
    expect(exception.stack).toMatch(/\/api\/projects/);
    expect(exception.stack).toMatch(/401/);
    expect(exception.message).toBe('HTTP GET /api/projects 401');
    expect(exception.parsedStack[0]).toEqual({ fileName: 'http://h/app.js', assembly: 'app.js' });
  });

  it('tags the cloud role', () => {
    const exception = item('ExceptionData', { message: 'boom' });
    keep(exception);
    expect(exception.tags!['ai.cloud.role']).toBe('eagle-demi-frontend');
  });
});

describe('correlationHosts', () => {
  it('is this host alone for a relative API path', () => {
    expect(correlationHosts('/api')).toEqual([window.location.host]);
    expect(correlationHosts(undefined)).toEqual([window.location.host]);
  });

  it('adds the API host when the path is absolute', () => {
    expect(correlationHosts('https://demi-apim-test.azure-api.net/api'))
      .toEqual([window.location.host, 'demi-apim-test.azure-api.net']);
  });
});
