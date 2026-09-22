import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

import { App } from './App';
import { initConfig } from './config';
import { ErrorBoundary } from './ErrorBoundary';
import { correlationHosts, init as initTelemetry } from './telemetry';

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
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

void start();
