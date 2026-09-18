import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './styles.css';

import { App } from './App';
import { initConfig } from './config';
import { ErrorBoundary } from './ErrorBoundary';
import { correlationHosts, init as initTelemetry } from './telemetry';

const queryClient = new QueryClient();

async function start() {
  const root = createRoot(document.getElementById('root')!);
  const config = await initConfig();

  // Not awaited: the App Insights chunk must not hold the first render.
  void initTelemetry(
    config.APPINSIGHTS_CONNECTION_STRING,
    'eagle-demi-frontend',
    correlationHosts(config.API_PATH),
  );

  root.render(
    <StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}

void start();
