import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { routes } from './routes';
import { SessionProvider } from './session/SessionProvider';
import { useSession } from './session/session';
import { Skeleton } from './shell/Skeleton';
import { SignIn } from './shell/SignIn';

const router = createBrowserRouter(routes);

// No retry and no refetch on focus: the Angular screens each read once and showed their own error,
// so a silent second attempt would change what a failure looks like — and coming back to the tab
// would paint error states Angular never reaches.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </QueryClientProvider>
  );
}

function Gate() {
  const { settled, isStaff } = useSession();

  // Keycloak and /me are async; rendering the gate before they settle flashes sign-in at staff.
  if (!settled) return <Skeleton />;
  if (!isStaff) return <SignIn />;
  return <RouterProvider router={router} />;
}
