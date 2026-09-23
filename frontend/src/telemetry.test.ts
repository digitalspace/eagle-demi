import { describe, expect, it } from 'vitest';
import type { ITelemetryItem } from '@microsoft/applicationinsights-web';
import { correlationHosts, errorsOnly } from './telemetry';

/** The SDK hands the initializer one of these; only baseData and tags are read. */
const item = (baseType: string, baseData: Record<string, unknown>): ITelemetryItem =>
  ({ baseType, baseData }) as ITelemetryItem;

const keep = errorsOnly('demi-react');

describe('what leaves the page', () => {
  it('stamps the cloud role', () => {
    const event = item('ExceptionData', {});

    keep(event);

    expect(event.tags?.['ai.cloud.role']).toBe('demi-react');
  });

  it('drops a dependency call that succeeded', () => {
    expect(keep(item('RemoteDependencyData', { success: true }))).toBe(false);
    expect(keep(item('RemoteDependencyData', { success: false }))).toBe(true);
  });
});

describe('scrubbing', () => {
  it('cuts the query string off a URL', () => {
    const event = item('RemoteDependencyData', {
      success: false,
      target: 'https://demi.example.test/api/search?keywords=confidential+site',
    });

    keep(event);

    expect(event.baseData?.['target']).toBe('https://demi.example.test/api/search');
  });

  // An OAuth response arrives in the fragment, not the query: `#code=…&session_state=…`. A frame
  // or message carrying one used to reach Application Insights whole.
  it('cuts an OAuth response off the fragment', () => {
    const event = item('ExceptionData', {
      message: 'failed at https://demi.example.test/workspace#code=abc123&session_state=xyz',
    });

    keep(event);

    expect(event.baseData?.['message']).toBe('failed at https://demi.example.test/workspace');
  });

  it('scrubs a fragment inside a stack frame', () => {
    const event = item('ExceptionData', {
      exceptions: [
        {
          message: 'boom',
          stack: 'at start (https://demi.example.test/main.js#access_token=secret)',
          parsedStack: [{ fileName: 'https://demi.example.test/main.js#id_token=secret' }],
        },
      ],
    });

    keep(event);

    const thrown = (event.baseData?.['exceptions'] as Record<string, unknown>[])[0];
    expect(thrown['stack']).toBe('at start (https://demi.example.test/main.js)');
    expect((thrown['parsedStack'] as Record<string, unknown>[])[0]['fileName']).toBe(
      'https://demi.example.test/main.js',
    );
  });

  // The rule needs `key=` after the marker, so ordinary prose and in-page anchors survive.
  it('leaves a plain anchor and a prose question mark alone', () => {
    const event = item('ExceptionData', {
      message: 'Is the skip link to #main broken?',
    });

    keep(event);

    expect(event.baseData?.['message']).toBe('Is the skip link to #main broken?');
  });
});

describe('correlationHosts', () => {
  it('adds the API host only when the API sits on its own origin', () => {
    expect(correlationHosts('/api')).toEqual([window.location.host]);
    expect(correlationHosts('https://demi-api.example.test/api')).toEqual([
      window.location.host,
      'demi-api.example.test',
    ]);
  });
});
