import { createBrowserRouter, RouterProvider } from 'react-router';
import { routes } from './routes';
import { SessionProvider } from './session/SessionProvider';
import { useSession } from './session/session';
import { Skeleton } from './shell/Skeleton';
import { SignIn } from './shell/SignIn';

const router = createBrowserRouter(routes);

export function App() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}

function Gate() {
  const { settled, isStaff } = useSession();

  // Keycloak and /me are async; rendering the gate before they settle flashes sign-in at staff.
  if (!settled) return <Skeleton />;
  if (!isStaff) return <SignIn />;
  return <RouterProvider router={router} />;
}
